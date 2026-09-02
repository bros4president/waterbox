import { describe, expect, test } from "bun:test"
import { McpConfigurationError, parseMcpConfig } from "../src/config.ts"

describe("Waterbox MCP configuration", () => {
  test("passes explicit direct selection through opaque local composition", () => {
    const config = parseMcpConfig({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "secret" }, "/users/test")
    expect(config).toMatchObject({ provider: { type: "local", configuration: { sqlitePath: "/users/test/.waterbox/direct.sqlite" } } })
  })

  test("passes the alternate explicit direct selection through the same opaque configuration", () => {
    const config = parseMcpConfig({ WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: "secret", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" }, "/users/test")
    expect(config).toMatchObject({ provider: { type: "local", configuration: { sqlitePath: "/users/test/.waterbox/direct.sqlite" } } })
  })

  test("acknowledges Waterbox Cloud without local credentials", () => {
    expect(parseMcpConfig({ WATERBOX_PROVIDER: "waterbox" })).toEqual({ provider: { type: "waterbox" } })
  })

  test("keeps direct configuration values out of errors", () => {
    const secret = "never-print-this"
    for (const environment of [
      { BOX_API_KEY: secret },
      { WATERBOX_PROVIDER: "box", BOX_API_KEY: "" },
      { WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: secret, VERCEL_TEAM_ID: "team" },
    ]) {
      try { parseMcpConfig(environment); throw new Error("Expected invalid configuration") }
      catch (error) { expect(error).toBeInstanceOf(McpConfigurationError); expect(String(error)).not.toContain(secret) }
    }
  })
})
