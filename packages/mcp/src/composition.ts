import { createRemoteApiBackend, WaterboxClient } from "@waterbox/client"
import { createConfiguredEmbeddedApiBackend, type LocalProviderDiagnostic } from "@waterbox/control-plane-local"
import { WATERBOX_API_ORIGIN } from "./onboarding.ts"
import type { LocalMcpConfig, WaterboxCloudMcpConfig, WaterboxMcpConfig } from "./config.ts"

export type { LocalProviderDiagnostic } from "@waterbox/control-plane-local"

export async function createMcpClient(config: WaterboxMcpConfig, diagnostic?: (event: LocalProviderDiagnostic) => void): Promise<WaterboxClient> {
  if (config.provider.type === "waterbox") return createHostedMcpClient(config as WaterboxCloudMcpConfig)
  return createLocalMcpClient(config as LocalMcpConfig, diagnostic)
}

export async function createLocalMcpClient(config: LocalMcpConfig, diagnostic?: (event: LocalProviderDiagnostic) => void): Promise<WaterboxClient> {
  const backend = await createConfiguredEmbeddedApiBackend(config.provider.configuration, new URL("../dist/waterbox-cli.js", import.meta.url), diagnostic)
  return new WaterboxClient(backend)
}

export function createHostedMcpClient(config: WaterboxCloudMcpConfig, fetch_: (request: Request) => Promise<Response> = request => globalThis.fetch(request)): WaterboxClient {
  const backend = createRemoteApiBackend(WATERBOX_API_ORIGIN, request => {
    const headers = new Headers(request.headers)
    headers.set("Authorization", `Bearer ${config.provider.apiKey}`)
    return fetch_(new Request(request, { headers, redirect: "manual" }))
  })
  return new WaterboxClient(backend)
}
