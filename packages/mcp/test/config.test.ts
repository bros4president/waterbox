import { describe, expect, test } from "bun:test"
import { McpConfigurationError, MissingMcpCredentialError, parseMcpConfig } from "../src/config.ts"

describe("Waterbox MCP configuration", () => {
  test("parses the direct Box provider with user-level defaults", () => {
    expect(parseMcpConfig({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "secret" }, "/users/test")).toEqual({
      provider: {
        type: "box",
        config: {
          apiBaseUrl: "https://ascii.dev/api/box/v1",
          apiKey: "secret",
          polling: { intervalMs: 1_000, timeoutMs: 120_000 },
        },
      },
      sqlitePath: "/users/test/.waterbox/direct.sqlite",
    })
  })

  test("acknowledges Waterbox Cloud without requiring Box configuration", () => {
    expect(parseMcpConfig({ WATERBOX_PROVIDER: "waterbox" })).toEqual({ provider: { type: "waterbox" } })
  })

  test("reports how to provide a missing Box credential without exposing a value", () => {
    for (const BOX_API_KEY of [undefined, ""]) {
      expect(() => parseMcpConfig({ WATERBOX_PROVIDER: "box", BOX_API_KEY })).toThrow(MissingMcpCredentialError)
      expect(() => parseMcpConfig({ WATERBOX_PROVIDER: "box", BOX_API_KEY })).toThrow(
        "BOX_API_KEY is required for the Box provider. Set WATERBOX_PROVIDER=box and configure BOX_API_KEY using your MCP client's recommended secret or environment mechanism, then restart the client. Do not provide the key in chat or as a tool argument.",
      )
    }
  })

  test("requires an explicit provider and keeps credentials out of errors", () => {
    const credential = "never-print-this"
    for (const environment of [
      { BOX_API_KEY: credential },
      { WATERBOX_PROVIDER: "box", BOX_API_KEY: credential, BOX_POLL_INTERVAL_MS: "2000", BOX_POLL_TIMEOUT_MS: "1000" },
    ]) {
      try {
        parseMcpConfig(environment)
        throw new Error("Expected invalid configuration")
      } catch (error) {
        expect(error).toBeInstanceOf(McpConfigurationError)
        expect(String(error)).not.toContain(credential)
      }
    }
  })
})
