import { join } from "node:path"
import { homedir } from "node:os"
import { z } from "zod"

const NonEmptySchema = z.string().trim().min(1).max(16_384)
const PositiveIntegerSchema = z.coerce.number().int().positive()
const ProviderSchema = z.enum(["box", "waterbox"])

const EnvironmentSchema = z.object({
  WATERBOX_PROVIDER: ProviderSchema,
  WATERBOX_SQLITE_PATH: NonEmptySchema.optional(),
  BOX_API_BASE_URL: z.url().default("https://ascii.dev/api/box/v1"),
  BOX_API_KEY: NonEmptySchema.optional(),
  BOX_SYSTEM_TEMPLATE_REF: NonEmptySchema.default("waterbox-system-v6"),
  BOX_POLL_INTERVAL_MS: PositiveIntegerSchema.default(1_000),
  BOX_POLL_TIMEOUT_MS: PositiveIntegerSchema.default(120_000),
}).strict()

export interface BoxMcpConfig {
  provider: {
    type: "box"
    config: {
      apiBaseUrl: string
      apiKey: string
      systemTemplateRef: string
      polling: { intervalMs: number; timeoutMs: number }
    }
  }
  sqlitePath: string
}

export interface WaterboxCloudMcpConfig {
  provider: { type: "waterbox" }
}

export type WaterboxMcpConfig = BoxMcpConfig | WaterboxCloudMcpConfig

export class McpConfigurationError extends Error {
  constructor(message = "Waterbox MCP configuration is invalid") {
    super(message)
    this.name = "McpConfigurationError"
  }
}

export class MissingMcpCredentialError extends McpConfigurationError {
  constructor() {
    super("BOX_API_KEY is required for the Box provider. Configure it using your MCP client's recommended secret or environment mechanism, then restart the client. Do not provide the key in chat or as a tool argument.")
    this.name = "MissingMcpCredentialError"
  }
}

export function parseMcpConfig(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory = homedir(),
): WaterboxMcpConfig {
  const selected = Object.fromEntries(Object.keys(EnvironmentSchema.shape).map((key) => [key, environment[key]]))
  if (selected.WATERBOX_PROVIDER === "box" && (typeof selected.BOX_API_KEY !== "string" || selected.BOX_API_KEY.trim() === "")) {
    throw new MissingMcpCredentialError()
  }
  const parsed = EnvironmentSchema.safeParse(selected)
  if (!parsed.success) throw new McpConfigurationError()
  if (parsed.data.WATERBOX_PROVIDER === "waterbox") return { provider: { type: "waterbox" } }
  if (!parsed.data.BOX_API_KEY) throw new MissingMcpCredentialError()
  if (parsed.data.BOX_POLL_TIMEOUT_MS < parsed.data.BOX_POLL_INTERVAL_MS) throw new McpConfigurationError()
  return {
    provider: {
      type: "box",
      config: {
        apiBaseUrl: parsed.data.BOX_API_BASE_URL,
        apiKey: parsed.data.BOX_API_KEY,
        systemTemplateRef: parsed.data.BOX_SYSTEM_TEMPLATE_REF,
        polling: {
          intervalMs: parsed.data.BOX_POLL_INTERVAL_MS,
          timeoutMs: parsed.data.BOX_POLL_TIMEOUT_MS,
        },
      },
    },
    sqlitePath: parsed.data.WATERBOX_SQLITE_PATH ?? join(homeDirectory, ".waterbox", "direct.sqlite"),
  }
}
