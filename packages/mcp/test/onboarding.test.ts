import { describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtemp } from "node:fs/promises"
import { runCli } from "../src/cli.ts"
import { dispatch } from "../src/dispatch.ts"
import { automaticStopGuidance, configStorage, credentialState, loadPersisted, resolvedEnvironment, setup, type ConfigStorage, type CredentialStore, type SetupPrompts } from "../src/onboarding.ts"
import { deriveProviderConfigurationId, parseLocalProviderConfiguration } from "@waterbox/control-plane-local"

const automaticStopProse = "How often should a sandbox be automatically stopped?\n\nImportant: a stopped sandbox is automatically resumed by the next coding operation. This is not a limit on total sandbox runtime or spending.\n\nThis is a safety mechanism that limits wasted compute if the agent does not stop a sandbox when finished. Agents are instructed to stop unused sandboxes, but this is not enforced.\n\nA short duration, such as 40m, minimizes wasted compute but may interrupt long-running commands. For long workflows, consider 6h or more. Provider limits apply, so check your plan's maximum execution time."

function fakeStorage(initial?: string): ConfigStorage & { value?: string; writes: number; failWrite: boolean; removes: number } { return { value: initial, writes: 0, failWrite: false, removes: 0, async read() { return this.value }, async write(value) { this.writes += 1; if (this.failWrite) throw new Error("write failed"); this.value = value }, async remove() { this.removes += 1; this.value = undefined } } }
function fakeCredentials(values: Partial<Record<"box" | "vercel", string>> = {}): CredentialStore & { inaccessible: boolean; fail?: "set" | "delete-box" | "delete-vercel"; values: Partial<Record<"box" | "vercel", string>> } { return { values, inaccessible: false, async get(provider) { if (this.inaccessible) throw new Error("locked"); return this.values[provider] }, async set(provider, secret) { if (this.inaccessible || this.fail === "set") throw new Error("locked"); this.values[provider] = secret }, async delete(provider) { if (this.inaccessible || this.fail === `delete-${provider}`) throw new Error("locked"); const present = this.values[provider] !== undefined; delete this.values[provider]; return present } } }
const boxPrompts: SetupPrompts = { async selectProvider() { return "box" }, async input(_message, initial) { return initial }, async secret() { return "box-secret" }, async confirm() { return true } }
const boxSettings = { apiBaseUrl: "https://ascii.dev/api/box/v1", pollIntervalMs: 1000 as const, pollTimeoutMs: 120000 as const, automaticStopMs: 2_400_000 }
const vercelSettings = { apiOrigin: "https://api.vercel.com/", teamId: "team", projectId: "project", pollIntervalMs: 1000 as const, pollTimeoutMs: 120000 as const, requestTimeoutMs: 30000 as const, automaticStopMs: 2_400_000 }
function boxBinding(apiKey: string, apiBaseUrl = boxSettings.apiBaseUrl) { return deriveProviderConfigurationId({ kind: "box", config: { apiBaseUrl, apiKey, polling: { intervalMs: 1000, timeoutMs: 120000 }, automaticStopMs: 2_400_000 } }) }
function vercelBinding(settings = vercelSettings) { return deriveProviderConfigurationId({ kind: "vercel", config: { apiOrigin: settings.apiOrigin, token: "credential-excluded", teamId: settings.teamId, projectId: settings.projectId, polling: { intervalMs: 1000, timeoutMs: 120000, requestTimeoutMs: 30000 }, automaticStopMs: 2_400_000 } }) }
function persistedV2Box(apiKey: string, settings = boxSettings) { return JSON.stringify({ version: 2, provider: "box", providerConfigurationId: boxBinding(apiKey, settings.apiBaseUrl), box: settings }) }
function persistedV2Vercel(settings = vercelSettings) { return JSON.stringify({ version: 2, provider: "vercel", providerConfigurationId: vercelBinding(settings), vercel: settings }) }
async function loadBoxConfig(storage: ConfigStorage) { const config = await loadPersisted(storage); if (config?.provider !== "box") throw new Error("Expected persisted Box configuration"); return config }

