import { LocalProviderConfigurationError, parseLocalProviderConfiguration, type LocalConfiguredMcpBackend } from "@waterbox/control-plane-local"
import { configStorage, nativeCredentialStore, OnboardingError, resolvedEnvironment, type ConfigStorage, type CredentialStore } from "./onboarding.ts"

export interface LocalMcpConfig {
  provider: { type: "local"; configuration: LocalConfiguredMcpBackend }
}
export interface WaterboxCloudMcpConfig { provider: { type: "waterbox"; apiUrl: string; apiKey: string } }
export type WaterboxMcpConfig = LocalMcpConfig | WaterboxCloudMcpConfig

export class McpConfigurationError extends Error {
  constructor(message = "Waterbox MCP configuration is invalid. Set WATERBOX_PROVIDER explicitly and configure the selected provider using your MCP client's recommended secret or environment mechanism, then restart the client. Do not provide credentials in chat or as tool arguments.") {
    super(message)
    this.name = "McpConfigurationError"
  }
}

/**
 * MCP deliberately treats direct providers as an opaque local composition.
 * Environment parsing and provider selection stay below this API/client layer.
 */
export async function parseMcpConfig(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory?: string,
  dependencies: { storage?: ConfigStorage; credentials?: CredentialStore } = {},
): Promise<WaterboxMcpConfig> {
  if (environment.WATERBOX_PROVIDER === "waterbox") return { provider: parseWaterboxCloudConfiguration(environment) }
  try {
    const resolved = await resolvedEnvironment(environment, dependencies.storage ?? configStorage(homeDirectory), dependencies.credentials ?? nativeCredentialStore())
    return { provider: { type: "local", configuration: parseLocalProviderConfiguration(resolved.environment, homeDirectory) } }
  } catch (error) {
    if (error instanceof LocalProviderConfigurationError || error instanceof OnboardingError) throw new McpConfigurationError(error.message)
    throw error
  }
}

function parseWaterboxCloudConfiguration(environment: Record<string, string | undefined>): WaterboxCloudMcpConfig["provider"] {
  const apiUrl = environment.WATERBOX_API_URL
  const apiKey = environment.WATERBOX_API_KEY
  try {
    if (typeof apiUrl !== "string" || apiUrl.length > 16_384) throw new TypeError()
    const parsed = new URL(apiUrl)
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new TypeError()
    if (typeof apiKey !== "string" || apiKey.length > 16_384 || !/^[^\s]+$/.test(apiKey)) throw new TypeError()
    return { type: "waterbox", apiUrl: parsed.toString(), apiKey }
  } catch {
    throw new McpConfigurationError("Waterbox Cloud configuration is invalid. Set WATERBOX_PROVIDER=waterbox, WATERBOX_API_URL to an absolute root HTTP(S) URL, and WATERBOX_API_KEY through the MCP client's environment or secret mechanism. Do not provide credentials in chat or tool arguments.")
  }
}
