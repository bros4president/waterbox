import { createWaterboxApi, type IdentityResolver } from "@waterbox/api"
import type { ApiBackend } from "@waterbox/client"
import { AccountIdSchema } from "@waterbox/contracts"
import { SandboxService, type Clock, type ReadableIdGenerator } from "@waterbox/core"
import type { SandboxProvider } from "@waterbox/core/provider"
import {
  BoxSandboxProvider,
  SystemBoxProviderClock,
  type BoxProviderConfig,
  type BoxProviderDiagnostic,
} from "@waterbox/provider-box"
import {
  SystemVercelProviderClock,
  VercelSandboxProvider,
  type VercelCompositionDiagnostic,
  type VercelProviderConfig,
} from "@waterbox/provider-vercel"
import type { SandboxRuntimeArtifact } from "@waterbox/provider-runtime"
import { loadSandboxRuntimeArtifact } from "@waterbox/provider-runtime"
import { SqliteRepositoryStore } from "@waterbox/repository-sqlite"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { join } from "node:path"

export type LocalProviderDiagnostic = BoxProviderDiagnostic | VercelCompositionDiagnostic
export type { BoxProviderDiagnostic } from "@waterbox/provider-box"
export type { VercelCompositionDiagnostic } from "@waterbox/provider-vercel"

const EMBEDDED_ORIGIN = new URL("http://waterbox.local/")

export type LocalDirectProviderSelection =
  | { kind: "box"; config: BoxProviderConfig }
  | { kind: "vercel"; config: VercelProviderConfig }

export interface LocalConfiguredMcpBackend {
  sqlitePath: string
  provider: LocalDirectProviderSelection
}

/** Safe startup-only validation failure; values are never retained in messages. */
export class LocalProviderConfigurationError extends Error {
  constructor(message = "Waterbox local provider configuration is invalid. Set WATERBOX_PROVIDER explicitly and configure its required credentials using your MCP client's secret or environment mechanism, then restart the client. Do not provide credentials in chat or as tool arguments.") {
    super(message)
    this.name = "LocalProviderConfigurationError"
  }
}

/**
 * Explicit local provider selection. This is the sole environment-to-provider
 * mapping; callers above composition only pass the resulting opaque selection.
 */
export function parseLocalProviderConfiguration(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory = homedir(),
): LocalConfiguredMcpBackend {
  const provider = environment.WATERBOX_PROVIDER
  const sqlitePath = nonEmpty(environment.WATERBOX_SQLITE_PATH) ? environment.WATERBOX_SQLITE_PATH!.trim() : join(homeDirectory, ".waterbox", "direct.sqlite")
  if (!validSqlitePath(sqlitePath)) throw new LocalProviderConfigurationError()
  if (provider === "box") {
    const apiKey = required(environment.BOX_API_KEY, "BOX_API_KEY", "Box")
    const intervalMs = positive(environment.BOX_POLL_INTERVAL_MS, 1_000), timeoutMs = positive(environment.BOX_POLL_TIMEOUT_MS, 120_000)
    const config: BoxProviderConfig = { apiBaseUrl: environment.BOX_API_BASE_URL ?? "https://ascii.dev/api/box/v1", apiKey, polling: { intervalMs, timeoutMs } }
    if (timeoutMs < intervalMs || !boxOrigin(config.apiBaseUrl)) throw new LocalProviderConfigurationError()
    return { sqlitePath, provider: { kind: "box", config } }
  }
  if (provider === "vercel") {
    const token = required(environment.VERCEL_TOKEN, "VERCEL_TOKEN", "Vercel")
    const teamId = required(environment.VERCEL_TEAM_ID, "VERCEL_TEAM_ID", "Vercel")
    const projectId = required(environment.VERCEL_PROJECT_ID, "VERCEL_PROJECT_ID", "Vercel")
    const intervalMs = positive(environment.VERCEL_POLL_INTERVAL_MS, 1_000), timeoutMs = positive(environment.VERCEL_POLL_TIMEOUT_MS, 120_000), requestTimeoutMs = positive(environment.VERCEL_REQUEST_TIMEOUT_MS, 30_000)
    const config: VercelProviderConfig = { apiOrigin: environment.VERCEL_API_ORIGIN ?? "https://api.vercel.com", token, teamId, projectId, polling: { intervalMs, timeoutMs, requestTimeoutMs } }
    if (timeoutMs < intervalMs || requestTimeoutMs > timeoutMs || !vercelOrigin(config.apiOrigin)) throw new LocalProviderConfigurationError()
    return { sqlitePath, provider: { kind: "vercel", config } }
  }
  throw new LocalProviderConfigurationError()
}

