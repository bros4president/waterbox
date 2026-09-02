import { LocalProviderConfigurationError, parseLocalProviderConfiguration, type LocalConfiguredMcpBackend } from "@waterbox/control-plane-local"
import { configStorage, nativeCredentialStore, OnboardingError, resolvedEnvironment, type ConfigStorage, type CredentialStore } from "./onboarding.ts"

export interface LocalMcpConfig {
  provider: { type: "local"; configuration: LocalConfiguredMcpBackend }
}
export interface WaterboxCloudMcpConfig { provider: { type: "waterbox" } }
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
  if (environment.WATERBOX_PROVIDER === "waterbox") return { provider: { type: "waterbox" } }
  try {
    const resolved = await resolvedEnvironment(environment, dependencies.storage ?? configStorage(homeDirectory), dependencies.credentials ?? nativeCredentialStore())
    return { provider: { type: "local", configuration: parseLocalProviderConfiguration(resolved.environment, homeDirectory) } }
  } catch (error) {
    if (error instanceof LocalProviderConfigurationError || error instanceof OnboardingError) throw new McpConfigurationError(error.message)
    throw error
  }
}
