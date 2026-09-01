import { describe, expect, test } from "bun:test"
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption"
import {
  MAX_API_ERROR_RESPONSE_BYTES,
  MAX_API_JSON_RESPONSE_BYTES,
  MAX_API_NDJSON_LINE_BYTES,
  MAX_API_NDJSON_TOTAL_BYTES,
  WaterboxClient,
  WaterboxClientError,
  createRemoteApiBackend,
  type ApiBackend,
} from "../src/index.ts"

const sandboxId = "sbx_calm-river-a1"
const snapshotId = "snap_blue-lake-b2"
const timestamp = "2026-09-01T00:00:00.000Z"
const sandbox = (state = "running") => ({ sandboxId, provider: "box", state, version: 1, createdAt: timestamp, updatedAt: timestamp })
const snapshot = { snapshotId, provider: "box", sourceSandboxId: sandboxId, state: "ready", version: 1, createdAt: timestamp, updatedAt: timestamp }
const signal = new AbortController().signal

class FakeBackend implements ApiBackend {
  readonly origin = new URL("https://api.waterbox.test/")
  requests: Request[] = []
  closeCalls = 0
  constructor(readonly respond: (request: Request, index: number) => Response | Promise<Response>) {}
  fetch(request: Request): Promise<Response> {
    this.requests.push(request)
    return Promise.resolve(this.respond(request, this.requests.length - 1))
  }
  async close() { this.closeCalls += 1 }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}
function ndjson(...values: unknown[]): Response {
  return new Response(values.map(value => `${JSON.stringify(value)}\n`).join(""), { headers: { "content-type": "application/x-ndjson" } })
}

describe("remote backend", () => {
  test("validates a root HTTP(S) origin", () => {
    const fetcher = async () => new Response()
    for (const origin of ["ftp://api.test/", "https://user@api.test/", "https://api.test/path", "https://api.test/?q=1", "https://api.test/#x"])
      expect(() => createRemoteApiBackend(origin, fetcher)).toThrow()
    expect(createRemoteApiBackend("https://api.test/", fetcher).origin.href).toBe("https://api.test/")
  })

  test("passes the same Request and signal without retry and closes idempotently", async () => {
    let seen: Request | undefined
    let calls = 0
    const backend = createRemoteApiBackend("https://api.test/", async request => { calls += 1; seen = request; return json(sandbox()) })
    const client = new WaterboxClient(backend)
    await client.probeSandbox({ sandboxId }, { signal })
    expect(calls).toBe(1)
    expect(seen?.signal).toBe(signal)
    await Promise.all([client.close(), client.close()])
    await expect(client.probeSandbox({ sandboxId }, { signal })).rejects.toBeInstanceOf(WaterboxClientError)
  })

  test("does not expose or consume a mutable origin reference", async () => {
    const backend = createRemoteApiBackend("https://api.test/", async request => json({ ...sandbox(), sandboxId: new URL(request.url).pathname.includes("evil") ? "invalid" : sandboxId }))
    const exposed = backend.origin
    exposed.pathname = "/evil/"
    expect(backend.origin.href).toBe("https://api.test/")
    const client = new WaterboxClient(backend)
    const later = backend.origin
    later.pathname = "/evil/"
    expect((await client.probeSandbox({ sandboxId }, { signal })).sandboxId).toBe(sandboxId)

    const shared = new URL("https://other.test/")
    const custom = new FakeBackend(() => json(sandbox()))
    Object.defineProperty(custom, "origin", { value: shared })
    const snapshotted = new WaterboxClient(custom)
    shared.pathname = "/evil/"; shared.username = "credential"; shared.search = "?token=secret"
    await snapshotted.probeSandbox({ sandboxId }, { signal })
    expect(custom.requests[0]!.url).toBe(`https://other.test/v1/sandboxes/${sandboxId}/probe`)
  })
})