describe("native-keyring onboarding", () => {
  test("resolves persisted Box and Vercel settings only when provider is absent", async () => {
    const box = fakeStorage(JSON.stringify({ version: 1, provider: "box", box: boxSettings }))
    expect((await resolvedEnvironment({}, box, fakeCredentials({ box: "secret" }))).environment).toMatchObject({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "secret" })
    const vercel = fakeStorage(JSON.stringify({ version: 1, provider: "vercel", vercel: vercelSettings }))
    expect((await resolvedEnvironment({}, vercel, fakeCredentials({ vercel: "secret" }))).environment).toMatchObject({ WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: "secret", VERCEL_TEAM_ID: "team" })
    const explicit = await resolvedEnvironment({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "environment-secret" }, vercel, fakeCredentials({ vercel: "persisted-secret" }))
    expect(explicit.environment).not.toHaveProperty("VERCEL_TOKEN")
  })

  test("persists and hydrates automatic stop without changing resource scope", async () => {
    const messages: string[] = []
    let automaticStopInitial = ""
    const prompts: SetupPrompts = {
      async selectProvider() { return "box" },
      async input(message, initial) { messages.push(message); if (message === automaticStopGuidance) { automaticStopInitial = initial; return "90m" }; return initial },
      async secret() { return "box-secret" },
      async confirm() { throw new Error("automatic stop must not change binding") },
    }
    const storage = fakeStorage(JSON.stringify({ version: 1, provider: "box", box: boxSettings }))
    await setup(storage, fakeCredentials({ box: "box-secret" }), prompts)
    expect((await loadBoxConfig(storage)).box.automaticStopMs).toBe(5_400_000)
    expect((await resolvedEnvironment({}, storage, fakeCredentials({ box: "box-secret" }))).environment.WATERBOX_AUTO_STOP).toBe("90m")
    expect(messages).toContain(automaticStopProse)
    expect(automaticStopInitial).toBe("40m")
  })

  test("persists version 2 scope metadata while runtime derives the active binding from exact credentials", async () => {
    for (const provider of ["box", "vercel"] as const) {
      const storage = fakeStorage(), credentials = fakeCredentials()
      const prompts: SetupPrompts = provider === "box" ? boxPrompts : {
        async selectProvider() { return "vercel" },
        async input(message, initial) { return message.includes("team") ? "team" : message.includes("project") ? "project" : initial },
        async secret() { return "vercel-secret" },
        async confirm() { throw new Error("first setup must not warn") },
      }
      await setup(storage, credentials, prompts)
      const persisted = await loadPersisted(storage)
      expect(persisted?.version).toBe(2)
      expect(persisted).toHaveProperty("providerConfigurationId")
      if (persisted?.version !== 2) throw new Error("Expected version 2 persisted configuration")
      const hydrated = await resolvedEnvironment({}, storage, credentials)
      const fromKeyring = parseLocalProviderConfiguration(hydrated.environment, "/users/test")
      const fromEnvironment = provider === "box"
        ? parseLocalProviderConfiguration({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "box-secret", BOX_API_BASE_URL: boxSettings.apiBaseUrl, WATERBOX_AUTO_STOP: "40m" }, "/users/test")
        : parseLocalProviderConfiguration({ WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: "vercel-secret", VERCEL_API_ORIGIN: vercelSettings.apiOrigin, VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project", WATERBOX_AUTO_STOP: "40m" }, "/users/test")
      expect(fromKeyring.provider.providerConfigurationId).toBe(fromEnvironment.provider.providerConfigurationId)
      expect(fromKeyring.provider.providerConfigurationId).toBe(persisted.providerConfigurationId)
    }

    const misleadingMetadata = fakeStorage(JSON.stringify({ version: 2, provider: "box", providerConfigurationId: boxBinding("different-key"), box: boxSettings }))
    const hydrated = await resolvedEnvironment({}, misleadingMetadata, fakeCredentials({ box: "actual-key" }))
    expect(parseLocalProviderConfiguration(hydrated.environment, "/users/test").provider.providerConfigurationId).toBe(boxBinding("actual-key"))
  })

  test("new setup pre-fills and persists a 40m automatic stop", async () => {
    const storage = fakeStorage()
    let automaticStopInitial = ""
    await setup(storage, fakeCredentials(), { ...boxPrompts, async input(message, initial) { if (message === automaticStopGuidance) automaticStopInitial = initial; return initial } })
    expect(automaticStopInitial).toBe("40m")
    expect((await loadBoxConfig(storage)).box.automaticStopMs).toBe(2_400_000)
    expect((await resolvedEnvironment({}, storage, fakeCredentials({ box: "box-secret" }))).environment.WATERBOX_AUTO_STOP).toBe("40m")
  })

  test("rejects blank automatic stop without mutating credentials or configuration", async () => {
    const storage = fakeStorage(), credentials = fakeCredentials()
    const prompts: SetupPrompts = { ...boxPrompts, async input(message) { return message === automaticStopGuidance ? "" : "" } }
    await expect(setup(storage, credentials, prompts)).rejects.toThrow("No configuration was saved")
    expect(storage.writes).toBe(0)
    expect(credentials.values).toEqual({})
  })

  test("rejects blank automatic stop on a same-provider rerun without mutation", async () => {
    const raw = JSON.stringify({ version: 2, provider: "box", providerConfigurationId: boxBinding("existing-secret"), box: boxSettings })
    const storage = fakeStorage(raw), credentials = fakeCredentials({ box: "existing-secret" })
    const prompts: SetupPrompts = { ...boxPrompts, async input(message) { return message === automaticStopGuidance ? "" : "" } }
    await expect(setup(storage, credentials, prompts)).rejects.toThrow("No configuration was saved")
    expect(storage.value).toBe(raw)
    expect(credentials.values).toEqual({ box: "existing-secret" })
  })

  test("rejects persisted configuration without automatic stop before credential access", async () => {
    let reads = 0
    await expect(resolvedEnvironment({}, fakeStorage(JSON.stringify({ version: 1, provider: "box", box: { apiBaseUrl: "https://ascii.dev/api/box/v1", pollIntervalMs: 1000, pollTimeoutMs: 120000 } })), { async get() { reads += 1; return "secret" }, async set() {}, async delete() { return false } })).rejects.toThrow("malformed")
    expect(reads).toBe(0)
  })

  test("rejects provider variables without a selection and malformed persisted config without leaking secrets", async () => {
    await expect(resolvedEnvironment({ BOX_API_KEY: "secret" }, fakeStorage(), fakeCredentials())).rejects.toThrow("WATERBOX_PROVIDER")
    await expect(resolvedEnvironment({}, fakeStorage('{"version":1,"provider":"box","box":{"apiKey":"secret"}}'), fakeCredentials())).rejects.toThrow("malformed")
    await expect(resolvedEnvironment({}, fakeStorage('{"version":1,"provider":"box","box":{"apiBaseUrl":"https://ascii.dev/api/box/v1","pollIntervalMs":1000,"pollTimeoutMs":120000,"token":"secret"}}'), fakeCredentials())).rejects.toThrow("malformed")
    await expect(loadPersisted({ async read() { throw new Error("private path") }, async write() {}, async remove() {} })).rejects.toThrow("configuration is unavailable")
  })

  test("setup persists only settings after keyring read-back and retains inactive provider credentials", async () => {
    const storage = fakeStorage(JSON.stringify({ version: 1, provider: "vercel", vercel: vercelSettings }))
    const credentials = fakeCredentials({ vercel: "old" })
    await setup(storage, credentials, boxPrompts)
    expect(storage.value).not.toContain("box-secret")
    expect(credentials.values).toEqual({ box: "box-secret", vercel: "old" })
    expect(await loadPersisted(storage)).toMatchObject({ provider: "box" })
  })

  test("first setup and Vercel token rotation do not require a scope-change confirmation", async () => {
    let confirmations = 0
    const firstTime: SetupPrompts = { ...boxPrompts, async confirm() { confirmations += 1; return true } }
    await setup(fakeStorage(), fakeCredentials(), firstTime)
    expect(confirmations).toBe(0)

    const storage = fakeStorage(JSON.stringify({ version: 1, provider: "vercel", vercel: vercelSettings }))
    const prompts: SetupPrompts = {
      async selectProvider() { return "vercel" }, async input(message, initial) { return message === automaticStopGuidance ? initial : message.includes("origin") ? initial : message.includes("team") ? "team" : "project" }, async secret() { return "rotated-token" },
      async confirm() { confirmations += 1; return true },
    }
    await setup(storage, fakeCredentials({ vercel: "old-token" }), prompts)
    expect(confirmations).toBe(0)
  })

  test("scope changes warn before mutation and a declined confirmation preserves all local state", async () => {
    const raw = JSON.stringify({ version: 1, provider: "box", box: boxSettings })
    const storage = fakeStorage(raw), credentials = fakeCredentials({ box: "old-box", vercel: "old-vercel" })
    const messages: string[] = []
    const prompts: SetupPrompts = {
      async selectProvider() { return "vercel" }, async input(message, initial) { return message === automaticStopGuidance ? initial : message.includes("origin") ? initial : message.includes("team") ? "team" : "project" }, async secret() { return "new-vercel" },
      async confirm(message) { messages.push(message); return false },
    }
    await expect(setup(storage, credentials, prompts)).rejects.toThrow("canceled")
    expect(messages).toEqual(["Changing provider resource scope will not stop, delete, or migrate existing resources. They may continue incurring provider charges. Continue?"])
    expect(storage.value).toBe(raw)
    expect(credentials.values).toEqual({ box: "old-box", vercel: "old-vercel" })
  })

  test("Box key and Vercel team or project changes require scope-change confirmation", async () => {
    const boxStorage = fakeStorage(JSON.stringify({ version: 1, provider: "box", box: boxSettings }))
    const rejected: SetupPrompts = { ...boxPrompts, async secret() { return "rotated-box-key" }, async confirm() { return false } }
    await expect(setup(boxStorage, fakeCredentials({ box: "old-box" }), rejected)).rejects.toThrow("canceled")

    for (const changed of ["team", "project"] as const) {
      const storage = fakeStorage(JSON.stringify({ version: 1, provider: "vercel", vercel: vercelSettings }))
      let confirmed = 0
      const prompts: SetupPrompts = {
        async selectProvider() { return "vercel" }, async input(message, initial) { return message === automaticStopGuidance ? initial : message.includes("origin") ? initial : message.includes(changed) ? `other-${changed}` : message.includes("team") ? "team" : "project" }, async secret() { return "same-token" },
        async confirm() { confirmed += 1; return false },
      }
      await expect(setup(storage, fakeCredentials({ vercel: "same-token" }), prompts)).rejects.toThrow("canceled")
      expect(confirmed).toBe(1)
    }
  })

  test("version 2 metadata preserves switch warnings when prior credentials are missing", async () => {
    const cases: Array<{ raw: string; prompts: SetupPrompts }> = [
      {
        raw: persistedV2Box("old-box-key"),
        prompts: { ...boxPrompts, async secret() { return "new-box-key" }, async confirm() { return false } },
      },
      ...(["team", "project"] as const).map(changed => ({
        raw: persistedV2Vercel(),
        prompts: {
          async selectProvider() { return "vercel" as const },
          async input(message: string, initial: string) {
            if (changed === "team" && message.includes("team")) return "other-team"
            if (changed === "project" && message.includes("project")) return "other-project"
            return initial
          },
          async secret() { return "replacement-token" },
          async confirm() { return false },
        },
      })),
      {
        raw: persistedV2Vercel(),
        prompts: { ...boxPrompts, async confirm() { return false } },
      },
    ]
    for (const { raw, prompts } of cases) {
      const storage = fakeStorage(raw), credentials = fakeCredentials()
      await expect(setup(storage, credentials, prompts)).rejects.toThrow("canceled")
      expect(storage.value).toBe(raw)
      expect(storage.writes).toBe(0)
      expect(credentials.values).toEqual({})
    }
  })

  test("legacy version 1 setup warns only when the prior binding cannot be proved or changes", async () => {
    const legacyBox = JSON.stringify({ version: 1, provider: "box", box: boxSettings })
    let boxConfirmations = 0
    await expect(setup(fakeStorage(legacyBox), fakeCredentials(), { ...boxPrompts, async confirm() { boxConfirmations += 1; return false } })).rejects.toThrow("canceled")
    expect(boxConfirmations).toBe(1)

    const legacyVercel = JSON.stringify({ version: 1, provider: "vercel", vercel: vercelSettings })
    let unchangedConfirmations = 0
    const unchangedStorage = fakeStorage(legacyVercel)
    await setup(unchangedStorage, fakeCredentials(), {
      async selectProvider() { return "vercel" }, async input(_message, initial) { return initial }, async secret() { return "replacement-token" },
      async confirm() { unchangedConfirmations += 1; return true },
    })
    expect(unchangedConfirmations).toBe(0)
    expect((await loadPersisted(unchangedStorage))?.version).toBe(2)

    let changedConfirmations = 0
    await expect(setup(fakeStorage(legacyVercel), fakeCredentials(), {
      async selectProvider() { return "vercel" }, async input(message, initial) { return message.includes("team") ? "other-team" : initial }, async secret() { return "replacement-token" },
      async confirm() { changedConfirmations += 1; return false },
    })).rejects.toThrow("canceled")
    expect(changedConfirmations).toBe(1)
  })

  test("operational-only changes do not warn when version 2 metadata proves the same binding", async () => {
    let confirmations = 0
    const storage = fakeStorage(persistedV2Box("box-secret"))
    await setup(storage, fakeCredentials(), {
      ...boxPrompts,
      async input(message, initial) { return message === automaticStopGuidance ? "45m" : initial },
      async confirm() { confirmations += 1; return true },
    })
    expect(confirmations).toBe(0)
    expect((await loadBoxConfig(storage)).box.automaticStopMs).toBe(2_700_000)
  })

  test("setup persists only official provider endpoints", async () => {
    const boxStorage = fakeStorage()
    await setup(boxStorage, fakeCredentials(), boxPrompts)
    expect((await loadBoxConfig(boxStorage)).box.apiBaseUrl).toBe("https://ascii.dev/api/box/v1")

    const vercelStorage = fakeStorage()
    await setup(vercelStorage, fakeCredentials(), {
      async selectProvider() { return "vercel" },
      async input(message, initial) { return message.includes("team") ? "team" : message.includes("project") ? "project" : initial },
      async secret() { return "vercel-secret" }, async confirm() { return true },
    })
    const persisted = await loadPersisted(vercelStorage)
    expect(persisted?.provider === "vercel" && persisted.vercel.apiOrigin).toBe("https://api.vercel.com/")
  })

  test("rejects custom persisted endpoints before credential access", async () => {
    for (const raw of [
      JSON.stringify({ version: 1, provider: "box", box: { ...boxSettings, apiBaseUrl: "https://attacker.example/box" } }),
      JSON.stringify({ version: 2, provider: "vercel", providerConfigurationId: vercelBinding(), vercel: { ...vercelSettings, apiOrigin: "https://attacker.example/" } }),
    ]) {
      let credentialReads = 0
      const credentials: CredentialStore = { async get() { credentialReads += 1; return "never-read" }, async set() {}, async delete() { return false } }
      await expect(resolvedEnvironment({}, fakeStorage(raw), credentials)).rejects.toThrow("malformed")
      expect(credentialReads).toBe(0)
    }
  })

  test("setup rejects a custom persisted endpoint before prompts or credential-store access", async () => {
    const storage = fakeStorage(JSON.stringify({ version: 1, provider: "box", box: { ...boxSettings, apiBaseUrl: "https://attacker.example/box" } }))
    const credentialCalls: string[] = [], promptCalls: string[] = []
    const credentials: CredentialStore = {
      async get(provider) { credentialCalls.push(`get:${provider}`); return "never-read" },
      async set(provider) { credentialCalls.push(`set:${provider}`) },
      async delete(provider) { credentialCalls.push(`delete:${provider}`); return false },
    }
    const prompts: SetupPrompts = {
      async selectProvider() { promptCalls.push("select"); return "box" },
      async input() { promptCalls.push("input"); return "" },
      async secret() { promptCalls.push("secret"); return "never-read" },
      async confirm() { promptCalls.push("confirm"); return true },
    }
    await expect(setup(storage, credentials, prompts)).rejects.toThrow("unsafe or malformed")
    expect(credentialCalls).toEqual([])
    expect(promptCalls).toEqual([])
    expect(storage.writes).toBe(0)
    expect(storage.value).toContain("attacker.example")
  })

  test("accepts custom endpoints only for complete environment configuration", async () => {
    const box = await resolvedEnvironment({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "environment-secret", BOX_API_BASE_URL: "https://box.example/api" }, fakeStorage(), fakeCredentials())
    expect(box.environment.BOX_API_BASE_URL).toBe("https://box.example/api")
    const vercel = await resolvedEnvironment({ WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: "environment-secret", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project", VERCEL_API_ORIGIN: "https://vercel.example/" }, fakeStorage(), fakeCredentials())
    expect(vercel.environment.VERCEL_API_ORIGIN).toBe("https://vercel.example/")
  })

  test("status reports persisted available, missing, and inaccessible credentials without redacting its state", async () => {
    const storage = fakeStorage(JSON.stringify({ version: 1, provider: "box", box: boxSettings }))
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
    expect(await runCli(["status"], { storage, credentials: available, environment: { WATERBOX_PROVIDER: "box", BOX_API_KEY: "environment-secret", WATERBOX_AUTO_STOP: "40m" }, write: line => output.push(line), error: line => errors.push(line) })).toBe(0)
    expect(output.at(-1)).toContain("configuration environment"); expect(output.at(-1)).not.toContain("environment-secret")
    inaccessible.inaccessible = true
    expect(await runCli(["logout"], { storage, credentials: inaccessible, environment: {}, write: line => output.push(line), error: line => errors.push(line) })).toBe(1)
    expect(storage.value).toBeDefined()
  })

  test("logout describes its strictly local effect", async () => {
    const output: string[] = []
    const storage = fakeStorage(JSON.stringify({ version: 1, provider: "box", box: boxSettings }))
    expect(await runCli(["logout"], { storage, credentials: fakeCredentials({ box: "box", vercel: "vercel" }), environment: {}, write: line => output.push(line), error() {} })).toBe(0)
    expect(output).toEqual(["Waterbox local configuration and stored credentials removed. Remote resources and local SQLite records were not deleted."])
  })

  test("setup failure does not write plaintext configuration", async () => {
    const storage = fakeStorage(); const credentials = fakeCredentials(); credentials.inaccessible = true
    await expect(setup(storage, credentials, boxPrompts)).rejects.toThrow("environment-only")
    expect(storage.writes).toBe(0)
  })

  test("rejects whitespace-bearing credentials before keyring or configuration side effects", async () => {
    for (const secret of [" box-secret", "box-secret ", "\tbox-secret", "box-secret\n"]) {
      const storage = fakeStorage(); let keyringCalls = 0
      const credentials: CredentialStore = {
        async get() { keyringCalls += 1; return undefined },
        async set() { keyringCalls += 1 },
        async delete() { keyringCalls += 1; return false },
      }
      const prompts: SetupPrompts = { ...boxPrompts, async secret() { return secret } }
      let message = ""
      try { await setup(storage, credentials, prompts) } catch (error) { message = String(error) }
      expect(message).toContain("credential is invalid")
      expect(message).not.toContain(secret)
      expect(keyringCalls).toBe(0)
      expect(storage.writes).toBe(0)
      expect(() => parseLocalProviderConfiguration({ WATERBOX_PROVIDER: "box", BOX_API_KEY: secret }, "/users/test")).toThrow("BOX_API_KEY")
      expect(() => deriveProviderConfigurationId({ kind: "box", config: { apiBaseUrl: boxSettings.apiBaseUrl, apiKey: secret, polling: { intervalMs: 1000, timeoutMs: 120000 }, automaticStopMs: 2_400_000 } })).toThrow("credential")
    }

    const raw = persistedV2Box("valid-key"), secret = " stored-key-with-space "
    let message = ""
    try { await resolvedEnvironment({}, fakeStorage(raw), fakeCredentials({ box: secret })) } catch (error) { message = String(error) }
    expect(message).toContain("stored credential is invalid")
    expect(message).not.toContain(secret)
  })

  test("CLI setup rejects non-interactive input before prompting", async () => {
    let prompted = false
    const prompts: SetupPrompts = { async selectProvider() { prompted = true; return "box" }, async input(_message, initial) { return initial }, async secret() { return "secret" }, async confirm() { return true } }
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
    const storage = fakeStorage(JSON.stringify({ version: 1, provider: "box", box: boxSettings })); storage.failWrite = true
    const credentials = fakeCredentials({ box: "old" })
    await expect(setup(storage, credentials, boxPrompts)).rejects.toThrow("confirmed")
    expect(credentials.values).toEqual({ box: "old" }); expect(storage.value).toContain('"provider":"box"')
  })

  test("setup restores configuration and both credentials when a write commits then throws", async () => {
    const priorRaw = persistedV2Box("old-box-key")
    let stored = priorRaw, writes = 0
    const storage: ConfigStorage = {
      async read() { return stored },
      async write(value) { stored = value; writes += 1; if (writes === 1) throw new Error("committed then failed") },
      async remove() { stored = "" },
    }
    const credentials = fakeCredentials({ box: "old-box-key", vercel: "inactive-vercel-token" })
    await expect(setup(storage, credentials, { ...boxPrompts, async secret() { return "new-box-key" } })).rejects.toThrow("rollback was confirmed")
    expect(writes).toBe(2)
    expect(stored).toBe(priorRaw)
    expect(credentials.values).toEqual({ box: "old-box-key", vercel: "inactive-vercel-token" })
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

  test("setup rolls back both providers when a switch cannot persist", async () => {
    const prompts: SetupPrompts = { async selectProvider() { return "vercel" }, async input(message, initial) { return message === automaticStopGuidance ? initial : message.includes("origin") ? initial : message.includes("team") ? "team" : "project" }, async secret() { return "new" }, async confirm() { return true } }
    const storage = fakeStorage(); storage.failWrite = true
    const credentials = fakeCredentials({ box: "old-box", vercel: "old-vercel" })
    await expect(setup(storage, credentials, prompts)).rejects.toThrow("confirmed")
    expect(credentials.values).toEqual({ box: "old-box", vercel: "old-vercel" })
  })

  test("setup rejects malformed persisted configuration before mutation", async () => {
    const storage = fakeStorage('{"version":1,"provider":"box","secret":"bad"}')
    const credentials = fakeCredentials()
    await expect(setup(storage, credentials, boxPrompts)).rejects.toThrow("unsafe or malformed")
    expect(storage.writes).toBe(0)
    expect(credentials.values).toEqual({})
  })

  test("setup commits configuration without deleting inactive credentials", async () => {
    const events: string[] = []; const raw = JSON.stringify({ version: 1, provider: "box", box: boxSettings })
    const storage: ConfigStorage = { async read() { return raw }, async write() { events.push("write") }, async remove() { events.push("remove") } }
    let box = "old"
    const credentials: CredentialStore = { async get(provider) { return provider === "box" ? box : undefined }, async set(_provider, secret) { events.push("set"); box = secret }, async delete() { events.push("delete"); return true } }
    await setup(storage, credentials, boxPrompts)
    expect(events).toEqual(["set", "write"])
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
    for (const command of ["setup", "status", "logout", "unknown"]) expect(await dispatch([command], { async main() { mcp += 1 }, async cli(arguments_) { commands.push(arguments_); return command === "unknown" ? 2 : 0 } })).toBe(command === "unknown" ? 2 : 0)
    expect(mcp).toBe(1); expect(commands).toEqual([["setup"], ["status"], ["logout"], ["unknown"]])
  })
})
