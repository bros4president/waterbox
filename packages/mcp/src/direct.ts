import type { Identity } from "@waterbox/contracts"
import { SandboxService, type Clock, type ReadableIdGenerator } from "@waterbox/core"
import type { SandboxProvider } from "@waterbox/core/provider"
import { BoxSandboxProvider, SystemBoxProviderClock } from "@waterbox/provider-box"
import { SqliteRepositoryStore } from "@waterbox/repository-sqlite"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { McpBackend } from "./backend.ts"
import type { BoxMcpConfig, WaterboxMcpConfig } from "./config.ts"

const LOCAL_IDENTITY: Identity = { accountId: "local" }

export interface DirectBackendOverrides {
  provider?: SandboxProvider
  clock?: Clock
  ids?: ReadableIdGenerator
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
    return `${adjective}-${noun}-${Array.from(bytes.slice(2), (value) => value.toString(36)).join("")}`
  }
}

export class UnsupportedMcpProviderError extends Error {
  constructor() {
    super('Waterbox MCP provider "waterbox" is not supported yet. Set WATERBOX_PROVIDER=box and configure BOX_API_KEY using your MCP client\'s recommended secret or environment mechanism, then restart the client. Do not provide credentials in chat or as tool arguments.')
    this.name = "UnsupportedMcpProviderError"
  }
}

export async function createMcpBackend(
  config: WaterboxMcpConfig,
  overrides: DirectBackendOverrides = {},
): Promise<McpBackend> {
  if (config.provider.type === "waterbox") throw new UnsupportedMcpProviderError()
  return createDirectBackend(config as BoxMcpConfig, overrides)
}

export async function createDirectBackend(
  config: BoxMcpConfig,
  overrides: DirectBackendOverrides = {},
): Promise<McpBackend> {
  if (config.sqlitePath !== ":memory:") await mkdir(dirname(config.sqlitePath), { recursive: true, mode: 0o700 })
  const store = new SqliteRepositoryStore(config.sqlitePath, { create: true })
  try {
    const provider = overrides.provider ?? new BoxSandboxProvider(config.provider.config, {
      clock: new SystemBoxProviderClock(),
      ...(process.env.WATERBOX_MCP_DIAGNOSTICS === "1"
        ? { diagnostic: (event) => console.error(`Waterbox Box diagnostic: ${JSON.stringify(event)}`) }
        : {}),
    })
    const core = new SandboxService({
      sandboxes: store.sandboxes,
      snapshots: store.snapshots,
      idempotency: store.idempotency,
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      clock: overrides.clock ?? new SystemClock(),
      ids: overrides.ids ?? new RandomReadableIds(),
    })
    let closed = false
    return {
      createSandbox: (request, idempotencyKey, signal) => core.createSandbox(LOCAL_IDENTITY, request, { idempotencyKey, signal }),
      probeSandbox: (sandboxId, signal) => core.probeSandbox(LOCAL_IDENTITY, sandboxId, signal),
      deleteSandbox: (sandboxId, signal) => core.deleteSandbox(LOCAL_IDENTITY, sandboxId, signal),
      listSnapshots: (request, signal) => core.listSnapshots(LOCAL_IDENTITY, request, signal),
      createSnapshot: (sandboxId, request, signal) => core.createSnapshot(LOCAL_IDENTITY, sandboxId, request, signal),
      deleteSnapshot: (snapshotId, signal) => core.deleteSnapshot(LOCAL_IDENTITY, snapshotId, signal),
      initiateSecureFileTransfer: (sandboxId, signal) => core.initiateSecureFileTransfer(LOCAL_IDENTITY, sandboxId, signal),
      consumeSecureFileTransfer: (sandboxId, transferId, request, signal) => core.consumeSecureFileTransfer(LOCAL_IDENTITY, sandboxId, transferId, request, signal),
      executeTool: (sandboxId, toolName, arguments_, signal) => core.executeTool(LOCAL_IDENTITY, sandboxId, toolName, arguments_, signal),
      observeBashJob: (sandboxId, jobId, offset, maxBytes, signal) => core.observeBashJob(LOCAL_IDENTITY, sandboxId, jobId, offset, maxBytes, signal),
      cleanupBashJob: (sandboxId, jobId, signal) => core.cleanupBashJob(LOCAL_IDENTITY, sandboxId, jobId, signal),
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
