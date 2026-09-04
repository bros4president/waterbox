import { createRemoteApiBackend, WaterboxClient } from "@waterbox/client"
import { createConfiguredEmbeddedApiBackend, type LocalProviderDiagnostic } from "@waterbox/control-plane-local"
import type { LocalMcpConfig, WaterboxCloudMcpConfig, WaterboxMcpConfig } from "./config.ts"

export type { LocalProviderDiagnostic } from "@waterbox/control-plane-local"

export async function createMcpClient(config: WaterboxMcpConfig, diagnostic?: (event: LocalProviderDiagnostic) => void): Promise<WaterboxClient> {
  if (config.provider.type === "local") return createLocalMcpClient(config as LocalMcpConfig, diagnostic)
  return createWaterboxCloudMcpClient(config as WaterboxCloudMcpConfig)
}

export async function createLocalMcpClient(config: LocalMcpConfig, diagnostic?: (event: LocalProviderDiagnostic) => void): Promise<WaterboxClient> {
  const backend = await createConfiguredEmbeddedApiBackend(config.provider.configuration, new URL("../dist/waterbox-cli.js", import.meta.url), diagnostic)
  return new WaterboxClient(backend)
}

export function createWaterboxCloudMcpClient(config: WaterboxCloudMcpConfig, fetcher: (request: Request) => Promise<Response> = globalThis.fetch): WaterboxClient {
  const backend = createRemoteApiBackend(config.provider.apiUrl, request => {
    const headers = new Headers(request.headers)
    headers.set("Authorization", `Bearer ${config.provider.apiKey}`)
    return fetcher(new Request(request, { headers }))
  })
  return new WaterboxClient(backend)
}
