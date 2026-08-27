import { describe, expect, test } from "bun:test"
import { DomainError } from "@waterbox/core"
import { createWaterboxApi, type WaterboxCore } from "../src/index.ts"

const sandbox = {
  sandboxId: "sbx_calm-cactus-7k3m",
  provider: "fake",
  state: "running" as const,
  version: 1,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
}
const snapshot = {
  snapshotId: "snap_silver-forest-2p9x",
  provider: "fake",
  sourceSandboxId: sandbox.sandboxId,
  state: "ready" as const,
  version: 1,
  createdAt: sandbox.createdAt,
  updatedAt: sandbox.updatedAt,
}

function api(overrides: Partial<Record<keyof WaterboxCore, Function>> = {}, credential = "good") {
  const calls: Array<[string, ...unknown[]]> = []
  const method = (name: string, value: unknown) => async (...args: unknown[]) => {
    calls.push([name, ...args])
    return value
  }
  const core = {
    createSandbox: method("createSandbox", sandbox),
    getSandbox: method("getSandbox", sandbox),
    listSandboxes: method("listSandboxes", { items: [sandbox] }),
    stopSandbox: method("stopSandbox", { ...sandbox, state: "stopped" }),
    resumeSandbox: method("resumeSandbox", sandbox),
    deleteSandbox: method("deleteSandbox", { ...sandbox, state: "terminated" }),
    createSnapshot: method("createSnapshot", snapshot),
    getSnapshot: method("getSnapshot", snapshot),
    listSnapshots: method("listSnapshots", { items: [snapshot] }),
    deleteSnapshot: method("deleteSnapshot", { ...snapshot, state: "deleted" }),
    executeTool: method("executeTool", (async function* () {
      yield { type: "result", title: "read", output: "ok", metadata: { filePath: "/workspace/a", offset: 1 } }
    })()),
    ...overrides,
  } as unknown as WaterboxCore
  return {
    app: createWaterboxApi({
      core,
      identityResolver: { async resolveBearer(value) { return value === credential ? { accountId: "acct_test" } : undefined } },
      generateRequestId: () => "req_test",
    }),
    calls,
  }
}

const auth = { authorization: "Bearer good" }
const jsonHeaders = { ...auth, "content-type": "application/json" }

