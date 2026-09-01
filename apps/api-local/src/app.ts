import { createWaterboxApi, type IdentityResolver } from "@waterbox/api"
import { SandboxService, type Clock, type ReadableIdGenerator } from "@waterbox/core"
import type { SandboxProvider } from "@waterbox/core/provider"
import { BoxSandboxProvider, SystemBoxProviderClock, type SandboxRuntimeArtifact } from "@waterbox/provider-box"
import { SqliteRepositoryStore } from "@waterbox/repository-sqlite"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { LocalApiConfig } from "./config.ts"

export interface LocalApiOverrides {
  provider?: SandboxProvider
  artifact?: SandboxRuntimeArtifact
  clock?: Clock
  ids?: ReadableIdGenerator
}

export interface LocalControlPlane {
  fetch(request: Request): Promise<Response>
  close(): void
}

class SystemClock implements Clock { now(): Date { return new Date() } }

class RandomReadableIds implements ReadableIdGenerator {
  static readonly adjectives = ["calm", "silver", "quiet", "bright", "gentle", "swift"]
  static readonly nouns = ["cactus", "forest", "river", "falcon", "harbor", "meadow"]
  sandboxId() { return `sbx_${this.#suffix()}` }
  snapshotId() { return `snap_${this.#suffix()}` }
  #suffix() {
    const bytes = crypto.getRandomValues(new Uint8Array(6))
    const adjective = RandomReadableIds.adjectives[bytes[0]! % RandomReadableIds.adjectives.length]!
    const noun = RandomReadableIds.nouns[bytes[1]! % RandomReadableIds.nouns.length]!
    return `${adjective}-${noun}-${Array.from(bytes.slice(2), (value) => value.toString(36)).join("")}`
  }
}

export function fixedDevelopmentIdentityResolver(apiKey: string, accountId: string): IdentityResolver {
  return {
    async resolveBearer(credential, signal) {
      signal.throwIfAborted()
      return timingSafeEqual(credential, apiKey) ? { accountId } : undefined
    },
  }
}

export function createLocalControlPlane(config: LocalApiConfig, overrides: LocalApiOverrides = {}): LocalControlPlane {
  const store = new SqliteRepositoryStore(config.sqlitePath, { create: true })
  try {
    const provider = overrides.provider ?? new BoxSandboxProvider(config.box, { clock: new SystemBoxProviderClock(), artifact: overrides.artifact ?? localRuntimeArtifact() })
    const core = new SandboxService({
      sandboxes: store.sandboxes,
      snapshots: store.snapshots,
      idempotency: store.idempotency,
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      clock: overrides.clock ?? new SystemClock(),
      ids: overrides.ids ?? new RandomReadableIds(),
    })
    const api = createWaterboxApi({ core, identityResolver: fixedDevelopmentIdentityResolver(config.developmentApiKey, config.accountId) })
    return { fetch: async (request) => api.fetch(request), close: () => store.close() }
  } catch (error) {
    store.close()
    throw error
  }
}

export function localRuntimeArtifact(dependencies: { read(url: URL): Uint8Array } = {
  read: url => readFileSync(url),
}): SandboxRuntimeArtifact {
  const artifactUrl = new URL("../../../packages/mcp/dist/waterbox-cli.js", import.meta.url)
  let bytes: Uint8Array
  try { bytes = dependencies.read(artifactUrl) }
  catch { throw new Error("Waterbox local runtime artifact is unavailable") }
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), cliProtocolVersion: 2, artifactVersion: "0.1.0" }
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  let difference = leftBytes.length ^ rightBytes.length
  const length = Math.max(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index++) difference |= (leftBytes[index % leftBytes.length] ?? 0) ^ (rightBytes[index % rightBytes.length] ?? 0)
  return difference === 0
}