describe("simple commands", () => {
  test("use canonical methods, paths, bodies, query and idempotency", async () => {
    const replies = [sandbox(), sandbox("preparing"), sandbox("terminated"), { items: [snapshot] }, snapshot, { ...snapshot, state: "deleted" }]
    const backend = new FakeBackend((_, index) => json(replies[index], index === 0 || index === 4 ? 201 : 200))
    const client = new WaterboxClient(backend)
    await client.createSandbox({}, { idempotencyKey: "key-1", signal })
    await client.probeSandbox({ sandboxId }, { signal })
    await client.deleteSandbox({ sandboxId }, { signal })
    await client.listSnapshots({ cursor: "next value", limit: 3 }, { signal })
    await client.createSnapshot({ sandboxId, name: "checkpoint" }, { signal })
    await client.deleteSnapshot({ snapshotId }, { signal })
    expect(backend.requests.map(request => `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)).toEqual([
      "POST /v1/sandboxes", `POST /v1/sandboxes/${sandboxId}/probe`, `DELETE /v1/sandboxes/${sandboxId}`,
      "GET /v1/snapshots?cursor=next+value&limit=3", `POST /v1/sandboxes/${sandboxId}/snapshots`, `DELETE /v1/snapshots/${snapshotId}`,
    ])
    expect(backend.requests[0]!.headers.get("idempotency-key")).toBe("key-1")
    expect(await backend.requests[4]!.json()).toEqual({ name: "checkpoint" })
  })

  test("close calls its backend exactly once", async () => {
    const backend = new FakeBackend(() => new Response())
    const client = new WaterboxClient(backend)
    await Promise.all([client.close(), client.close(), client.close()])
    expect(backend.closeCalls).toBe(1)
  })
})

describe("tool streams", () => {
  test("all simple tools decode their canonical terminal result from split NDJSON", async () => {
    const results = {
      read: { title: "Read", output: "x", metadata: { filePath: "/x", offset: 1 } },
      write: { title: "Write", output: "ok", metadata: { filePath: "/x", bytes: 1 } },
      edit: { title: "Edit", output: "ok", metadata: { filePath: "/x", replacements: 1, bytes: 1 } },
      patch: { title: "Patch", output: "ok", metadata: { added: [], updated: [], deleted: [], moved: [] } },
      glob: { title: "Glob", output: "x", metadata: { pattern: "*", path: "/", count: 1, truncated: false } },
      grep: { title: "Grep", output: "x", metadata: { pattern: "x", path: "/", matches: 1, truncated: false } },
    }
    const names = Object.keys(results) as (keyof typeof results)[]
    const backend = new FakeBackend((_, index) => {
      const bytes = new TextEncoder().encode(JSON.stringify({ type: "result", ...results[names[index]!] }) + "\n")
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 3)); controller.enqueue(bytes.slice(3)); controller.close() } }), { headers: { "content-type": "application/x-ndjson" } })
    })
    const client = new WaterboxClient(backend)
    expect(await client.read({ sandboxId, filePath: "/x" }, { signal })).toEqual(results.read)
    expect(await client.write({ sandboxId, filePath: "/x", content: "x" }, { signal })).toEqual(results.write)
    expect(await client.edit({ sandboxId, filePath: "/x", oldString: "a", newString: "b" }, { signal })).toEqual(results.edit)
    expect(await client.patch({ sandboxId, patchText: "x" }, { signal })).toEqual(results.patch)
    expect(await client.glob({ sandboxId, pattern: "*" }, { signal })).toEqual(results.glob)
    expect(await client.grep({ sandboxId, pattern: "x" }, { signal })).toEqual(results.grep)
    expect(backend.requests).toHaveLength(6)
  })

  test("rejects missing, malformed, and followed terminal results", async () => {
    const responses = [ndjson(), ndjson({ nope: true }), ndjson(
      { type: "result", title: "Read", output: "x", metadata: { filePath: "/x", offset: 1 } },
      { type: "result", title: "Read", output: "x", metadata: { filePath: "/x", offset: 1 } },
    )]
    const client = new WaterboxClient(new FakeBackend((_, index) => responses[index]!))
    for (let index = 0; index < 3; index += 1) await expect(client.read({ sandboxId, filePath: "/x" }, { signal })).rejects.toBeInstanceOf(WaterboxClientError)
  })
})

describe("safe errors and cancellation", () => {
  test("creation preserves running and preparing success plus definite and ambiguous recovery failures", async () => {
    const responses = [
      json(sandbox("running"), 201),
      json(sandbox("preparing"), 201),
      json({ error: { code: "provider_failure", message: "Preparation failed", requestId: "req-definite", sandboxId } }, 502),
      json({ error: { code: "ambiguous_execution", message: "Preparation outcome is ambiguous", requestId: "req-ambiguous", sandboxId } }, 502),
    ]
    const client = new WaterboxClient(new FakeBackend((_, index) => responses[index]!))
    expect((await client.createSandbox({}, { idempotencyKey: "running", signal })).state).toBe("running")
    expect((await client.createSandbox({}, { idempotencyKey: "preparing", signal })).state).toBe("preparing")
    await expect(client.createSandbox({}, { idempotencyKey: "definite", signal })).rejects.toMatchObject({ code: "provider_failure", recoverySandboxId: sandboxId })
    await expect(client.createSandbox({}, { idempotencyKey: "ambiguous", signal })).rejects.toMatchObject({ code: "ambiguous_execution", recoverySandboxId: sandboxId })
  })

  test("preserves only canonical error fields and a validated recovery ID without replay", async () => {
    const backend = new FakeBackend(() => json({ error: { code: "ambiguous_execution", message: "Recovery required", requestId: "req-1", sandboxId, providerRef: "secret" } }, 502))
    const client = new WaterboxClient(backend)
    const error = await client.createSandbox({}, { idempotencyKey: "key", signal }).catch(value => value)
    expect(error).toBeInstanceOf(WaterboxClientError)
    // The strict canonical envelope rejects provider detail instead of retaining it.
    expect(error.recoverySandboxId).toBeUndefined()
    expect(String(error)).not.toContain("secret")
    expect(backend.requests).toHaveLength(1)
  })

  test("preserves a valid recovery ID and rejects a malformed one", async () => {
    const values = [
      { error: { code: "provider_failure", message: "Preparation failed", requestId: "req-1", sandboxId } },
      { error: { code: "provider_failure", message: "Preparation failed", requestId: "req-2", sandboxId: "provider-secret" } },
    ]
    const client = new WaterboxClient(new FakeBackend((_, index) => json(values[index], 502)))
    const first = await client.createSandbox({}, { idempotencyKey: "key", signal }).catch(value => value)
    const second = await client.createSandbox({}, { idempotencyKey: "key", signal }).catch(value => value)
    expect(first.recoverySandboxId).toBe(sandboxId)
    expect(second.recoverySandboxId).toBeUndefined()
  })

  test("propagates an abort without manufacturing a client error or retry", async () => {
    const controller = new AbortController()
    const reason = new DOMException("cancelled", "AbortError")
    const backend = new FakeBackend(request => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })))
    const pending = new WaterboxClient(backend).createSandbox({}, { idempotencyKey: "same-key", signal: controller.signal })
    controller.abort(reason)
    expect(await pending.catch(value => value)).toBe(reason)
    expect(backend.requests).toHaveLength(1)
  })

  test("redacts transport failures", async () => {
    const backend = new FakeBackend(() => Promise.reject(new Error("https://secret.example/?token=credential")))
    const error = await new WaterboxClient(backend).probeSandbox({ sandboxId }, { signal }).catch(value => value)
    expect(error).toBeInstanceOf(WaterboxClientError)
    expect(String(error)).not.toContain("secret")
    expect(String(error)).not.toContain("credential")
  })

  test("explicit same-key creation replay remains caller controlled", async () => {
    const backend = new FakeBackend((_, index) => index === 0
      ? json({ error: { code: "ambiguous_execution", message: "Retry explicitly", requestId: "req", sandboxId } }, 502)
      : json(sandbox("running"), 201))
    const client = new WaterboxClient(backend)
    await expect(client.createSandbox({}, { idempotencyKey: "same-key", signal })).rejects.toMatchObject({ recoverySandboxId: sandboxId })
    expect(backend.requests).toHaveLength(1)
    expect((await client.createSandbox({}, { idempotencyKey: "same-key", signal })).state).toBe("running")
    expect(backend.requests).toHaveLength(2)
  })
})

describe("bounded parsing", () => {
  test("cancels JSON and error bodies that exceed their named bounds", async () => {
    for (const [limit, status] of [[MAX_API_JSON_RESPONSE_BYTES, 200], [MAX_API_ERROR_RESPONSE_BYTES, 500]] as const) {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(limit + 1)) },
        cancel() { cancelled = true },
      })
      const client = new WaterboxClient(new FakeBackend(() => new Response(body, { status, headers: { "content-type": "application/json" } })))
      await expect(client.probeSandbox({ sandboxId }, { signal })).rejects.toBeInstanceOf(WaterboxClientError)
      expect(cancelled).toBe(true)
    }
  })

  test("cancels oversized NDJSON lines, pending lines, and total streams", async () => {
    const cases = [
      [new Uint8Array(MAX_API_NDJSON_LINE_BYTES + 2).fill(97)],
      [new Uint8Array(MAX_API_NDJSON_LINE_BYTES + 1).fill(97), new Uint8Array([10])],
      [new Uint8Array(MAX_API_NDJSON_LINE_BYTES).fill(10), new Uint8Array(MAX_API_NDJSON_LINE_BYTES).fill(10), new Uint8Array([10])],
    ]
    for (const chunks of cases) {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk) }, cancel() { cancelled = true } })
      const client = new WaterboxClient(new FakeBackend(() => new Response(body, { headers: { "content-type": "application/x-ndjson" } })))
      await expect(client.read({ sandboxId, filePath: "/x" }, { signal })).rejects.toBeInstanceOf(WaterboxClientError)
      expect(cancelled).toBe(true)
    }
  })

  test("cancels the active NDJSON reader on schema, sequence, and line parse rejection", async () => {
    const values = [
      `${JSON.stringify({ invalid: true })}\n`,
      `${JSON.stringify({ type: "result", title: "Read", output: "x", metadata: { filePath: "/x", offset: 1 } })}\n${JSON.stringify({ type: "result", title: "Read", output: "late", metadata: { filePath: "/x", offset: 1 } })}\n`,
      "{not-json}\n",
    ]
    for (const value of values) {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(value)) },
        cancel() { cancelled = true },
      })
      const client = new WaterboxClient(new FakeBackend(() => new Response(body, { headers: { "content-type": "application/x-ndjson" } })))
      await expect(client.read({ sandboxId, filePath: "/x" }, { signal })).rejects.toBeInstanceOf(WaterboxClientError)
      expect(cancelled).toBe(true)
    }
  })

  test("propagates caller abort and cancels an uncoupled JSON response reader", async () => {
    const controller = new AbortController()
    const reason = new DOMException("json cancelled", "AbortError")
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode("{")) },
      cancel(value) { cancelled = value === reason },
    })
    const pending = new WaterboxClient(new FakeBackend(() => new Response(body, { headers: { "content-type": "application/json" } })))
      .probeSandbox({ sandboxId }, { signal: controller.signal })
    await Bun.sleep(0); controller.abort(reason)
    expect(await pending.catch(value => value)).toBe(reason)
    expect(cancelled).toBe(true)
  })

  test("propagates caller abort and cancels an uncoupled NDJSON response reader", async () => {
    const controller = new AbortController()
    const reason = new DOMException("stream cancelled", "AbortError")
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode("{")) },
      cancel(value) { cancelled = value === reason || value === undefined },
    })
    const pending = new WaterboxClient(new FakeBackend(() => new Response(body, { headers: { "content-type": "application/x-ndjson" } })))
      .read({ sandboxId, filePath: "/x" }, { signal: controller.signal })
    const result = pending.catch(value => value)
    await Bun.sleep(0); controller.abort(reason)
    expect(await result).toBe(reason)
    expect(cancelled).toBe(true)
  })

  test("preserves a backend-triggered caller abort across every post-fetch response branch", async () => {
    const cases = [
      { status: 500, mediaType: "text/plain" },
      { status: 202, mediaType: "application/json" },
      { status: 200, mediaType: "text/plain" },
    ]
    for (const [index, item] of cases.entries()) {
      const controller = new AbortController()
      const reason = new DOMException(`post-fetch abort ${index}`, "AbortError")
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        start(stream) { stream.enqueue(new Uint8Array([1])) },
        cancel(value) { cancelled = value === undefined },
      })
      const backend = new FakeBackend(() => {
        controller.abort(reason)
        return new Response(body, { status: item.status, headers: { "content-type": item.mediaType } })
      })
      const result = new WaterboxClient(backend).probeSandbox({ sandboxId }, { signal: controller.signal }).catch(value => value)
      expect(await result).toBe(reason)
      expect(cancelled).toBe(true)
    }
  })

  test("rejects and cancels unexpected successful statuses by operation contract", async () => {
    const cases: Array<(client: WaterboxClient) => Promise<unknown>> = [
      client => client.createSandbox({}, { idempotencyKey: "key", signal }),
      client => client.probeSandbox({ sandboxId }, { signal }),
      client => client.deleteSandbox({ sandboxId }, { signal }),
      client => client.listSnapshots({}, { signal }),
      client => client.createSnapshot({ sandboxId }, { signal }),
      client => client.deleteSnapshot({ snapshotId }, { signal }),
      client => client.read({ sandboxId, filePath: "/x" }, { signal }),
    ]
    for (const [index, operation] of cases.entries()) {
      let cancelled = false
      const expected = index === 0 || index === 4 ? 201 : 200
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])) }, cancel() { cancelled = true } })
      const client = new WaterboxClient(new FakeBackend(() => new Response(body, { status: expected === 200 ? 201 : 200 })))
      await expect(operation(client)).rejects.toBeInstanceOf(WaterboxClientError)
      expect(cancelled).toBe(true)
    }
  })
})

describe("composite Bash", () => {
  const receipt = { type: "result", title: "Bash", outcome: "dispatched", output: "started", metadata: {
    command: "printf hi", workdir: "/workspace", jobId: "job_0123456789abcdef0123456789abcdef",
    outputPath: "/run/waterbox/bash-jobs/job_0123456789abcdef0123456789abcdef/output.log",
    statusPath: "/run/waterbox/bash-jobs/job_0123456789abcdef0123456789abcdef/status.json",
  } }

  test("observes offsets, drains terminal output, reports progress, and cleans up detached", async () => {
    const observations = [
      { jobId: receipt.metadata.jobId, state: "running", chunkBase64: btoa("hi"), nextOffset: 2, outputSize: 2 },
      { jobId: receipt.metadata.jobId, state: "completed", chunkBase64: btoa("!"), nextOffset: 3, outputSize: 3, exitCode: 0, signal: null, timedOut: false, durationMs: 2 },
    ]
    const backend = new FakeBackend((request, index) => index === 0 ? ndjson(receipt) : index < 3 ? json(observations[index - 1]) : new Response(null, { status: 204 }))
    let progress = 0
    const result = await new WaterboxClient(backend, { bashObservationIntervalMs: 0, bashCleanupDeadlineMs: 100 }).bash({ sandboxId, command: "printf hi" }, { signal, onProgress() { progress += 1 } })
    expect(result).toMatchObject({ outcome: "completed", output: "hi!", metadata: { outputTruncated: false } })
    expect(await backend.requests[1]!.json()).toEqual({ offset: 0, maxBytes: 65_536 })
    expect(await backend.requests[2]!.json()).toEqual({ offset: 2, maxBytes: 65_536 })
    expect(progress).toBeGreaterThan(0)
    await Bun.sleep(0)
    expect(backend.requests[3]!.method).toBe("DELETE")
  })

  test("returns the original recovery receipt on observation failure or cancellation", async () => {
    const backend = new FakeBackend((_, index) => index === 0 ? ndjson(receipt) : json({ invalid: true }))
    const result = await new WaterboxClient(backend).bash({ sandboxId, command: "printf hi" }, { signal })
    expect(result).toMatchObject({ outcome: "dispatched", metadata: { jobId: receipt.metadata.jobId } })
    expect(result.output).toContain("Recovery statusPath")
    expect(backend.requests.some(request => request.method === "DELETE")).toBe(false)
  })

  test("turns observation cancellation into the durable receipt fallback", async () => {
    const controller = new AbortController()
    const backend = new FakeBackend((request, index) => index === 0 ? ndjson(receipt) : new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
    }))
    const pending = new WaterboxClient(backend).bash({ sandboxId, command: "printf hi" }, { signal: controller.signal })
    while (backend.requests.length < 2) await Bun.sleep(0)
    controller.abort(new DOMException("cancelled", "AbortError"))
    expect(await pending).toMatchObject({ outcome: "dispatched", metadata: { jobId: receipt.metadata.jobId } })
  })

  test("truncates retained output at the preserved one MiB bound", async () => {
    const chunk = new Uint8Array(65_536).fill(97)
    const encoded = btoa("a".repeat(chunk.byteLength))
    let offset = 0
    const backend = new FakeBackend((_, index) => {
      if (index === 0) return ndjson(receipt)
      offset += chunk.byteLength
      return json({ jobId: receipt.metadata.jobId, state: index === 17 ? "completed" : "running", chunkBase64: encoded,
        nextOffset: offset, outputSize: offset, ...(index === 17 ? { exitCode: 0, signal: null, timedOut: false, durationMs: 1 } : {}) })
    })
    const result = await new WaterboxClient(backend, { bashObservationIntervalMs: 0 }).bash({ sandboxId, command: "printf hi" }, { signal })
    expect(result).toMatchObject({ outcome: "completed", metadata: { outputTruncated: true } })
    expect(new TextEncoder().encode(result.output).byteLength).toBe(1_048_576)
  })

  test("bounds detached cleanup by the preserved deadline", async () => {
    const completed = { jobId: receipt.metadata.jobId, state: "completed", chunkBase64: "", nextOffset: 0, outputSize: 0,
      exitCode: 0, signal: null, timedOut: false, durationMs: 1 }
    let cleanupAborted = false
    const backend = new FakeBackend((request, index) => index === 0 ? ndjson(receipt) : index === 1 ? json(completed) : new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => { cleanupAborted = true; reject(request.signal.reason) }, { once: true })
    }))
    await new WaterboxClient(backend, { bashCleanupDeadlineMs: 1 }).bash({ sandboxId, command: "true" }, { signal })
    await Bun.sleep(10)
    expect(cleanupAborted).toBe(true)
  })

  test("does not observe a completed execution", async () => {
    const completed = { type: "result", title: "Bash", outcome: "completed", output: "ok", metadata: {
      command: "true", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false,
    } }
    const backend = new FakeBackend(() => ndjson(completed))
    expect((await new WaterboxClient(backend).bash({ sandboxId, command: "true" }, { signal })).outcome).toBe("completed")
    expect(backend.requests).toHaveLength(1)
  })

  test("enforces exact observation and cleanup success statuses", async () => {
    let observationCancelled = false
    const observationBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])) }, cancel() { observationCancelled = true } })
    const observationBackend = new FakeBackend((_, index) => index === 0 ? ndjson(receipt) : new Response(observationBody, { status: 201 }))
    expect(await new WaterboxClient(observationBackend).bash({ sandboxId, command: "true" }, { signal })).toMatchObject({ outcome: "dispatched" })
    expect(observationCancelled).toBe(true)

    const completed = { jobId: receipt.metadata.jobId, state: "completed", chunkBase64: "", nextOffset: 0, outputSize: 0,
      exitCode: 0, signal: null, timedOut: false, durationMs: 1 }
    let cleanupCancelled = false
    const cleanupBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])) }, cancel() { cleanupCancelled = true } })
    const cleanupBackend = new FakeBackend((_, index) => index === 0 ? ndjson(receipt) : index === 1 ? json(completed) : new Response(cleanupBody, { status: 200 }))
    expect(await new WaterboxClient(cleanupBackend).bash({ sandboxId, command: "true" }, { signal })).toMatchObject({ outcome: "completed" })
    await Bun.sleep(0)
    expect(cleanupCancelled).toBe(true)
  })
})

describe("secure transfer", () => {
  test("encrypts caller bytes locally, sends exactly two requests, and leaves caller bytes unchanged", async () => {
    const identity = await generateIdentity()
    const recipient = await identityToRecipient(identity)
    const plaintext = new TextEncoder().encode("private bytes")
    const original = plaintext.slice()
    let ciphertext = ""
    const transferId = "12345678-1234-4123-8123-123456789abc"
    const backend = new FakeBackend(async (request, index) => {
      if (index === 0) return json({ transferId, publicKey: recipient, algorithm: "age-x25519", expiresAt: "2099-01-01T00:00:00.000Z" }, 201)
      const body = await request.json() as { targetPath: string; ciphertext: string }
      ciphertext = body.ciphertext
      expect(JSON.stringify(body)).not.toContain("private bytes")
      return json({ transferId, targetPath: body.targetPath, bytes: plaintext.byteLength })
    })
    const delivered = await new WaterboxClient(backend).sendFileSecurely({ sandboxId, plaintext, targetPath: "/tmp/file" }, { signal })
    expect(delivered.bytes).toBe(plaintext.byteLength)
    expect(plaintext).toEqual(original)
    expect(backend.requests.map(request => request.method)).toEqual(["POST", "PUT"])
    const decrypter = new Decrypter(); decrypter.addIdentity(identity)
    expect(await decrypter.decrypt(Uint8Array.from(atob(ciphertext), character => character.charCodeAt(0)), "text")).toBe("private bytes")
  })

  test("rejects oversized bytes before initiation and expired initiation before consumption", async () => {
    const oversizedBackend = new FakeBackend(() => { throw new Error("must not dispatch") })
    await expect(new WaterboxClient(oversizedBackend).sendFileSecurely({ sandboxId, plaintext: new Uint8Array(1_048_577), targetPath: "/x" }, { signal })).rejects.toBeInstanceOf(WaterboxClientError)
    expect(oversizedBackend.requests).toHaveLength(0)
    const identity = await generateIdentity(); const recipient = await identityToRecipient(identity)
    const expiredBackend = new FakeBackend(() => json({ transferId: "12345678-1234-4123-8123-123456789abc", publicKey: recipient, algorithm: "age-x25519", expiresAt: "2020-01-01T00:00:00.000Z" }, 201))
    await expect(new WaterboxClient(expiredBackend).sendFileSecurely({ sandboxId, plaintext: new Uint8Array([1]), targetPath: "/x" }, { signal })).rejects.toBeInstanceOf(WaterboxClientError)
    expect(expiredBackend.requests).toHaveLength(1)
  })

  test("enforces exact initiation and consumption success statuses", async () => {
    let initiationCancelled = false
    const initiationBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])) }, cancel() { initiationCancelled = true } })
    await expect(new WaterboxClient(new FakeBackend(() => new Response(initiationBody, { status: 200 }))).sendFileSecurely({ sandboxId, plaintext: new Uint8Array([1]), targetPath: "/x" }, { signal })).rejects.toBeInstanceOf(WaterboxClientError)
    expect(initiationCancelled).toBe(true)

    const identity = await generateIdentity(); const recipient = await identityToRecipient(identity)
    const transferId = "12345678-1234-4123-8123-123456789abc"
    let consumptionCancelled = false
    const consumptionBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])) }, cancel() { consumptionCancelled = true } })
    const backend = new FakeBackend((_, index) => index === 0
      ? json({ transferId, publicKey: recipient, algorithm: "age-x25519", expiresAt: "2099-01-01T00:00:00.000Z" }, 201)
      : new Response(consumptionBody, { status: 201 }))
    await expect(new WaterboxClient(backend).sendFileSecurely({ sandboxId, plaintext: new Uint8Array([1]), targetPath: "/x" }, { signal })).rejects.toBeInstanceOf(WaterboxClientError)
    expect(consumptionCancelled).toBe(true)
  })
})
