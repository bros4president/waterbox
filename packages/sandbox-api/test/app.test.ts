import { describe, expect, test } from "bun:test"
import { DomainError, SandboxRecoveryError, SandboxService } from "@waterbox/core"
import { MAX_SECURE_CIPHERTEXT_BASE64_LENGTH, type SandboxId } from "@waterbox/contracts"
import { FakeSandboxProvider, FixedClock, InMemoryIdempotencyRepository, InMemorySandboxRepository, InMemorySnapshotRepository, SequenceIdGenerator } from "@waterbox/core/test-support"
import { createWaterboxApi, type IdentityResolver, type WaterboxCore } from "../src/index.ts"

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

function api(
  overrides: Partial<Record<keyof WaterboxCore, Function>> = {},
  credential = "good",
  identityResolver: IdentityResolver = { async resolveBearer(value: string) { return value === credential ? { accountId: "acct_test" } : undefined } },
) {
  const calls: Array<[string, ...unknown[]]> = []
  const method = (name: string, value: unknown) => async (...args: unknown[]) => {
    calls.push([name, ...args])
    return value
  }
  const core = {
    createSandbox: method("createSandbox", sandbox),
    getSandbox: method("getSandbox", sandbox),
    probeSandbox: method("probeSandbox", sandbox),
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
    observeBashJob: method("observeBashJob", { jobId: `job_${"a".repeat(32)}`, state: "running", chunkBase64: "", nextOffset: 0, outputSize: 0 }),
    cleanupBashJob: method("cleanupBashJob", undefined),
    executeTool: method("executeTool", (async function* () {
      yield { type: "result", title: "read", output: "ok", metadata: { filePath: "/workspace/a", offset: 1 } }
    })()),
    ...overrides,
  } as unknown as WaterboxCore
  return {
    app: createWaterboxApi({
      core,
      identityResolver,
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

  test("preserves cancellation before routing and during asynchronous bearer resolution", async () => {
    const preAbort = new AbortController()
    const preReason = new DOMException("caller left", "AbortError")
    preAbort.abort(preReason)
    const { app } = api()
    await expect(app.fetch(new Request("http://localhost/v1/sandboxes", { headers: auth, signal: preAbort.signal }))).rejects.toBe(preReason)

    const resolving = new AbortController()
    const duringReason = new DOMException("authentication cancelled", "AbortError")
    const during = api({}, "good", {
      async resolveBearer(_value: string, signal: AbortSignal) {
        return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
      },
    }).app.fetch(new Request("http://localhost/v1/sandboxes", { headers: auth, signal: resolving.signal }))
    await Promise.resolve()
    resolving.abort(duringReason)
    await expect(during).rejects.toBe(duringReason)
  })

  test("preserves cancellation from core execution instead of fabricating an API envelope", async () => {
    const controller = new AbortController()
    const reason = new DOMException("provider cancelled", "AbortError")
    const { app } = api({
      getSandbox: async (...args: unknown[]) => {
        const signal = args.at(-1) as AbortSignal
        signal.throwIfAborted()
        return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
      },
    })
    const pending = app.fetch(new Request(`http://localhost/v1/sandboxes/${sandbox.sandboxId}`, { headers: auth, signal: controller.signal }))
    await Promise.resolve()
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  test("preserves cancellation while setting up a provider event stream", async () => {
    const controller = new AbortController()
    const reason = new DOMException("stream setup cancelled", "AbortError")
    const { app } = api({
      executeTool: async (...args: unknown[]) => {
        const signal = args.at(-1) as AbortSignal
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                signal.throwIfAborted()
                return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
              },
            }
          },
        }
      },
    })
    const pending = app.fetch(new Request(`http://localhost/v1/sandboxes/${sandbox.sandboxId}/tools/read`, { method: "POST", headers: jsonHeaders, body: '{"filePath":"a"}', signal: controller.signal }))
    await Promise.resolve()
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  test("dispatches every canonical resource route with resolved identity", async () => {
    const { app, calls } = api()
    const cases: Array<[string, string, RequestInit, number]> = [
      ["createSandbox", "/v1/sandboxes", { method: "POST", headers: { ...jsonHeaders, "idempotency-key": "idem-1" }, body: "{}" }, 201],
      ["listSandboxes", "/v1/sandboxes?limit=10", { headers: auth }, 200],
      ["getSandbox", `/v1/sandboxes/${sandbox.sandboxId}`, { headers: auth }, 200],
      ["probeSandbox", `/v1/sandboxes/${sandbox.sandboxId}/probe`, { method: "POST", headers: auth }, 200],
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

  test("keeps ordinary get distinct from active provider probe semantics", async () => {
    let gets = 0
    let probes = 0
    const { app } = api({
      getSandbox: async () => { gets++; return { ...sandbox, state: "preparing" } },
      probeSandbox: async () => { probes++; return sandbox },
    })
    const ordinary = await app.request(`/v1/sandboxes/${sandbox.sandboxId}`, { headers: auth })
    expect(await ordinary.json()).toMatchObject({ state: "preparing" })
    expect({ gets, probes }).toEqual({ gets: 1, probes: 0 })
    const probed = await app.request(`/v1/sandboxes/${sandbox.sandboxId}/probe`, { method: "POST", headers: auth })
    expect(await probed.json()).toMatchObject({ state: "running" })
    expect({ gets, probes }).toEqual({ gets: 1, probes: 1 })
  })

  test("preserves core probe reconciliation semantics across the authenticated API boundary", async () => {
    const sandboxes = new InMemorySandboxRepository()
    const provider = new FakeSandboxProvider()
    const core = new SandboxService({
      sandboxes,
      snapshots: new InMemorySnapshotRepository(),
      idempotency: new InMemoryIdempotencyRepository(),
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(),
    })
    const ids = {
      stable: "sbx_stable-cloud-a1",
      readyPreparation: "sbx_ready-cloud-a1",
      failedPreparation: "sbx_failed-cloud-a1",
      terminatedPreparation: "sbx_gone-cloud-a1",
      failedSticky: "sbx_sticky-cloud-a1",
      nullProvisioning: "sbx_null-cloud-a1",
      getProvisioning: "sbx_get-cloud-a1",
      probeProvisioning: "sbx_probe-cloud-a1",
    } as const
    const record = (sandboxId: string, state: "provisioning" | "preparing" | "running" | "failed", providerRef?: null | { privateSandboxId: string }) => ({
      accountId: "acct_test", sandboxId: sandboxId as SandboxId, provider: "fake", providerRef: providerRef === undefined ? { privateSandboxId: sandboxId } : providerRef, state,
      version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      ...(state === "failed" ? { lastError: { code: "provider_failure" as const, message: "A prior operation failed" } } : {}),
    })
    for (const [id, state, reference] of [
      [ids.stable, "running"], [ids.readyPreparation, "preparing"], [ids.failedPreparation, "preparing"],
      [ids.terminatedPreparation, "preparing"], [ids.failedSticky, "failed"], [ids.nullProvisioning, "provisioning", null],
      [ids.getProvisioning, "provisioning"], [ids.probeProvisioning, "provisioning"],
    ] as const) await sandboxes.createIfAbsent(record(id, state, reference))
    provider.sandboxStates.set(ids.stable, "stopped")
    provider.sandboxStates.set(ids.readyPreparation, "running")
    provider.sandboxStates.set(ids.failedPreparation, "failed")
    provider.sandboxStates.set(ids.terminatedPreparation, "terminated")
    provider.sandboxStates.set(ids.failedSticky, "running")
    provider.sandboxStates.set(ids.getProvisioning, "running")
    provider.sandboxStates.set(ids.probeProvisioning, "running")
    const app = createWaterboxApi({ core, identityResolver: { async resolveBearer() { return { accountId: "acct_test" } } }, generateRequestId: () => "req_test" })
    const get = (id: string) => app.request(`/v1/sandboxes/${id}`, { headers: auth })
    const probe = (id: string) => app.request(`/v1/sandboxes/${id}/probe`, { method: "POST", headers: auth })

    expect((await (await get(ids.readyPreparation)).json()).state).toBe("preparing")
    expect(provider.inspectSandboxCalls).toBe(0)
    expect((await (await probe(ids.stable)).json()).state).toBe("stopped")
    expect((await (await probe(ids.readyPreparation)).json()).state).toBe("preparing")
    expect((await (await probe(ids.failedPreparation)).json()).state).toBe("failed")
    expect((await (await probe(ids.terminatedPreparation)).json()).state).toBe("terminated")
    expect((await (await probe(ids.failedSticky)).json()).state).toBe("failed")
    expect((await (await probe(ids.nullProvisioning)).json()).state).toBe("provisioning")
    expect((await (await get(ids.getProvisioning)).json()).state).toBe("running")
    expect((await (await probe(ids.probeProvisioning)).json()).state).toBe("running")
    expect(provider.prepareCalls).toBe(2)
    provider.sandboxStates.set(ids.failedSticky, "terminated")
    expect((await (await probe(ids.failedSticky)).json()).state).toBe("terminated")
  })

  test("keeps cross-account probe and Bash job access non-revealing", async () => {
    const owned = (identity: unknown) => {
      if ((identity as { accountId?: string }).accountId !== "acct_owner") throw new DomainError("not_found", "private ownership detail")
      return sandbox
    }
    const resolver: IdentityResolver = { async resolveBearer(value) { return value === "owner" ? { accountId: "acct_owner" } : value === "other" ? { accountId: "acct_other" } : undefined } }
    const { app } = api({
      probeSandbox: async (identity: unknown) => owned(identity),
      observeBashJob: async (identity: unknown) => owned(identity),
      cleanupBashJob: async (identity: unknown) => { owned(identity) },
    }, "owner", resolver)
    const other = { authorization: "Bearer other", "content-type": "application/json" }
    const jobId = `job_${"a".repeat(32)}`
    for (const [path, init] of [
      [`/v1/sandboxes/${sandbox.sandboxId}/probe`, { method: "POST", headers: other }],
      [`/v1/sandboxes/${sandbox.sandboxId}/bash-jobs/${jobId}/observations`, { method: "POST", headers: other, body: '{"offset":0,"maxBytes":1}' }],
      [`/v1/sandboxes/${sandbox.sandboxId}/bash-jobs/${jobId}`, { method: "DELETE", headers: other }],
    ] as const) {
      const response = await app.request(path, init)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: { code: "not_found", message: "The resource was not found", requestId: "req_test" } })
    }
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
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
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

  test("includes only the public sandbox recovery ID for post-checkpoint failures", async () => {
    const secret = "private provider detail"
    const recovery = new SandboxRecoveryError(new DomainError("provider_failure", secret), sandbox.sandboxId)
    const { app } = api({ createSandbox: async () => { throw recovery } })

    const response = await app.request("/v1/sandboxes", { method: "POST", headers: jsonHeaders, body: "{}" })
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(text).not.toContain(secret)
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "provider_failure",
        message: "The provider operation failed",
        requestId: "req_test",
        sandboxId: sandbox.sandboxId,
      },
    })
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
        statusPath: `/run/waterbox/bash-jobs/job_${"a".repeat(32)}/status.json`,
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

  test("authenticates, validates, and forwards canonical Bash job primitives", async () => {
    const jobId = `job_${"a".repeat(32)}`
    const { app, calls } = api()
    const path = `/v1/sandboxes/${sandbox.sandboxId}/bash-jobs/${jobId}`

    expect((await app.request(`${path}/observations`, { method: "POST", headers: jsonHeaders, body: '{"offset":3,"maxBytes":64}' })).status).toBe(200)
    expect((await app.request(path, { method: "DELETE", headers: auth })).status).toBe(204)
    expect(calls.filter(([name]) => name === "observeBashJob" || name === "cleanupBashJob").map(([name, identity, sandboxId, observedJobId, ...rest]) => [name, identity, sandboxId, observedJobId, ...rest.slice(0, name === "observeBashJob" ? 2 : 0)])).toEqual([
      ["observeBashJob", { accountId: "acct_test" }, sandbox.sandboxId, jobId, 3, 64],
      ["cleanupBashJob", { accountId: "acct_test" }, sandbox.sandboxId, jobId],
    ])
    expect((await app.request(`${path}/observations`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"offset":0,"maxBytes":1}' })).status).toBe(401)
    for (const body of ['{"offset":-1,"maxBytes":64}', '{"offset":0,"maxBytes":65537}', '{"offset":0,"maxBytes":1,"extra":true}', '{']) {
      const malformed = await app.request(`${path}/observations`, { method: "POST", headers: jsonHeaders, body })
      expect(malformed.status, body).toBe(400)
      expect(await malformed.json()).toMatchObject({ error: { code: "invalid_request" } })
    }
    expect((await app.request(`/v1/internal/sandboxes/${sandbox.sandboxId}/bash-jobs/${jobId}/observe`, { method: "POST", headers: jsonHeaders, body: '{"offset":0,"maxBytes":1}' })).status).toBe(404)
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
    for (const path of ["/health", "/openapi.json", "/v1/sandboxes", "/v1/sandboxes/{sandboxId}", "/v1/sandboxes/{sandboxId}/probe", "/v1/sandboxes/{sandboxId}/stop", "/v1/sandboxes/{sandboxId}/resume", "/v1/sandboxes/{sandboxId}/snapshots", "/v1/snapshots", "/v1/snapshots/{snapshotId}", "/v1/sandboxes/{sandboxId}/tools/{toolName}", "/v1/sandboxes/{sandboxId}/bash-jobs/{jobId}/observations", "/v1/sandboxes/{sandboxId}/bash-jobs/{jobId}"]) {
      expect(document.paths[path], path).toBeDefined()
    }
    expect(document.components.securitySchemes.bearerAuth).toEqual({ type: "http", scheme: "bearer" })
    expect(document.paths["/v1/sandboxes/{sandboxId}/tools/{toolName}"].post.responses[200].content["application/x-ndjson"]).toBeDefined()
    expect(document.paths["/v1/sandboxes"].post.responses[401]).toBeDefined()
    expect(first).toContain('"preparing"')
    expect(first).toContain('"sandboxId"')
    expect(first).not.toContain("providerRef")
  })
})