export interface LocalControlPlaneConfig {
  sqlitePath: string
  accountId: string
  provider: (LocalDirectProviderSelection & { runtimeArtifact: SandboxRuntimeArtifact })
    | { kind: "injected"; implementation: SandboxProvider }
  diagnostic?: (event: LocalProviderDiagnostic) => void
}

export interface LocalControlPlaneOverrides {
  clock?: Clock
  ids?: ReadableIdGenerator
  /** A test-only seam used to prove ownership when initialization fails after opening SQLite. */
  createStore?: (sqlitePath: string) => SqliteRepositoryStore
}

export interface LocalControlPlane {
  fetch(request: Request): Promise<Response>
  close(): Promise<void>
}

class SystemClock implements Clock {
  now(): Date { return new Date() }
}

class RandomReadableIds implements ReadableIdGenerator {
  static readonly adjectives = ["calm", "silver", "quiet", "bright", "gentle", "swift"]
  static readonly nouns = ["cactus", "forest", "river", "falcon", "harbor", "meadow"]

  sandboxId(): string { return `sbx_${this.#suffix()}` }
  snapshotId(): string { return `snap_${this.#suffix()}` }

  #suffix(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(6))
    const adjective = RandomReadableIds.adjectives[bytes[0]! % RandomReadableIds.adjectives.length]!
    const noun = RandomReadableIds.nouns[bytes[1]! % RandomReadableIds.nouns.length]!
    return `${adjective}-${noun}-${Array.from(bytes.slice(2), value => value.toString(36)).join("")}`
  }
}

export async function createLocalControlPlane(
  config: LocalControlPlaneConfig,
  identityResolver: IdentityResolver,
  overrides: LocalControlPlaneOverrides = {},
): Promise<LocalControlPlane> {
  validateBaseConfiguration(config, identityResolver)

  // Each explicit adapter validates its complete configuration and already-loaded
  // artifact before any filesystem or SQLite side effect. Test providers bypass
  // external configuration only through the explicit injected selection.
  const provider = config.provider.kind === "injected"
    ? config.provider.implementation
    : config.provider.kind === "box" ? new BoxSandboxProvider(config.provider.config, {
        clock: new SystemBoxProviderClock(),
        artifact: config.provider.runtimeArtifact,
        ...(config.diagnostic === undefined ? {} : { diagnostic: config.diagnostic }),
      })
    : new VercelSandboxProvider(config.provider.config, {
        clock: new SystemVercelProviderClock(),
        artifact: config.provider.runtimeArtifact,
        ...(config.diagnostic === undefined ? {} : { diagnostic: config.diagnostic }),
      })
  validateProvider(provider)

  if (config.sqlitePath !== ":memory:") await mkdir(dirname(config.sqlitePath), { recursive: true, mode: 0o700 })

  const store = (overrides.createStore ?? ((sqlitePath: string) => new SqliteRepositoryStore(sqlitePath, { create: true })))(config.sqlitePath)
  let closed = false
  try {
    const core = new SandboxService({
      sandboxes: store.sandboxes,
      snapshots: store.snapshots,
      idempotency: store.idempotency,
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      clock: overrides.clock ?? new SystemClock(),
      ids: overrides.ids ?? new RandomReadableIds(),
    })
    const api = createWaterboxApi({ core, identityResolver })
    return {
      async fetch(request) { return api.fetch(request) },
      async close() {
        if (closed) return
        closed = true
        store.close()
      },
    }
  } catch (error) {
    store.close()
    throw error
  }
}

export async function createEmbeddedApiBackend(
  config: LocalControlPlaneConfig,
  overrides: LocalControlPlaneOverrides = {},
): Promise<ApiBackend> {
  const credential = randomCredential()
  const plane = await createLocalControlPlane(config, privateIdentityResolver(credential, config.accountId), overrides)
  let closed = false
  return {
    get origin() { return new URL(EMBEDDED_ORIGIN) },
    async fetch(request) {
      if (closed) throw new Error("The embedded Waterbox API backend is closed")
      const headers = new Headers(request.headers)
      headers.set("authorization", `Bearer ${credential}`)
      return plane.fetch(new Request(request, { headers }))
    },
    async close() {
      if (closed) return
      closed = true
      await plane.close()
    },
  }
}

/**
 * Caller-owned artifact loading happens only after strict configuration has
 * succeeded and before a provider, SQLite database, or filesystem is touched.
 */
