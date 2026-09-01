import { WaterboxClient } from "@waterbox/client"
import { createEmbeddedApiBackend, type BoxProviderDiagnostic } from "@waterbox/control-plane-local"
import { loadSandboxRuntimeArtifact } from "@waterbox/provider-box"
import type { BoxMcpConfig, WaterboxMcpConfig } from "./config.ts"

export type { BoxProviderDiagnostic } from "@waterbox/control-plane-local"

export class UnsupportedMcpProviderError extends Error {
  constructor() {
    super('Waterbox MCP provider "waterbox" is not supported yet. Set WATERBOX_PROVIDER=box and configure BOX_API_KEY using your MCP client\'s recommended secret or environment mechanism, then restart the client. Do not provide credentials in chat or as tool arguments.')
    this.name = "UnsupportedMcpProviderError"
  }
}

export async function createMcpClient(config: WaterboxMcpConfig, diagnostic?: (event: BoxProviderDiagnostic) => void): Promise<WaterboxClient> {
  if (config.provider.type === "waterbox") throw new UnsupportedMcpProviderError()
  return createLocalMcpClient(config as BoxMcpConfig, diagnostic)
}

export async function createLocalMcpClient(config: BoxMcpConfig, diagnostic?: (event: BoxProviderDiagnostic) => void): Promise<WaterboxClient> {
  // The CLI is deliberately resolved relative to this module so the same lookup
  // works in the packed bundle without relying on the source tree or cwd.
  const artifact = await loadSandboxRuntimeArtifact(new URL("../dist/waterbox-cli.js", import.meta.url), "0.1.0")
  const backend = await createEmbeddedApiBackend({
    sqlitePath: config.sqlitePath,
    accountId: "local",
    provider: { kind: "box", config: config.provider.config, runtimeArtifact: artifact },
    ...(diagnostic === undefined ? {} : { diagnostic }),
  })
  return new WaterboxClient(backend)
}
