import { LocalProviderConfigurationError, parseLocalProviderConfiguration, type LocalConfiguredMcpBackend } from "@waterbox/control-plane-local"

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
export function parseMcpConfig(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory?: string,
): WaterboxMcpConfig {
  if (environment.WATERBOX_PROVIDER === "waterbox") return { provider: { type: "waterbox" } }
  try {
    return { provider: { type: "local", configuration: parseLocalProviderConfiguration(environment, homeDirectory) } }
  } catch (error) {
    if (error instanceof LocalProviderConfigurationError) throw new McpConfigurationError(error.message)
    throw error
  }
}
