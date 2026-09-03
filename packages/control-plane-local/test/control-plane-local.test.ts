import { afterEach, describe, expect, test } from "bun:test"
import { WaterboxClient } from "@waterbox/client"
import { FixedClock, FakeSandboxProvider, SequenceIdGenerator } from "@waterbox/core/test-support"
import { SqliteRepositoryStore } from "@waterbox/repository-sqlite"
import type { IdentityResolver } from "@waterbox/api"
import { access, mkdtemp, rm, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEmbeddedApiBackend, createLocalControlPlane, deriveProviderConfigurationId, parseAutomaticStopDuration, parseLocalProviderConfiguration, type LocalControlPlaneConfig } from "../src/index.ts"

const accountId = "acct_local_control_plane_test"
const sandboxId = "sbx_calm-cactus-7k3m"
const credential = "raw-development-credential"
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function config(sqlitePath: string, provider = new FakeSandboxProvider()): LocalControlPlaneConfig {
  return {
    sqlitePath,
    accountId,
    provider: { kind: "injected", implementation: provider },
  }
}

function boxConfig(sqlitePath: string): LocalControlPlaneConfig {
  const providerConfig = { apiBaseUrl: "https://box.invalid/v1", apiKey: "test-placeholder", polling: { intervalMs: 1, timeoutMs: 2 } }
  return {
    sqlitePath,
    accountId,
    provider: {
      kind: "box",
      config: providerConfig,
      providerConfigurationId: deriveProviderConfigurationId({ kind: "box", config: providerConfig }),
      runtimeArtifact: { bytes: new Uint8Array([1]), sha256: "0".repeat(64), cliProtocolVersion: 2, artifactVersion: "test" },
    },
  }
}

function vercelConfig(sqlitePath: string): LocalControlPlaneConfig {
  const providerConfig = { apiOrigin: "https://vercel.invalid", token: "test-placeholder", teamId: "team", projectId: "project", polling: { intervalMs: 1, timeoutMs: 2, requestTimeoutMs: 1 } }
  return {
    sqlitePath,
    accountId,
    provider: {
      kind: "vercel",
      config: providerConfig,
      providerConfigurationId: deriveProviderConfigurationId({ kind: "vercel", config: providerConfig }),
      runtimeArtifact: { bytes: new TextEncoder().encode("#!/usr/bin/env node\n"), sha256: createHash("sha256").update("#!/usr/bin/env node\n").digest("hex"), cliProtocolVersion: 2, artifactVersion: "test" },
    },
  }
}

const resolver: IdentityResolver = {
  async resolveBearer(value, signal) {
    signal.throwIfAborted()
    return value === credential ? { accountId } : undefined
  },
}

function authenticated(path: string, init: RequestInit = {}): Request {
  return new Request(`http://waterbox.local${path}`, {
    ...init,
    headers: { authorization: `Bearer ${credential}`, ...init.headers },
  })
}

