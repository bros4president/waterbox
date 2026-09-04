import { AccountIdSchema } from "@waterbox/contracts"
import { parseAutomaticStopDuration } from "@waterbox/control-plane-local"
import { z } from "zod"

const nonSecret = z.string().trim().min(1).max(512)
const secret = z.string().min(1).max(16_384)
const port = z.coerce.number().int().min(1).max(65_535)
const positiveInteger = z.coerce.number().int().positive()
const EnvironmentSchema = z.object({
  WATERBOX_API_HOST: nonSecret.default("127.0.0.1"),
  WATERBOX_API_PORT: port.default(8787),
  WATERBOX_SQLITE_PATH: nonSecret,
  WATERBOX_DEV_API_KEY: secret,
  WATERBOX_DEV_ACCOUNT_ID: AccountIdSchema,
  BOX_API_BASE_URL: z.url().default("https://ascii.dev/api/box/v1"),
  BOX_API_KEY: secret,
  BOX_POLL_INTERVAL_MS: positiveInteger.default(1_000),
  BOX_POLL_TIMEOUT_MS: positiveInteger.default(120_000),
  WATERBOX_AUTO_STOP: z.string(),
}).strict()

export interface LocalApiConfig {
  host: string
  port: number
  sqlitePath: string
  developmentApiKey: string
  accountId: string
  box: {
    apiBaseUrl: string
    apiKey: string
    polling: { intervalMs: number; timeoutMs: number }
    automaticStopMs: number
  }
}

export class LocalConfigurationError extends Error {
  constructor() {
    super("Waterbox local API configuration is invalid")
    this.name = "LocalConfigurationError"
  }
}

export function parseLocalApiConfig(environment: Record<string, string | undefined>): LocalApiConfig {
  const selected = Object.fromEntries(Object.keys(EnvironmentSchema.shape).map((key) => [key, environment[key]]))
  const parsed = EnvironmentSchema.safeParse(selected)
  if (!parsed.success || parsed.data.BOX_POLL_TIMEOUT_MS < parsed.data.BOX_POLL_INTERVAL_MS) {
    throw new LocalConfigurationError()
  }
  let automaticStopMs: number
  try { automaticStopMs = parseAutomaticStopDuration(parsed.data.WATERBOX_AUTO_STOP) }
  catch { throw new LocalConfigurationError() }
  return {
    host: parsed.data.WATERBOX_API_HOST,
    port: parsed.data.WATERBOX_API_PORT,
    sqlitePath: parsed.data.WATERBOX_SQLITE_PATH,
    developmentApiKey: parsed.data.WATERBOX_DEV_API_KEY,
    accountId: parsed.data.WATERBOX_DEV_ACCOUNT_ID,
    box: {
      apiBaseUrl: parsed.data.BOX_API_BASE_URL,
      apiKey: parsed.data.BOX_API_KEY,
      polling: { intervalMs: parsed.data.BOX_POLL_INTERVAL_MS, timeoutMs: parsed.data.BOX_POLL_TIMEOUT_MS },
      automaticStopMs,
    },
  }
}
