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
  type SandboxRuntimeArtifact,
} from "@waterbox/provider-box"
import { SqliteRepositoryStore } from "@waterbox/repository-sqlite"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

export type { BoxProviderDiagnostic } from "@waterbox/provider-box"

const EMBEDDED_ORIGIN = new URL("http://waterbox.local/")

export interface LocalControlPlaneConfig {
  sqlitePath: string
  accountId: string
  provider:
    | { kind: "box"; config: BoxProviderConfig; runtimeArtifact: SandboxRuntimeArtifact }
    | { kind: "injected"; implementation: SandboxProvider }
  diagnostic?: (event: BoxProviderDiagnostic) => void
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

  // Box validates its complete configuration and already-loaded artifact before any
  // filesystem or SQLite side effect. Test providers intentionally bypass Box.
  const provider = config.provider.kind === "injected"
    ? config.provider.implementation
    : new BoxSandboxProvider(config.provider.config, {
        clock: new SystemBoxProviderClock(),
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

function validateBaseConfiguration(config: LocalControlPlaneConfig, identityResolver: IdentityResolver): void {
  if (!config || typeof config !== "object" || !config.provider || typeof config.provider !== "object"
    || (config.provider.kind !== "box" && config.provider.kind !== "injected")) {
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