describe("local control-plane composition", () => {
  test("derives canonical provider bindings from identity scope only", () => {
    const vercel = {
      kind: "vercel" as const,
      config: { apiOrigin: "https://api.vercel.com/", token: "first-token", teamId: " team ", projectId: " project ", polling: { intervalMs: 1, timeoutMs: 2, requestTimeoutMs: 1 } },
    }
    const reorderedVercel = {
      config: { polling: { requestTimeoutMs: 99, timeoutMs: 100, intervalMs: 3 }, projectId: "project", token: "rotated-token", apiOrigin: "https://api.vercel.com", teamId: "team" },
      kind: "vercel" as const,
    }
    const vercelId = deriveProviderConfigurationId(vercel)
    expect(vercelId).toBe(deriveProviderConfigurationId(reorderedVercel))
    expect(vercelId).not.toBe(deriveProviderConfigurationId({ ...vercel, config: { ...vercel.config, teamId: "other-team" } }))
    expect(vercelId).not.toBe(deriveProviderConfigurationId({ ...vercel, config: { ...vercel.config, projectId: "other-project" } }))
    expect(vercelId).not.toBe(deriveProviderConfigurationId({ ...vercel, config: { ...vercel.config, apiOrigin: "https://vercel.invalid" } }))
    expect(vercelId).toBe(deriveProviderConfigurationId({ ...vercel, config: { ...vercel.config, automaticStopMs: 86_400_000 } }))

    const box = { kind: "box" as const, config: { apiBaseUrl: "https://ascii.dev/api/box/v1/", apiKey: "box-key", polling: { intervalMs: 1, timeoutMs: 2 } } }
    const reorderedBox = { config: { polling: { timeoutMs: 100, intervalMs: 3 }, apiKey: "box-key", apiBaseUrl: "https://ascii.dev/api/box/v1" }, kind: "box" as const }
    const boxId = deriveProviderConfigurationId(box)
    expect(boxId).toBe(deriveProviderConfigurationId(reorderedBox))
    expect(boxId).not.toContain("box-key")
    expect(boxId).not.toBe(deriveProviderConfigurationId({ ...box, config: { ...box.config, apiKey: "rotated-box-key" } }))
    expect(boxId).not.toBe(deriveProviderConfigurationId({ ...box, config: { ...box.config, apiBaseUrl: "https://box.invalid/v1" } }))
    expect(boxId).toBe(deriveProviderConfigurationId({ ...box, config: { ...box.config, automaticStopMs: 1_800_000 } }))
  })

  test("parses the operator automatic-stop duration strictly before composition", () => {
    expect(parseAutomaticStopDuration("30m")).toBe(1_800_000)
    expect(parseAutomaticStopDuration("90m")).toBe(5_400_000)
    expect(parseAutomaticStopDuration("2h")).toBe(7_200_000)
    expect(parseAutomaticStopDuration("24h")).toBe(86_400_000)
    expect(parseAutomaticStopDuration(undefined)).toBeUndefined()
    expect(parseAutomaticStopDuration("", { allowBlank: true })).toBeUndefined()
    for (const value of ["", " ", "0m", "-1m", "1.5h", "1h30m", "30s", "1d", "30M", "9007199254740992m"]) expect(() => parseAutomaticStopDuration(value)).toThrow("WATERBOX_AUTO_STOP")
    expect(parseLocalProviderConfiguration({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "key", WATERBOX_AUTO_STOP: "30m" }, "/users/test").provider.config).toMatchObject({ automaticStopMs: 1_800_000 })
    expect(() => parseLocalProviderConfiguration({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "key", WATERBOX_AUTO_STOP: "1.5h" }, "/users/test")).toThrow("WATERBOX_AUTO_STOP")
  })

  test("raw API authentication is enforced without a listener", async () => {
    const plane = await createLocalControlPlane(config(":memory:"), resolver)
    cleanup.push(() => plane.close())
    expect((await plane.fetch(new Request("http://waterbox.local/v1/sandboxes"))).status).toBe(401)
    expect((await plane.fetch(new Request("http://waterbox.local/v1/sandboxes", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401)
    expect((await plane.fetch(authenticated("/v1/sandboxes"))).status).toBe(200)
  })

  test("embedded client traverses API and replaces external Authorization", async () => {
    const provider = new FakeSandboxProvider()
    const backend = await createEmbeddedApiBackend(config(":memory:", provider), {
      clock: new FixedClock(),
      ids: new SequenceIdGenerator([sandboxId]),
    })
    const client = new WaterboxClient(backend)
    cleanup.push(() => client.close())

    const smuggled = await backend.fetch(new Request("http://waterbox.local/v1/sandboxes", {
      headers: { authorization: "Bearer caller-controlled" },
    }))
    expect(smuggled.status).toBe(200)

    const created = await client.createSandbox({}, { idempotencyKey: "embedded-flow", signal: new AbortController().signal })
    expect(created.sandboxId).toBe(sandboxId)
    expect(provider.createCalls).toBe(1)
    expect(provider.prepareCalls).toBe(1)
  })

  test("filesystem parent is private and records survive reconstruction", async () => {
    const root = await mkdtemp(join(tmpdir(), "waterbox-local-plane-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const parent = join(root, "private", "nested")
    const sqlitePath = join(parent, "control-plane.sqlite")
    const provider = new FakeSandboxProvider()
    const first = await createLocalControlPlane(config(sqlitePath, provider), resolver, {
      clock: new FixedClock(),
      ids: new SequenceIdGenerator([sandboxId]),
    })
    const createResponse = await first.fetch(authenticated("/v1/sandboxes", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "persisted" },
      body: "{}",
    }))
    expect(createResponse.status).toBe(201)
    await first.close()
    expect((await stat(parent)).mode & 0o777).toBe(0o700)

    const second = await createLocalControlPlane(config(sqlitePath, provider), resolver)
    cleanup.push(() => second.close())
    const listed = await (await second.fetch(authenticated("/v1/sandboxes"))).json()
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0].sandboxId).toBe(sandboxId)
  })

  test("selection and artifact failures precede filesystem and SQLite effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "waterbox-local-invalid-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const parent = join(root, "must-not-exist")
    const selected = boxConfig(join(parent, "db.sqlite"))

    await expect(createLocalControlPlane({ ...selected, provider: undefined } as unknown as LocalControlPlaneConfig, resolver)).rejects.toThrow("provider selection")
    if (selected.provider.kind !== "box") throw new Error("Expected Box test configuration")
    await expect(createLocalControlPlane({
      ...selected,
      provider: { ...selected.provider, runtimeArtifact: { ...selected.provider.runtimeArtifact, sha256: "invalid" } },
    }, resolver)).rejects.toThrow("artifact")
    await expect(access(parent)).rejects.toBeDefined()
  })

  test("explicit Vercel selection validates before filesystem or provider effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "waterbox-local-vercel-invalid-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const parent = join(root, "must-not-exist")
    const selected = vercelConfig(join(parent, "db.sqlite"))
    if (selected.provider.kind !== "vercel") throw new Error("Expected Vercel test configuration")
    await expect(createLocalControlPlane({ ...selected, provider: { ...selected.provider, config: { ...selected.provider.config, apiOrigin: "http://invalid" } } }, resolver)).rejects.toThrow("configuration")
    await expect(access(parent)).rejects.toBeDefined()
  })

  test("owns direct environment parsing below composition and keeps values out of errors", () => {
    expect(parseLocalProviderConfiguration({ WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: "token", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" }, "/users/test")).toMatchObject({ sqlitePath: "/users/test/.waterbox/direct.sqlite", provider: { kind: "vercel", config: { token: "token" } } })
    const secret = "do-not-render"
    try { parseLocalProviderConfiguration({ WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: secret, VERCEL_TEAM_ID: "team" }) } catch (error) { expect(String(error)).not.toContain(secret) }
    for (const whitespaceSecret of [" token", "token ", "\ttoken", "token\n"]) {
      expect(() => parseLocalProviderConfiguration({ WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: whitespaceSecret, VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" }, "/users/test")).toThrow("VERCEL_TOKEN")
      expect(() => deriveProviderConfigurationId({ kind: "vercel", config: { apiOrigin: "https://api.vercel.com", token: whitespaceSecret, teamId: "team", projectId: "project", polling: { intervalMs: 1000, timeoutMs: 120000, requestTimeoutMs: 30000 } } })).toThrow("credential")
    }
  })

  test("configured Vercel composition traverses embedded authentication, API, SQLite, core, and the shared runtime", async () => {
    const originalFetch = globalThis.fetch
    const commands = new Map<string, string>()
    const commandCwds = new Map<string, string | undefined>()
    let createdSandbox: { name: string; tags: Record<string, string> } | undefined
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url), path = url.pathname
      if (request.method === "POST" && path === "/v4/sandboxes") {
        const body = await request.json() as { name: string; tags: Record<string, string> }
        createdSandbox = { name: body.name, tags: body.tags }
        return Response.json({ sandbox: { name: body.name, currentSessionId: "session-1", status: "running", tags: body.tags }, session: { id: "session-1", projectId: "project" } })
      }
      if (request.method === "GET" && path.startsWith("/v2/sandboxes/") && !path.includes("/sessions/")) return Response.json({ sandbox: { name: createdSandbox?.name, currentSessionId: "session-1", status: "running", tags: createdSandbox?.tags }, session: { id: "session-1", projectId: "project" } })
      if (request.method === "POST" && path.endsWith("/cmd")) { const body = await request.json() as { args: string[]; cwd?: string }; const id = `command-${commands.size + 1}`; commands.set(id, body.args[1] ?? ""); commandCwds.set(id, body.cwd); return Response.json({ command: { id, sessionId: "session-1", exitCode: null } }) }
      if (request.method === "GET" && /\/cmd\/command-\d+$/.test(path)) { const id = path.split("/").at(-1)!; return Response.json({ command: { id, sessionId: "session-1", exitCode: 0 } }) }
      if (request.method === "GET" && path.endsWith("/logs")) { const id = path.split("/").at(-2)!; return new Response(JSON.stringify({ stream: "stdout", data: id === "command-1" ? "" : "waterbox-bootstrap-ok\n" }) + "\n", { headers: { "content-type": "application/x-ndjson" } }) }
      throw new Error(`unexpected Vercel request ${request.method} ${path}`)
    }) as typeof fetch
    try {
      const backend = await createEmbeddedApiBackend(vercelConfig(":memory:"), { clock: new FixedClock(), ids: new SequenceIdGenerator([sandboxId]) })
      const client = new WaterboxClient(backend)
      cleanup.push(() => client.close())
      const created = await client.createSandbox({}, { idempotencyKey: "configured-vercel", signal: new AbortController().signal })
      expect(created).toMatchObject({ sandboxId, provider: "vercel", state: "running" })
      expect([...commands.values()].some(script => script.includes("waterbox-bootstrap"))).toBeTrue()
      expect(commandCwds.get("command-1")).toBe("/")
      expect(commandCwds.get("command-2")).toBe("/workspace")
    } finally { globalThis.fetch = originalFetch }
  })

  test("injected selection needs no Box configuration or artifact and validates before filesystem effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "waterbox-local-injected-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const parent = join(root, "must-not-exist")
    const invalid = { ...new FakeSandboxProvider(), name: "invalid", prepareSandbox: undefined }
    await expect(createLocalControlPlane(config(join(parent, "db.sqlite"), invalid as never), resolver)).rejects.toThrow("provider is invalid")
    await expect(access(parent)).rejects.toBeDefined()
  })

  test("propagates redacted Box diagnostics through the local composition boundary", async () => {
    const diagnostics: Array<Parameters<NonNullable<LocalControlPlaneConfig["diagnostic"]>>[0]> = []
    const config = boxConfig(":memory:")
    if (config.provider.kind !== "box") throw new Error("Expected Box test configuration")
    config.provider.runtimeArtifact.bytes = new TextEncoder().encode("#!/usr/bin/env node\n")
    config.provider.runtimeArtifact.sha256 = createHash("sha256").update(config.provider.runtimeArtifact.bytes).digest("hex")
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.endsWith("/boxes")) return new Response(JSON.stringify({ ok: true, type: "box.created", status: "ready", box: { id: "bx_23456789", state: "ready" } }), { status: 202, headers: { "content-type": "application/json" } })
      return new Response(JSON.stringify({ ok: true, type: "command.finished", success: true, exitCode: 0, stdout: "waterbox-bootstrap-ok\n", stderr: "", timedOut: false }), { headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      const plane = await createLocalControlPlane({ ...config, diagnostic: event => diagnostics.push(event) }, resolver)
      cleanup.push(() => plane.close())
      const response = await plane.fetch(authenticated("/v1/sandboxes", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "diagnostic" }, body: "{}" }))
      expect(response.status, await response.clone().text()).toBe(201)
      expect(diagnostics).toContainEqual({ type: "preparation", stage: "verify", outcome: "complete" })
      expect(JSON.stringify(diagnostics)).not.toContain("test-placeholder")
    } finally { globalThis.fetch = originalFetch }
  })

  test("an opened store is closed once when later construction fails", async () => {
    let closes = 0
    const provider = new FakeSandboxProvider()
    const invalidStore = {
      sandboxes: undefined,
      get snapshots(): never { throw new Error("construction failed") },
      idempotency: undefined,
      close() { closes++ },
    }
    await expect(createLocalControlPlane(config(":memory:", provider), resolver, {
      createStore: () => invalidStore as never,
    })).rejects.toThrow("construction failed")
    expect(closes).toBe(1)
  })

  test("close is idempotent and cancellation crosses the Fetch boundary", async () => {
    let opens = 0
    let closes = 0
    const plane = await createLocalControlPlane(config(":memory:"), resolver, {
      createStore(path) {
        opens++
        const store = new SqliteRepositoryStore(path, { create: true })
        const original = store.close.bind(store)
        store.close = () => { closes++; original() }
        return store
      },
    })
    const controller = new AbortController()
    controller.abort(new DOMException("cancelled", "AbortError"))
    await expect(plane.fetch(new Request("http://waterbox.local/v1/sandboxes", {
      headers: { authorization: `Bearer ${credential}` }, signal: controller.signal,
    }))).rejects.toMatchObject({ name: "AbortError" })
    await plane.close()
    await plane.close()
    expect(opens).toBe(1)
    expect(closes).toBe(1)
  })
})