describe("Waterbox API", () => {
  test("exposes health and propagates or generates safe request IDs", async () => {
    const { app } = api()
    const supplied = await app.request("/health", { headers: { "x-request-id": "caller-1" } })
    expect(supplied.status).toBe(200)
    expect(supplied.headers.get("x-request-id")).toBe("caller-1")
    expect(await supplied.json()).toEqual({ status: "ok" })
    const unsafe = await app.request("/health", { headers: { "x-request-id": "secret value" } })
    expect(unsafe.headers.get("x-request-id")).toBe("req_test")
  })

  test("rejects missing, malformed, and unknown bearer credentials", async () => {
    const { app } = api()
    for (const authorization of [undefined, "Basic good", "Bearer", "Bearer bad", "Bearer good extra"]) {
      const response = await app.request("/v1/sandboxes", { headers: authorization === undefined ? {} : { authorization } })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String), requestId: "req_test" } })
    }
  })

  test("dispatches every canonical resource route with resolved identity", async () => {
    const { app, calls } = api()
    const cases: Array<[string, string, RequestInit, number]> = [
      ["createSandbox", "/v1/sandboxes", { method: "POST", headers: { ...jsonHeaders, "idempotency-key": "idem-1" }, body: "{}" }, 201],
      ["listSandboxes", "/v1/sandboxes?limit=10", { headers: auth }, 200],
      ["getSandbox", `/v1/sandboxes/${sandbox.sandboxId}`, { headers: auth }, 200],
      ["stopSandbox", `/v1/sandboxes/${sandbox.sandboxId}/stop`, { method: "POST", headers: auth }, 200],
      ["resumeSandbox", `/v1/sandboxes/${sandbox.sandboxId}/resume`, { method: "POST", headers: auth }, 200],
      ["deleteSandbox", `/v1/sandboxes/${sandbox.sandboxId}`, { method: "DELETE", headers: auth }, 200],
      ["createSnapshot", `/v1/sandboxes/${sandbox.sandboxId}/snapshots`, { method: "POST", headers: jsonHeaders, body: "{}" }, 201],
      ["listSnapshots", "/v1/snapshots?limit=10", { headers: auth }, 200],
      ["getSnapshot", `/v1/snapshots/${snapshot.snapshotId}`, { headers: auth }, 200],
      ["deleteSnapshot", `/v1/snapshots/${snapshot.snapshotId}`, { method: "DELETE", headers: auth }, 200],
    ]
    for (const [name, path, init, status] of cases) {
      const response = await app.request(path, init)
      expect(response.status, `${name}: ${await response.clone().text()}`).toBe(status)
      expect(calls.at(-1)?.[0]).toBe(name)
      expect(calls.at(-1)?.[1]).toEqual({ accountId: "acct_test" })
    }
    const create = calls.find(([name]) => name === "createSandbox")!
    expect(create[3]).toMatchObject({ idempotencyKey: "idem-1", signal: expect.any(AbortSignal) })
  })

  test("strictly rejects malformed paths, queries, bodies, and tool/body mismatches", async () => {
    const { app } = api()
    const requests = [
      app.request("/v1/sandboxes?limit=0", { headers: auth }),
      app.request("/v1/sandboxes?unknown=x", { headers: auth }),
      app.request("/v1/sandboxes/not-an-id", { headers: auth }),
      app.request("/v1/sandboxes", { method: "POST", headers: jsonHeaders, body: '{"unknown":true}' }),
      app.request(`/v1/sandboxes/${sandbox.sandboxId}/snapshots`, { method: "POST", headers: jsonHeaders, body: '{"unknown":true}' }),
      app.request(`/v1/sandboxes/${sandbox.sandboxId}/tools/read`, { method: "POST", headers: jsonHeaders, body: '{"command":"pwd"}' }),
      app.request(`/v1/sandboxes/${sandbox.sandboxId}/tools/unknown`, { method: "POST", headers: jsonHeaders, body: "{}" }),
    ]
    for (const pending of requests) expect((await pending).status).toBe(400)
  })

  test("maps domain errors to stable, secret-safe envelopes", async () => {
    const secret = "protected.example/_token=never-leak"
    const { app } = api({ getSandbox: async () => { throw new DomainError("not_found", secret) } })
    const response = await app.request(`/v1/sandboxes/${sandbox.sandboxId}`, { headers: auth })
    expect(response.status).toBe(404)
    const text = await response.text()
    expect(text).not.toContain(secret)
    expect(JSON.parse(text)).toEqual({ error: { code: "not_found", message: "The resource was not found", requestId: "req_test" } })
  })

  test("rejects non-canonical core output without serializing internal fields", async () => {
    const leaked = { ...sandbox, accountId: "acct_secret", providerRef: { url: "protected-secret" } }
    const { app } = api({ getSandbox: async () => leaked })
    const response = await app.request(`/v1/sandboxes/${sandbox.sandboxId}`, { headers: auth })
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).not.toContain("acct_secret")
    expect(text).not.toContain("protected-secret")
  })

  test("streams NDJSON incrementally and cancellation reaches core", async () => {
    let release!: () => void
    let signal!: AbortSignal
    const gate = new Promise<void>((resolve) => { release = resolve })
    const events = async function* () {
      yield { type: "stdout", data: "first" }
      await gate
      yield { type: "result", title: "bash", output: "", metadata: { command: "x", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } }
    }
    const { app } = api({ executeTool: async (...args: unknown[]) => { signal = args.at(-1) as AbortSignal; return events() } })
    const response = await app.request(`/v1/sandboxes/${sandbox.sandboxId}/tools/bash`, { method: "POST", headers: jsonHeaders, body: '{"command":"x"}' })
    expect(response.headers.get("content-type")).toContain("application/x-ndjson")
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('{"type":"stdout","data":"first"}\n')
    expect(signal.aborted).toBeFalse()
    const cancelling = reader.cancel("client gone")
    expect(signal.aborted).toBeTrue()
    release()
    await cancelling
  })

  test("generates deterministic OpenAPI 3.1 with every route, auth, errors, and NDJSON", async () => {
    const { app } = api()
    const first = await (await app.request("/openapi.json")).text()
    const second = await (await app.request("/openapi.json")).text()
    expect(first).toBe(second)
    const document = JSON.parse(first)
    expect(document.openapi).toBe("3.1.0")
    for (const path of ["/health", "/openapi.json", "/v1/sandboxes", "/v1/sandboxes/{sandboxId}", "/v1/sandboxes/{sandboxId}/stop", "/v1/sandboxes/{sandboxId}/resume", "/v1/sandboxes/{sandboxId}/snapshots", "/v1/snapshots", "/v1/snapshots/{snapshotId}", "/v1/sandboxes/{sandboxId}/tools/{toolName}"]) {
      expect(document.paths[path], path).toBeDefined()
    }
    expect(document.components.securitySchemes.bearerAuth).toEqual({ type: "http", scheme: "bearer" })
    expect(document.paths["/v1/sandboxes/{sandboxId}/tools/{toolName}"].post.responses[200].content["application/x-ndjson"]).toBeDefined()
    expect(document.paths["/v1/sandboxes"].post.responses[401]).toBeDefined()
  })
})
