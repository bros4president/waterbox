import { WaterboxClient } from "@waterbox/client"
import { createConfiguredEmbeddedApiBackend, type LocalProviderDiagnostic } from "@waterbox/control-plane-local"
import type { LocalMcpConfig, WaterboxMcpConfig } from "./config.ts"

export type { LocalProviderDiagnostic } from "@waterbox/control-plane-local"

export class UnsupportedMcpProviderError extends Error {
  constructor() {
    super('Waterbox MCP provider "waterbox" is not supported yet. Set WATERBOX_PROVIDER to an explicit local provider and configure its credentials using your MCP client\'s recommended secret or environment mechanism, then restart the client. Do not provide credentials in chat or as tool arguments.')
    this.name = "UnsupportedMcpProviderError"
  }
}

export async function createMcpClient(config: WaterboxMcpConfig, diagnostic?: (event: LocalProviderDiagnostic) => void): Promise<WaterboxClient> {
  if (config.provider.type === "local") return createLocalMcpClient(config as LocalMcpConfig, diagnostic)
  throw new UnsupportedMcpProviderError()
}

export async function createLocalMcpClient(config: LocalMcpConfig, diagnostic?: (event: LocalProviderDiagnostic) => void): Promise<WaterboxClient> {
  const backend = await createConfiguredEmbeddedApiBackend(config.provider.configuration, new URL("../dist/waterbox-cli.js", import.meta.url), diagnostic)
  return new WaterboxClient(backend)
}