export async function createConfiguredEmbeddedApiBackend(
  configuration: LocalConfiguredMcpBackend,
  artifactLocation: URL,
  diagnostic?: (event: LocalProviderDiagnostic) => void,
): Promise<ApiBackend> {
  validateConfiguredMcpBackend(configuration)
  const artifact = await loadSandboxRuntimeArtifact(artifactLocation, "0.1.0")
  return createEmbeddedApiBackend({ sqlitePath: configuration.sqlitePath, accountId: "local", provider: { ...configuration.provider, runtimeArtifact: artifact }, ...(diagnostic === undefined ? {} : { diagnostic }) })
}

function validateBaseConfiguration(config: LocalControlPlaneConfig, identityResolver: IdentityResolver): void {
  if (!config || typeof config !== "object" || !config.provider || typeof config.provider !== "object"
    || (config.provider.kind !== "box" && config.provider.kind !== "vercel" && config.provider.kind !== "injected")) {
    throw new TypeError("Local control-plane provider selection is invalid")
  }
  if (typeof config.sqlitePath !== "string" || config.sqlitePath.length === 0 || config.sqlitePath.includes("\0")) throw new TypeError("Local control-plane SQLite configuration is invalid")
  if (!AccountIdSchema.safeParse(config.accountId).success) throw new TypeError("Local control-plane account configuration is invalid")
  if (!identityResolver || typeof identityResolver.resolveBearer !== "function") throw new TypeError("Local control-plane identity resolver is invalid")
}

function validateProvider(provider: SandboxProvider): void {
  if (!provider || typeof provider !== "object"
    || typeof provider.name !== "string" || provider.name.length === 0
    || typeof provider.createSandbox !== "function"
    || typeof provider.prepareSandbox !== "function"
    || typeof provider.inspectSandbox !== "function"
    || typeof provider.deleteSandbox !== "function"
    || typeof provider.executeTool !== "function") {
    throw new TypeError("Local control-plane provider is invalid")
  }
}

function privateIdentityResolver(expected: string, accountId: string): IdentityResolver {
  return {
    async resolveBearer(credential, signal) {
      signal.throwIfAborted()
      return constantTimeEqual(credential, expected) ? { accountId } : undefined
    },
  }
}

function randomCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Buffer.from(bytes).toString("base64url")
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  let difference = leftBytes.length ^ rightBytes.length
  const length = Math.max(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index++) {
    difference |= (leftBytes[index % leftBytes.length] ?? 0) ^ (rightBytes[index % rightBytes.length] ?? 0)
  }
  return difference === 0
}

function required(value: string | undefined, variable: string, provider: string): string {
  if (!nonEmpty(value)) throw new LocalProviderConfigurationError(`${variable} is required for the ${provider} provider. Set WATERBOX_PROVIDER explicitly and configure ${variable} using your MCP client's secret or environment mechanism, then restart the client. Do not provide credentials in chat or as tool arguments.`)
  return value.trim()
}
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 16_384 }
function positive(value: string | undefined, fallback: number): number { if (value === undefined) return fallback; if (!/^\d+$/.test(value)) throw new LocalProviderConfigurationError(); const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new LocalProviderConfigurationError(); return parsed }
function validSqlitePath(value: string): boolean { return value.length > 0 && !value.includes("\0") }
function boxOrigin(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash } catch { return false } }
function vercelOrigin(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash } catch { return false } }
function validateConfiguredMcpBackend(value: LocalConfiguredMcpBackend): void {
  if (!value || !validSqlitePath(value.sqlitePath) || !value.provider || typeof value.provider !== "object") throw new LocalProviderConfigurationError()
  if (value.provider.kind === "box") {
    const config = value.provider.config
    if (!config || !nonEmpty(config.apiKey) || !boxOrigin(config.apiBaseUrl) || !positiveNumber(config.polling?.intervalMs) || !positiveNumber(config.polling?.timeoutMs) || config.polling.timeoutMs < config.polling.intervalMs) throw new LocalProviderConfigurationError()
    return
  }
  if (value.provider.kind === "vercel") {
    const config = value.provider.config
    if (!config || !nonEmpty(config.token) || !nonEmpty(config.teamId) || !nonEmpty(config.projectId) || !vercelOrigin(config.apiOrigin) || !positiveNumber(config.polling?.intervalMs) || !positiveNumber(config.polling?.timeoutMs) || !positiveNumber(config.polling?.requestTimeoutMs) || config.polling.timeoutMs < config.polling.intervalMs || config.polling.requestTimeoutMs > config.polling.timeoutMs) throw new LocalProviderConfigurationError()
    return
  }
  throw new LocalProviderConfigurationError()
}
function positiveNumber(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 }
