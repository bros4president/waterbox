import { describe, expect, test } from "bun:test"
import { McpConfigurationError, parseMcpConfig } from "../src/config.ts"

function persistedBox() {
  return {
    storage: {
      async read() { return JSON.stringify({ version: 1, provider: "box", box: { apiBaseUrl: "https://ascii.dev/api/box/v1", pollIntervalMs: 1000, pollTimeoutMs: 120000 } }) },
      async write() {},
      async remove() {},
    },
    credentials: { async get(provider: "box" | "vercel") { return provider === "box" ? "secret" : undefined }, async set() {}, async delete() { return false } },
  }
}

describe("Waterbox MCP configuration", () => {
  test("passes explicit direct selection through opaque local composition", async () => {
    const config = await parseMcpConfig({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "secret" }, "/users/test")
    expect(config).toMatchObject({ provider: { type: "local", configuration: { sqlitePath: "/users/test/.waterbox/direct.sqlite" } } })
  })

  test("passes the alternate explicit direct selection through the same opaque configuration", async () => {
    const config = await parseMcpConfig({ WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: "secret", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" }, "/users/test")
    expect(config).toMatchObject({ provider: { type: "local", configuration: { sqlitePath: "/users/test/.waterbox/direct.sqlite" } } })
  })

  test("derives the same binding through persisted setup and environment-only composition", async () => {
    const fromEnvironment = await parseMcpConfig({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "secret", BOX_API_BASE_URL: "https://ascii.dev/api/box/v1/" }, "/users/test")
    const fromPersistedSetup = await parseMcpConfig({}, "/users/test", persistedBox())
    if (fromEnvironment.provider.type !== "local" || fromPersistedSetup.provider.type !== "local") throw new Error("Expected local configuration")
    expect(fromEnvironment.provider.configuration.provider.providerConfigurationId).toBe(fromPersistedSetup.provider.configuration.provider.providerConfigurationId)
  })

  test("retains custom endpoints for complete environment-only configuration", async () => {
    const box = await parseMcpConfig({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "secret", BOX_API_BASE_URL: "https://box.example/api" }, "/users/test")
    const vercel = await parseMcpConfig({ WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: "secret", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project", VERCEL_API_ORIGIN: "https://vercel.example/" }, "/users/test")
    if (box.provider.type !== "local" || vercel.provider.type !== "local") throw new Error("Expected local configuration")
    if (box.provider.configuration.provider.kind !== "box" || vercel.provider.configuration.provider.kind !== "vercel") throw new Error("Expected selected providers")
    expect(box.provider.configuration.provider.config.apiBaseUrl).toBe("https://box.example/api")
    expect(vercel.provider.configuration.provider.config.apiOrigin).toBe("https://vercel.example")
  })

  test("parses complete Waterbox Cloud configuration", async () => {
    expect(await parseMcpConfig({ WATERBOX_PROVIDER: "waterbox", WATERBOX_API_URL: "https://waterbox.example/", WATERBOX_API_KEY: "secret" })).toEqual({
      provider: { type: "waterbox", apiUrl: "https://waterbox.example/", apiKey: "secret" },
    })
  })

  test("keeps provider configuration values out of errors", async () => {
    const secret = "never-print-this"
    for (const environment of [
      { BOX_API_KEY: secret },
      { WATERBOX_PROVIDER: "box", BOX_API_KEY: "" },
      { WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: secret, VERCEL_TEAM_ID: "team" },
      { WATERBOX_PROVIDER: "waterbox", WATERBOX_API_KEY: secret },
      { WATERBOX_PROVIDER: "waterbox", WATERBOX_API_URL: "ftp://waterbox.example/", WATERBOX_API_KEY: secret },
      { WATERBOX_PROVIDER: "waterbox", WATERBOX_API_URL: "https://waterbox.example/path", WATERBOX_API_KEY: secret },
      { WATERBOX_PROVIDER: "waterbox", WATERBOX_API_URL: "https://user@waterbox.example/", WATERBOX_API_KEY: secret },
      { WATERBOX_PROVIDER: "waterbox", WATERBOX_API_URL: "https://waterbox.example/", WATERBOX_API_KEY: `bad ${secret}` },
    ]) {
      try { await parseMcpConfig(environment); throw new Error("Expected invalid configuration") }
      catch (error) { expect(error).toBeInstanceOf(McpConfigurationError); expect(String(error)).not.toContain(secret) }
    }
  })
})
