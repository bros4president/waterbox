import { describe, expect, test } from "bun:test"
import { DomainError } from "@waterbox/core"
import { MAX_SECURE_CIPHERTEXT_BASE64_LENGTH } from "@waterbox/contracts"
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
const transfer = { transferId: "123e4567-e89b-42d3-a456-426614174000", publicKey: `age1${"q".repeat(58)}`, algorithm: "age-x25519" as const, expiresAt: "2026-08-29T00:10:00.000Z" }
const delivery = { transferId: transfer.transferId, targetPath: "/root/.aws/credentials", bytes: 6 }

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
    initiateSecureFileTransfer: method("initiateSecureFileTransfer", transfer),
    consumeSecureFileTransfer: method("consumeSecureFileTransfer", delivery),
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
      ["initiateSecureFileTransfer", `/v1/sandboxes/${sandbox.sandboxId}/secure-file-transfers`, { method: "POST", headers: auth }, 201],
      ["consumeSecureFileTransfer", `/v1/sandboxes/${sandbox.sandboxId}/secure-file-transfers/${transfer.transferId}`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ targetPath: delivery.targetPath, ciphertext: "Y2lwaGVy" }) }, 200],
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

  test("bounds secure transfer JSON before dispatch and never echoes ciphertext", async () => {
    const { app, calls } = api()
    const oversized = JSON.stringify({ targetPath: "secret", ciphertext: "A".repeat(MAX_SECURE_CIPHERTEXT_BASE64_LENGTH + 9_000) })
    const rejected = await app.request(`/v1/sandboxes/${sandbox.sandboxId}/secure-file-transfers/${transfer.transferId}`, { method: "PUT", headers: jsonHeaders, body: oversized })
    expect(rejected.status).toBe(413)
    expect(calls.some(([name]) => name === "consumeSecureFileTransfer")).toBe(false)

    const secretCiphertext = Buffer.from("not-plaintext-secret").toString("base64")
    const accepted = await app.request(`/v1/sandboxes/${sandbox.sandboxId}/secure-file-transfers/${transfer.transferId}`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ targetPath: delivery.targetPath, ciphertext: secretCiphertext }) })
    expect(accepted.status).toBe(200)
    expect(await accepted.text()).not.toContain(secretCiphertext)
  })

  test("bounds chunked transfer bodies, rejects malformed lengths, and cancels aborted reads", async () => {
    const { app } = api()
    const url = `http://localhost/v1/sandboxes/${sandbox.sandboxId}/secure-file-transfers/${transfer.transferId}`
    const maximum = MAX_SECURE_CIPHERTEXT_BASE64_LENGTH + 8_192
    const request = (body: ReadableStream<Uint8Array>, extra: RequestInit = {}) => new Request(url, {
      method: "PUT", headers: jsonHeaders, body, duplex: "half", ...extra,
    } as RequestInit & { duplex: "half" })

    const exact = await app.fetch(request(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(maximum)); controller.close() } })))
    expect(exact.status).toBe(400)

    let overflowCancelled = false
    const overflow = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(maximum)); controller.enqueue(new Uint8Array(1)) },
      cancel() { overflowCancelled = true },
    })
    expect((await app.fetch(request(overflow))).status).toBe(413)
    expect(overflowCancelled).toBeTrue()

    let malformedCancelled = false
    const malformed = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1)) }, cancel() { malformedCancelled = true } })
    expect((await app.fetch(request(malformed, { headers: { ...jsonHeaders, "content-length": "invalid" } }))).status).toBe(400)
    expect(malformedCancelled).toBeTrue()

    let abortedCancelled = false
    const controller = new AbortController()
    const stalled = new ReadableStream<Uint8Array>({ cancel() { abortedCancelled = true } })
    const pending = app.fetch(request(stalled, { signal: controller.signal }))
    await Promise.resolve()
    controller.abort(new DOMException("client left", "AbortError"))
    expect((await pending).status).toBe(400)
    expect(abortedCancelled).toBeTrue()
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
      yield { type: "result", outcome: "completed", title: "bash", output: "", metadata: { command: "x", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } }
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

  test("forwards a dispatched bash receipt unchanged", async () => {
    const receipt = {
      type: "result", outcome: "dispatched", title: "Bash command dispatched", output: "Command dispatched. statusPath reports execution state, and outputPath receives output continuously. Repeated output reads can duplicate tokens and pollute context.",
      metadata: {
        command: "sleep 20", workdir: "/workspace", timeout: 20_000,
        jobId: `job_${"a".repeat(32)}`,
        outputPath: `/run/waterbox/bash-jobs/job_${"a".repeat(32)}/output.log`,
        statusPath: `/run/waterbox/bash-jobs/job_${"a".repeat(32)}/status.json`, pollAfterMs: 2_000,
      },
    } as const
    const events = async function* () { yield receipt }
    const { app } = api({ executeTool: async () => events() })

    const response = await app.request(`/v1/sandboxes/${sandbox.sandboxId}/tools/bash`, { method: "POST", headers: jsonHeaders, body: '{"command":"sleep 20","timeout":20000}' })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body.endsWith("\n")).toBeTrue()
    expect(JSON.parse(body)).toEqual(receipt)
  })

  test("returns a normal error envelope when the provider fails before its first event", async () => {
    const { app } = api({ executeTool: async () => ({ async *[Symbol.asyncIterator]() { throw new DomainError("ambiguous_execution", "unknown") } }) })
    const response = await app.request(`/v1/sandboxes/${sandbox.sandboxId}/tools/read`, { method: "POST", headers: jsonHeaders, body: '{"filePath":"x"}' })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: "ambiguous_execution" } })
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
