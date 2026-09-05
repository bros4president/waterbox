import type { IdentityResolver } from "@waterbox/api"
import { createLocalControlPlane, deriveProviderConfigurationId, type LocalControlPlane, type LocalControlPlaneOverrides } from "@waterbox/control-plane-local"
import { loadSandboxRuntimeArtifact, type SandboxRuntimeArtifact } from "@waterbox/provider-box"
import type { LocalApiConfig } from "./config.ts"

const DEVELOPMENT_ARTIFACT_VERSION = "0.1.0-alpha.3"

export function fixedDevelopmentIdentityResolver(apiKey: string, accountId: string): IdentityResolver {
  return {
    async resolveBearer(credential, signal) {
      signal.throwIfAborted()
      return constantTimeEqual(credential, apiKey) ? { accountId } : undefined
    },
  }
}

export function createDevelopmentControlPlane(config: LocalApiConfig, runtimeArtifact: SandboxRuntimeArtifact, overrides: LocalControlPlaneOverrides = {}): Promise<LocalControlPlane> {
  return createLocalControlPlane({
    sqlitePath: config.sqlitePath,
    accountId: config.accountId,
    provider: { kind: "box", config: config.box, providerConfigurationId: deriveProviderConfigurationId({ kind: "box", config: config.box }), runtimeArtifact },
  }, fixedDevelopmentIdentityResolver(config.developmentApiKey, config.accountId), overrides)
}

export function loadDevelopmentRuntimeArtifact(dependencies: { load(url: URL, artifactVersion: string): Promise<SandboxRuntimeArtifact> } = {
  load: loadSandboxRuntimeArtifact,
}): Promise<SandboxRuntimeArtifact> {
  return dependencies.load(new URL("../../../packages/sandbox-cli/dist/waterbox-cli.js", import.meta.url), DEVELOPMENT_ARTIFACT_VERSION)
    .catch(() => { throw new Error("Waterbox local runtime artifact is unavailable") })
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
