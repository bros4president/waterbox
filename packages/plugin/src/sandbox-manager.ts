import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms"
import { fromIni } from "@aws-sdk/credential-providers"

export const RECEIVER_PORT = 8080
export const TOKEN_MINUTES = 30
export const DEFAULT_IDLE_SECONDS = 300
export const DEFAULT_SUSPENDED_SECONDS = 3_600
export const DEFAULT_MAX_DURATION_SECONDS = 28_800

export type PluginOptions = {
  profile?: string
  region?: string
  imageIdentifier?: string
  idleSeconds?: number
  suspendedSeconds?: number
  maxDurationSeconds?: number
}

export type ResolvedPluginOptions = {
  profile: string
  region: string
  imageIdentifier: string
  idleSeconds: number
  suspendedSeconds: number
  maxDurationSeconds: number
}

export type ControlPlaneClient = {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<any>
}

export type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

type Sandbox = {
  id: string
  endpoint: string
}

type Token = {
  headers: Record<string, string>
  expiresAt: number
}

class SandboxAbsentError extends Error {}

export type SandboxManagerDependencies = {
  client?: ControlPlaneClient
  fetch?: Fetch
  now?: () => number
  readinessTimeoutMs?: number
  readinessPollMs?: number
}

export function resolveOptions(options: PluginOptions = {}): ResolvedPluginOptions {
  const imageIdentifier = options.imageIdentifier ?? process.env.OC_REMOTE_IMAGE
  if (!imageIdentifier) {
    throw new Error("oc-remote requires imageIdentifier or OC_REMOTE_IMAGE")
  }

  return {
    profile: options.profile ?? "playground",
    region: options.region ?? "us-east-1",
    imageIdentifier,
    idleSeconds: positiveInteger(options.idleSeconds, DEFAULT_IDLE_SECONDS, "idleSeconds"),
    suspendedSeconds: positiveInteger(
      options.suspendedSeconds,
      DEFAULT_SUSPENDED_SECONDS,
      "suspendedSeconds",
    ),
    maxDurationSeconds: positiveInteger(
      options.maxDurationSeconds,
      DEFAULT_MAX_DURATION_SECONDS,
      "maxDurationSeconds",
    ),
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return resolved
}

export function connectorArn(region: string, connector: "ALL_INGRESS" | "INTERNET_EGRESS"): string {
  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:${connector}`
}

export function receiverUrl(endpoint: string, path: string): string {
  const url = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`)
  url.protocol = "https:"
  url.port = ""
  url.pathname = path.startsWith("/") ? path : `/${path}`
  url.search = ""
  return url.toString()
}

export function isResourceNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as { name?: string; Code?: string; code?: string }
  return (
    candidate.name === "ResourceNotFoundException" ||
    candidate.Code === "ResourceNotFoundException" ||
    candidate.code === "ResourceNotFoundException"
  )
}

export class SandboxManager {
  readonly options: ResolvedPluginOptions
  private readonly client: ControlPlaneClient
  private readonly fetch: Fetch
  private readonly now: () => number
  private readonly readinessTimeoutMs: number
  private readonly readinessPollMs: number
  private sandbox?: Sandbox
  private token?: Token
  private creation?: Promise<Sandbox>
  private tokenCreation?: Promise<Token>

  constructor(options: PluginOptions, dependencies: SandboxManagerDependencies = {}) {
    this.options = resolveOptions(options)
    this.client =
      dependencies.client ??
      (new LambdaMicrovmsClient({
        region: this.options.region,
        credentials: fromIni({ profile: this.options.profile }),
      }) as ControlPlaneClient)
    this.fetch = dependencies.fetch ?? globalThis.fetch
    this.now = dependencies.now ?? Date.now
    this.readinessTimeoutMs = dependencies.readinessTimeoutMs ?? 120_000
    this.readinessPollMs = dependencies.readinessPollMs ?? 500
  }

  async request(path: string, init: RequestInit, abort: AbortSignal): Promise<Response> {
    let sandbox = await this.ensureSandbox(abort)
    let response = await this.fetchWithTokenRefresh(sandbox, path, init, abort)

    if (response.status !== 502 || !(await this.isDefinitelyAbsent(sandbox.id, abort))) {
      return response
    }

    await response.body?.cancel()
    this.invalidate(sandbox.id)
    sandbox = await this.ensureSandbox(abort)
    return this.fetchWithTokenRefresh(sandbox, path, init, abort)
  }

  async ensureSandbox(abort: AbortSignal): Promise<Sandbox> {
    if (this.sandbox) return this.sandbox
    if (!this.creation) {
      this.creation = this.createSandbox(abort).finally(() => {
        this.creation = undefined
      })
    }
    return awaitWithAbort(this.creation, abort)
  }

  async probeState(id: string, abort: AbortSignal): Promise<string | undefined> {
    try {
      const result = await this.client.send(
        new GetMicrovmCommand({ microvmIdentifier: id }),
        { abortSignal: abort },
      )
      return result.state
    } catch (error) {
      if (isResourceNotFound(error)) return undefined
      throw error
    }
  }

