import { describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtemp } from "node:fs/promises"
import { runCli } from "../src/cli.ts"
import { dispatch } from "../src/dispatch.ts"
import { configStorage, credentialState, loadPersisted, resolvedEnvironment, setup, type ConfigStorage, type CredentialStore, type SetupPrompts } from "../src/onboarding.ts"

function fakeStorage(initial?: string): ConfigStorage & { value?: string; writes: number; failWrite: boolean; removes: number } { return { value: initial, writes: 0, failWrite: false, removes: 0, async read() { return this.value }, async write(value) { this.writes += 1; if (this.failWrite) throw new Error("write failed"); this.value = value }, async remove() { this.removes += 1; this.value = undefined } } }
function fakeCredentials(values: Partial<Record<"box" | "vercel", string>> = {}): CredentialStore & { inaccessible: boolean; fail?: "set" | "delete-box" | "delete-vercel"; values: Partial<Record<"box" | "vercel", string>> } { return { values, inaccessible: false, async get(provider) { if (this.inaccessible) throw new Error("locked"); return this.values[provider] }, async set(provider, secret) { if (this.inaccessible || this.fail === "set") throw new Error("locked"); this.values[provider] = secret }, async delete(provider) { if (this.inaccessible || this.fail === `delete-${provider}`) throw new Error("locked"); const present = this.values[provider] !== undefined; delete this.values[provider]; return present } } }
const boxPrompts: SetupPrompts = { async selectProvider() { return "box" }, async input(_message, initial) { return initial }, async secret() { return "box-secret" } }

