import { LocalProviderConfigurationError, parseLocalProviderConfiguration, providerCredential, type LocalConfiguredMcpBackend } from "@waterbox/control-plane-local"
import { configStorage, defaultCredentialStore, OnboardingError, resolvedEnvironment, type ConfigStorage, type CredentialStore } from "./onboarding.ts"

export interface LocalMcpConfig {
  provider: { type: "local"; configuration: LocalConfiguredMcpBackend }
}
export interface WaterboxCloudMcpConfig { provider: { type: "waterbox"; apiKey: string } }
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
  try {
    const resolved = await resolvedEnvironment(environment, dependencies.storage ?? configStorage(homeDirectory), dependencies.credentials ?? defaultCredentialStore(homeDirectory))
    if (resolved.provider === "waterbox") {
      try { return { provider: { type: "waterbox", apiKey: providerCredential(resolved.environment.WATERBOX_API_KEY) } } }
      catch { throw new OnboardingError("Waterbox API key is missing or invalid. Set WATERBOX_PROVIDER=waterbox and WATERBOX_API_KEY using your MCP client's secret mechanism, then restart the MCP client.") }
    }
    return { provider: { type: "local", configuration: parseLocalProviderConfiguration(resolved.environment, homeDirectory) } }
  } catch (error) {
    if (error instanceof LocalProviderConfigurationError || error instanceof OnboardingError) throw new McpConfigurationError(error.message)
    throw error
  }
}
