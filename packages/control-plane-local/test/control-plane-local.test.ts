import { afterEach, describe, expect, test } from "bun:test"
import { WaterboxClient } from "@waterbox/client"
import { FixedClock, FakeSandboxProvider, SequenceIdGenerator } from "@waterbox/core/test-support"
import { SqliteRepositoryStore } from "@waterbox/repository-sqlite"
import type { IdentityResolver } from "@waterbox/api"
import { access, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEmbeddedApiBackend, createLocalControlPlane, type LocalControlPlaneConfig } from "../src/index.ts"

const accountId = "acct_local_control_plane_test"
const sandboxId = "sbx_calm-cactus-7k3m"
const credential = "raw-development-credential"
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function config(sqlitePath: string): LocalControlPlaneConfig {
  return {
    sqlitePath,
    accountId,
    provider: "box",
    box: { apiBaseUrl: "https://box.invalid/v1", apiKey: "test-placeholder", polling: { intervalMs: 1, timeoutMs: 2 } },
    runtimeArtifact: { bytes: new Uint8Array([1]), sha256: "0".repeat(64), cliProtocolVersion: 2, artifactVersion: "test" },
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
  test("raw API authentication is enforced without a listener", async () => {
    const plane = await createLocalControlPlane(config(":memory:"), resolver, { provider: new FakeSandboxProvider() })
    cleanup.push(() => plane.close())
    expect((await plane.fetch(new Request("http://waterbox.local/v1/sandboxes"))).status).toBe(401)
    expect((await plane.fetch(new Request("http://waterbox.local/v1/sandboxes", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401)
    expect((await plane.fetch(authenticated("/v1/sandboxes"))).status).toBe(200)
  })

  test("embedded client traverses API and replaces external Authorization", async () => {
    const provider = new FakeSandboxProvider()
    const backend = await createEmbeddedApiBackend(config(":memory:"), {
      provider,
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
    const first = await createLocalControlPlane(config(sqlitePath), resolver, {
      provider,
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

    const second = await createLocalControlPlane(config(sqlitePath), resolver, { provider })
    cleanup.push(() => second.close())
    const listed = await (await second.fetch(authenticated("/v1/sandboxes"))).json()
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0].sandboxId).toBe(sandboxId)
  })

  test("selection and artifact failures precede filesystem and SQLite effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "waterbox-local-invalid-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const parent = join(root, "must-not-exist")
    const selected = config(join(parent, "db.sqlite"))

    await expect(createLocalControlPlane({ ...selected, provider: undefined } as unknown as LocalControlPlaneConfig, resolver)).rejects.toThrow("provider selection")
    await expect(createLocalControlPlane({ ...selected, runtimeArtifact: { ...selected.runtimeArtifact, sha256: "invalid" } }, resolver)).rejects.toThrow("artifact")
    await expect(access(parent)).rejects.toBeDefined()
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
    await expect(createLocalControlPlane(config(":memory:"), resolver, {
      provider,
      createStore: () => invalidStore as never,
    })).rejects.toThrow("construction failed")
    expect(closes).toBe(1)
  })

  test("close is idempotent and cancellation crosses the Fetch boundary", async () => {
    let opens = 0
    let closes = 0
    const plane = await createLocalControlPlane(config(":memory:"), resolver, {
      provider: new FakeSandboxProvider(),
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