  private async createSandbox(abort: AbortSignal): Promise<Sandbox> {
    const region = this.options.region
    const result = await this.client.send(
      new RunMicrovmCommand({
        imageIdentifier: this.options.imageIdentifier,
        ingressNetworkConnectors: [connectorArn(region, "ALL_INGRESS")],
        egressNetworkConnectors: [connectorArn(region, "INTERNET_EGRESS")],
        idlePolicy: {
          maxIdleDurationSeconds: this.options.idleSeconds,
          suspendedDurationSeconds: this.options.suspendedSeconds,
          autoResumeEnabled: true,
        },
        maximumDurationInSeconds: this.options.maxDurationSeconds,
      }),
      { abortSignal: abort },
    )
    if (!result.microvmId || !result.endpoint) {
      throw new Error("RunMicrovm returned no microvmId or endpoint")
    }

    const sandbox = { id: result.microvmId as string, endpoint: result.endpoint as string }
    this.sandbox = sandbox
    this.token = undefined
    try {
      await this.waitUntilReady(sandbox, abort)
      return sandbox
    } catch (error) {
      this.invalidate(sandbox.id)
      throw error
    }
  }

  private async waitUntilReady(sandbox: Sandbox, abort: AbortSignal): Promise<void> {
    const deadline = this.now() + this.readinessTimeoutMs
    let lastError: unknown
    while (this.now() < deadline) {
      try {
        const response = await this.fetchWithTokenRefresh(
          sandbox,
          "/health",
          { method: "GET" },
          abort,
        )
        if (response.ok) return
        if (response.status === 502 && (await this.isDefinitelyAbsent(sandbox.id, abort))) {
          throw new SandboxAbsentError(`MicroVM ${sandbox.id} terminated while starting`)
        }
        lastError = new Error(`health endpoint returned ${response.status}`)
      } catch (error) {
        if (abort.aborted) throw abort.reason
        if (error instanceof SandboxAbsentError) throw error
        lastError = error
      }
      await sleep(this.readinessPollMs, abort)
    }
    throw new Error("Timed out waiting for the receiver health endpoint", { cause: lastError })
  }

  private async authorizedFetch(
    sandbox: Sandbox,
    path: string,
    init: RequestInit,
    abort: AbortSignal,
  ): Promise<Response> {
    const token = await this.getToken(sandbox.id, abort)
    const headers = new Headers(init.headers)
    for (const [key, value] of Object.entries(token.headers)) headers.set(key, value)
    headers.set("X-aws-proxy-port", String(RECEIVER_PORT))
    return this.fetch(receiverUrl(sandbox.endpoint, path), { ...init, headers, signal: abort })
  }

  private async fetchWithTokenRefresh(
    sandbox: Sandbox,
    path: string,
    init: RequestInit,
    abort: AbortSignal,
  ): Promise<Response> {
    let response = await this.authorizedFetch(sandbox, path, init, abort)
    if (response.status !== 403) return response
    await response.body?.cancel()
    this.token = undefined
    return this.authorizedFetch(sandbox, path, init, abort)
  }

  private async getToken(id: string, abort: AbortSignal): Promise<Token> {
    if (this.token && this.token.expiresAt - this.now() > 120_000) return this.token
    if (!this.tokenCreation) {
      this.tokenCreation = this.createToken(id, abort).finally(() => {
        this.tokenCreation = undefined
      })
    }
    return awaitWithAbort(this.tokenCreation, abort)
  }

  private async createToken(id: string, abort: AbortSignal): Promise<Token> {
    const result = await this.client.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: id,
        expirationInMinutes: TOKEN_MINUTES,
        allowedPorts: [{ port: RECEIVER_PORT }],
      }),
      { abortSignal: abort },
    )
    if (!result.authToken || Object.keys(result.authToken).length === 0) {
      throw new Error("CreateMicrovmAuthToken returned no token")
    }
    const token = {
      headers: result.authToken as Record<string, string>,
      expiresAt: this.now() + TOKEN_MINUTES * 60_000,
    }
    this.token = token
    return token
  }

  private async isDefinitelyAbsent(id: string, abort: AbortSignal): Promise<boolean> {
    const state = await this.probeState(id, abort)
    return state === undefined || state === "TERMINATED" || state === "TERMINATING"
  }

  private invalidate(id: string): void {
    if (this.sandbox?.id !== id) return
    this.sandbox = undefined
    this.token = undefined
    this.tokenCreation = undefined
  }
}

async function sleep(milliseconds: number, abort: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (abort.aborted) return reject(abort.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abort.reason)
    }
    const timer = setTimeout(() => {
      abort.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    abort.addEventListener("abort", onAbort, { once: true })
  })
}

async function awaitWithAbort<T>(promise: Promise<T>, abort: AbortSignal): Promise<T> {
  if (abort.aborted) throw abort.reason
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abort.reason)
    abort.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        abort.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        abort.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}