describe("native-keyring onboarding", () => {
  test("resolves persisted Box and Vercel settings only when provider is absent", async () => {
    const box = fakeStorage(JSON.stringify({ version: 1, provider: "box", box: { apiBaseUrl: "https://ascii.dev/api/box/v1", pollIntervalMs: 1000, pollTimeoutMs: 120000 } }))
    expect((await resolvedEnvironment({}, box, fakeCredentials({ box: "secret" }))).environment).toMatchObject({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "secret" })
    const vercel = fakeStorage(JSON.stringify({ version: 1, provider: "vercel", vercel: { apiOrigin: "https://api.vercel.com/", teamId: "team", projectId: "project", pollIntervalMs: 1000, pollTimeoutMs: 120000, requestTimeoutMs: 30000 } }))
    expect((await resolvedEnvironment({}, vercel, fakeCredentials({ vercel: "secret" }))).environment).toMatchObject({ WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: "secret", VERCEL_TEAM_ID: "team" })
    const explicit = await resolvedEnvironment({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "environment-secret" }, vercel, fakeCredentials({ vercel: "persisted-secret" }))
    expect(explicit.environment).not.toHaveProperty("VERCEL_TOKEN")
  })

  test("rejects provider variables without a selection and malformed persisted config without leaking secrets", async () => {
    await expect(resolvedEnvironment({ BOX_API_KEY: "secret" }, fakeStorage(), fakeCredentials())).rejects.toThrow("WATERBOX_PROVIDER")
    await expect(resolvedEnvironment({}, fakeStorage('{"version":1,"provider":"box","box":{"apiKey":"secret"}}'), fakeCredentials())).rejects.toThrow("malformed")
    await expect(resolvedEnvironment({}, fakeStorage('{"version":1,"provider":"box","box":{"apiBaseUrl":"https://ascii.dev/api/box/v1","pollIntervalMs":1000,"pollTimeoutMs":120000,"token":"secret"}}'), fakeCredentials())).rejects.toThrow("malformed")
    await expect(loadPersisted({ async read() { throw new Error("private path") }, async write() {}, async remove() {} })).rejects.toThrow("configuration is unavailable")
  })

  test("setup persists only settings after keyring read-back and removes stale provider credentials", async () => {
    const storage = fakeStorage(JSON.stringify({ version: 1, provider: "vercel", vercel: { apiOrigin: "https://api.vercel.com/", teamId: "team", projectId: "project", pollIntervalMs: 1000, pollTimeoutMs: 120000, requestTimeoutMs: 30000 } }))
    const credentials = fakeCredentials({ vercel: "old" })
    await setup(storage, credentials, boxPrompts)
    expect(storage.value).not.toContain("box-secret")
    expect(credentials.values).toEqual({ box: "box-secret" })
    expect(await loadPersisted(storage)).toMatchObject({ provider: "box" })
  })

  test("status reports persisted available, missing, and inaccessible credentials without redacting its state", async () => {
    const storage = fakeStorage(JSON.stringify({ version: 1, provider: "box", box: { apiBaseUrl: "https://ascii.dev/api/box/v1", pollIntervalMs: 1000, pollTimeoutMs: 120000 } }))
    const output: string[] = []; const errors: string[] = []
    const available = fakeCredentials({ box: "never-print" })
    expect(await runCli(["status"], { storage, credentials: available, environment: {}, write: line => output.push(line), error: line => errors.push(line) })).toBe(0)
    expect(output.at(-1)).toContain("available")
    expect(await runCli(["status"], { storage, credentials: fakeCredentials(), environment: {}, write: line => output.push(line), error: line => errors.push(line) })).toBe(1)
    expect(output.at(-1)).toContain("missing"); expect(output.at(-1)).toContain("BOX_API_KEY")
    const inaccessible = fakeCredentials({ box: "never-print" }); inaccessible.inaccessible = true
    expect(await credentialState("box", inaccessible)).toBe("inaccessible")
    expect(await runCli(["status"], { storage, credentials: inaccessible, environment: {}, write: line => output.push(line), error: line => errors.push(line) })).toBe(1)
    expect(output.at(-1)).toContain("inaccessible"); expect(`${output}\n${errors}`).not.toContain("never-print")
    expect(await runCli(["status"], { storage, credentials: available, environment: { WATERBOX_PROVIDER: "box", BOX_API_KEY: "environment-secret" }, write: line => output.push(line), error: line => errors.push(line) })).toBe(0)
    expect(output.at(-1)).toContain("configuration environment"); expect(output.at(-1)).not.toContain("environment-secret")
    inaccessible.inaccessible = true
    expect(await runCli(["logout"], { storage, credentials: inaccessible, environment: {}, write: line => output.push(line), error: line => errors.push(line) })).toBe(1)
    expect(storage.value).toBeDefined()
  })

  test("setup failure does not write plaintext configuration", async () => {
    const storage = fakeStorage(); const credentials = fakeCredentials(); credentials.inaccessible = true
    await expect(setup(storage, credentials, boxPrompts)).rejects.toThrow("environment-only")
    expect(storage.writes).toBe(0)
  })

  test("CLI setup rejects non-interactive input before prompting", async () => {
    let prompted = false
    const prompts: SetupPrompts = { async selectProvider() { prompted = true; return "box" }, async input(_message, initial) { return initial }, async secret() { return "secret" } }
    const errors: string[] = []
    expect(await runCli(["setup"], { storage: fakeStorage(), credentials: fakeCredentials(), prompts, interactive: false, write() {}, error: line => errors.push(line) })).toBe(1)
    expect(prompted).toBeFalse(); expect(errors.join("\n")).toContain("interactive terminal")
  })

  test("default storage writes private atomic configuration without the keyring secret", async () => {
    const home = await mkdtemp(join(tmpdir(), "waterbox-home-")); const storage = configStorage(home)
    try {
      await setup(storage, fakeCredentials(), boxPrompts)
      const path = join(home, ".waterbox", "config.json")
      expect(await readFile(path, "utf8")).not.toContain("box-secret")
      expect((await stat(path)).mode & 0o077).toBe(0)
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  test("default storage rejects static config and directory symlinks", async () => {
    const home = await mkdtemp(join(tmpdir(), "waterbox-home-")); const path = join(home, ".waterbox")
    try {
      await mkdir(path); await writeFile(join(home, "target"), "{}")
      await symlink(join(home, "target"), join(path, "config.json"))
      await expect(configStorage(home).read()).rejects.toThrow("unavailable")
      await rm(path, { recursive: true, force: true }); await symlink(home, path)
      await expect(configStorage(home).read()).rejects.toThrow("unavailable")
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  test("default storage rejects oversized configuration before reading it", async () => {
    const home = await mkdtemp(join(tmpdir(), "waterbox-home-")); const directory = join(home, ".waterbox")
    try { await mkdir(directory); await writeFile(join(directory, "config.json"), " ".repeat(64 * 1024 + 1)); await expect(configStorage(home).read()).rejects.toThrow("unavailable") }
    finally { await rm(home, { recursive: true, force: true }) }
  })

  test("setup rolls back same-provider credentials when config persistence fails", async () => {
    const storage = fakeStorage(JSON.stringify({ version: 1, provider: "box", box: { apiBaseUrl: "https://ascii.dev/api/box/v1", pollIntervalMs: 1000, pollTimeoutMs: 120000 } })); storage.failWrite = true
    const credentials = fakeCredentials({ box: "old" })
    await expect(setup(storage, credentials, boxPrompts)).rejects.toThrow("confirmed")
    expect(credentials.values).toEqual({ box: "old" }); expect(storage.value).toContain('"provider":"box"')
  })

  test("setup rolls back a credential write that mutates before throwing", async () => {
    const storage = fakeStorage(); let value = "old"
    const credentials: CredentialStore = {
      async get(provider) { return provider === "box" ? value : undefined },
      async set(provider, secret) { if (provider === "box" && secret === "box-secret") { value = secret; throw new Error("native secret detail") }; if (provider === "box") value = secret },
      async delete(provider) { if (provider === "box") value = ""; return true },
    }
    let message = ""
    try { await setup(storage, credentials, boxPrompts) } catch (error) { message = String(error) }
    expect(value).toBe("old"); expect(message).toContain("rollback was confirmed"); expect(message).not.toContain("native secret detail")
  })

  test("setup rolls back both providers for switch persistence and stale-delete failures", async () => {
    const prompts: SetupPrompts = { async selectProvider() { return "vercel" }, async input(message) { return message.includes("team") ? "team" : "project" }, async secret() { return "new" } }
    const storage = fakeStorage(); storage.failWrite = true
    const credentials = fakeCredentials({ box: "old-box", vercel: "old-vercel" })
    await expect(setup(storage, credentials, prompts)).rejects.toThrow("confirmed")
    expect(credentials.values).toEqual({ box: "old-box", vercel: "old-vercel" })
    storage.failWrite = false; credentials.fail = "delete-box"
    await expect(setup(storage, credentials, prompts)).rejects.toThrow("confirmed")
    expect(credentials.values).toEqual({ box: "old-box", vercel: "old-vercel" })
  })

  test("setup replaces malformed persisted configuration", async () => {
    const storage = fakeStorage('{"version":1,"provider":"box","secret":"bad"}')
    await setup(storage, fakeCredentials(), boxPrompts)
    expect(await loadPersisted(storage)).toMatchObject({ provider: "box" })
  })

  test("setup commits configuration before deleting stale credentials and restores it if deletion fails", async () => {
    const events: string[] = []; const raw = '{"malformed":true}'
    const storage: ConfigStorage = { async read() { return raw }, async write() { events.push("write") }, async remove() { events.push("remove") } }
    let box = "old"
    const credentials: CredentialStore = { async get(provider) { return provider === "box" ? box : undefined }, async set(_provider, secret) { events.push("set"); box = secret }, async delete() { events.push("delete"); throw new Error("native detail never printed") } }
    let message = ""
    try { await setup(storage, credentials, boxPrompts) } catch (error) { message = String(error) }
    expect(message).toContain("rollback could not be confirmed"); expect(message).not.toContain("native detail never printed")
    expect(events.slice(0, 3)).toEqual(["set", "write", "delete"])
  })

  test("logout attempts both deletes and retains config when either delete fails", async () => {
    for (const failure of ["delete-box", "delete-vercel"] as const) {
      const storage = fakeStorage("{}"), credentials = fakeCredentials({ box: "box", vercel: "vercel" }); credentials.fail = failure
      await expect(runCli(["logout"], { storage, credentials, environment: {}, write() {}, error() {} })).resolves.toBe(1)
      expect(storage.value).toBe("{}"); expect(storage.removes).toBe(0)
    }
  })

  test("bin dispatch keeps zero arguments in MCP mode and sends explicit arguments only to CLI", async () => {
    let mcp = 0; const commands: string[][] = []
    expect(await dispatch([], { async main() { mcp += 1 }, async cli(arguments_) { commands.push(arguments_); return 2 } })).toBeUndefined()
    expect(await dispatch(["unknown"], { async main() { mcp += 1 }, async cli(arguments_) { commands.push(arguments_); return 2 } })).toBe(2)
    expect(mcp).toBe(1); expect(commands).toEqual([["unknown"]])
  })
})
