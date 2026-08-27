import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDaemon } from "../src/index.ts"
import { BashToolEventSchema, EditToolEventSchema, GlobToolEventSchema, GrepToolEventSchema, PatchToolEventSchema, ReadToolEventSchema, WriteToolEventSchema } from "@waterbox/contracts"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "waterbox-daemon-"))
  roots.push(root)
  const daemon = createDaemon({ workspaceRoot: root })
  const post = (name: string, body: unknown, signal?: AbortSignal) => daemon.handleRequest(new Request(`http://daemon/v1/tools/${name}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal,
  }))
  return { root, daemon, post }
}

describe("canonical daemon HTTP contract", () => {
  test("requires an explicit workspace root and exposes health and the seven-tool catalog", async () => {
    expect(() => createDaemon({} as never)).toThrow("workspaceRoot is required")
    const { daemon } = await fixture()
    expect(await (await daemon.handleRequest(new Request("http://daemon/health"))).json()).toEqual({ status: "ok" })
    const catalog = await (await daemon.handleRequest(new Request("http://daemon/v1/tools"))).json()
    expect(catalog.map((tool: { name: string }) => tool.name)).toEqual(["read", "write", "edit", "patch", "glob", "grep", "bash"])
    expect((await daemon.handleRequest(new Request("http://daemon/aws/lambda-microvms/runtime/v1/run", { method: "POST" }))).status).toBe(404)
    expect((await daemon.handleRequest(new Request("http://daemon/v1/pi/tools"))).status).toBe(404)
  })

  test("invokes every canonical tool through HTTP", async () => {
    const { root, post } = await fixture()
    WriteToolEventSchema.parse(await (await post("write", { filePath: "src/a.txt", content: "alpha\n" })).json())
    ReadToolEventSchema.parse(await (await post("read", { filePath: "src/a.txt" })).json())
    EditToolEventSchema.parse(await (await post("edit", { filePath: "src/a.txt", oldString: "alpha", newString: "beta" })).json())
    PatchToolEventSchema.parse(await (await post("patch", { patchText: "*** Begin Patch\n*** Add File: extra.txt\n+extra\n*** End Patch" })).json())
    GlobToolEventSchema.parse(await (await post("glob", { pattern: "*.txt" })).json())
    GrepToolEventSchema.parse(await (await post("grep", { pattern: "beta" })).json())
    const bash = await post("bash", { command: "printf first; printf second >&2" })
    const events = (await bash.text()).trim().split("\n").map((line) => BashToolEventSchema.parse(JSON.parse(line)))
    expect(events.map((event) => event.type)).toEqual(["stdout", "stderr", "result"])
    expect(await readFile(join(root, "src/a.txt"), "utf8")).toBe("beta\n")
  })

  test("strictly rejects malformed and unknown input for every tool", async () => {
    const { post } = await fixture()
    for (const [name, args] of Object.entries({ read: { filePath: "x" }, write: { filePath: "x", content: "x" }, edit: { filePath: "x", oldString: "x", newString: "y" }, patch: { patchText: "x" }, glob: { pattern: "x" }, grep: { pattern: "x" }, bash: { command: "true" } })) {
      expect((await post(name, { ...args, unknown: true })).status).toBe(400)
      expect((await post(name, {})).status).toBe(400)
    }
  })

  test("bounds declared and streamed bodies by raw bytes while accepting the exact boundary", async () => {
    const { daemon } = await fixture()
    const call = (body: BodyInit, headers?: HeadersInit) => daemon.handleRequest(new Request("http://daemon/v1/tools/write", { method: "POST", body, headers }))
    expect((await call("{}", { "content-length": "1048577" })).status).toBe(413)
    expect((await call("{}", { "content-length": "invalid" })).status).toBe(400)

    const streamed = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(700_000)); controller.enqueue(new Uint8Array(400_000)); controller.close() } })
    expect((await call(streamed, {})).status).toBe(413)

    const shell = JSON.stringify({ filePath: "boundary.txt", content: "" })
    const exact = JSON.stringify({ filePath: "boundary.txt", content: "x".repeat(1_048_576 - Buffer.byteLength(shell)) })
    expect(Buffer.byteLength(exact)).toBe(1_048_576)
    expect((await call(exact, { "content-length": String(Buffer.byteLength(exact)) })).status).toBe(200)

    const multibyte = JSON.stringify({ filePath: "multibyte.txt", content: "😀".repeat(270_000) })
    expect(multibyte.length).toBeLessThan(1_048_576)
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(1_048_576)
    const chunks = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(multibyte)); controller.close() } })
    expect((await call(chunks)).status).toBe(413)
  })

  test("enforces exact declared framing and still accepts no-length chunked JSON", async () => {
    const { daemon } = await fixture()
    const payload = JSON.stringify({ filePath: "framed.txt", content: "ok" })
    const call = (declared: number | undefined) => daemon.handleRequest(new Request("http://daemon/v1/tools/write", {
      method: "POST", body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close() } }),
      ...(declared === undefined ? {} : { headers: { "content-length": String(declared) } }), duplex: "half",
    } as RequestInit))
    expect((await call(Buffer.byteLength(payload) - 1)).status).toBe(400)
    expect((await call(Buffer.byteLength(payload) + 1)).status).toBe(400)
    expect((await call(Buffer.byteLength(payload))).status).toBe(200)
    expect((await call(undefined)).status).toBe(200)
  })

  test("reads declared bodies through done and rejects a delayed trailing byte before mutation", async () => {
    const { root, daemon } = await fixture()
    const validPayload = new TextEncoder().encode(JSON.stringify({ filePath: "valid-declared.txt", content: "ok" }))
    let validCancels = 0
    const validBody = new ReadableStream({ start(controller) { controller.enqueue(validPayload.subarray(0, 5)); setTimeout(() => { controller.enqueue(validPayload.subarray(5)); controller.close() }, 10) }, cancel() { validCancels++ } })
    const valid = await daemon.handleRequest(new Request("http://daemon/v1/tools/write", { method: "POST", body: validBody, headers: { "content-length": String(validPayload.byteLength) }, duplex: "half" } as RequestInit))
    expect(valid.status).toBe(200)
    expect(validCancels).toBe(0)
    expect(await readFile(join(root, "valid-declared.txt"), "utf8")).toBe("ok")

    const extraPayload = new TextEncoder().encode(JSON.stringify({ filePath: "trailing-byte.txt", content: "must-not-write" }))
    let extraCancels = 0
    const extraBody = new ReadableStream({ start(controller) { controller.enqueue(extraPayload); setTimeout(() => controller.enqueue(Uint8Array.of(0x20)), 10) }, cancel() { extraCancels++ } })
    const extra = await daemon.handleRequest(new Request("http://daemon/v1/tools/write", { method: "POST", body: extraBody, headers: { "content-length": String(extraPayload.byteLength) }, duplex: "half" } as RequestInit))
    expect(extra.status).toBe(400)
    expect(extraCancels).toBeGreaterThanOrEqual(1)
    await expect(readFile(join(root, "trailing-byte.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("cancels underlying bodies on pre-abort and invalid or oversized declared lengths", async () => {
    const { daemon } = await fixture()
    const instrumented = (headers: HeadersInit, signal?: AbortSignal) => {
      let canceled = false
      const body = new ReadableStream({ start() {}, cancel() { canceled = true } })
      const response = daemon.handleRequest(new Request("http://daemon/v1/tools/write", { method: "POST", body, headers, signal, duplex: "half" } as RequestInit))
      return { response, canceled: () => canceled }
    }
    const invalid = instrumented({ "content-length": "bad" })
    expect((await invalid.response).status).toBe(400); expect(invalid.canceled()).toBe(true)
    const oversized = instrumented({ "content-length": "1048577" })
    expect((await oversized.response).status).toBe(413); expect(oversized.canceled()).toBe(true)
    const abort = new AbortController(); abort.abort()
    const preAborted = instrumented({}, abort.signal)
    expect((await preAborted.response).status).toBe(409); expect(preAborted.canceled()).toBe(true)
  })

  test("daemon shutdown promptly cancels and settles an active never-ending body", async () => {
    const { daemon } = await fixture()
    let canceled = false
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"filePath":"never.txt","content":"')) }, cancel() { canceled = true } })
    const pending = daemon.handleRequest(new Request("http://daemon/v1/tools/write", { method: "POST", body, duplex: "half" } as RequestInit))
    await Bun.sleep(10)
    daemon.shutdown()
    const response = await Promise.race([pending, Bun.sleep(500).then(() => { throw new Error("shutdown did not settle request") })])
    expect(response.status).toBe(409)
    expect(canceled).toBe(true)
  })

  test("hostile non-settling cancellation never delays invalid, aborted, or shutdown responses", async () => {
    const { daemon } = await fixture()
    const hostile = (headers: HeadersInit = {}, signal?: AbortSignal) => {
      let cancels = 0
      const body = new ReadableStream({ start() {}, cancel() { cancels++; return new Promise<void>(() => {}) } })
      const pending = daemon.handleRequest(new Request("http://daemon/v1/tools/write", { method: "POST", body, headers, signal, duplex: "half" } as RequestInit))
      return { pending, cancels: () => cancels }
    }
    const invalid = hostile({ "content-length": "bad" })
    expect((await Promise.race([invalid.pending, Bun.sleep(200).then(() => { throw new Error("invalid length cleanup blocked") })])).status).toBe(400)
    expect(invalid.cancels()).toBe(1)
    const abort = new AbortController(); abort.abort()
    const preAborted = hostile({}, abort.signal)
    expect((await Promise.race([preAborted.pending, Bun.sleep(200).then(() => { throw new Error("pre-abort cleanup blocked") })])).status).toBe(409)
    expect(preAborted.cancels()).toBe(1)
    const active = hostile()
    await Bun.sleep(10); daemon.shutdown()
    expect((await Promise.race([active.pending, Bun.sleep(200).then(() => { throw new Error("shutdown cleanup blocked") })])).status).toBe(409)
    expect(active.cancels()).toBe(1)
  })

  test("rejected cancellation is handled and all terminal parse/validation failures attempt cleanup", async () => {
    const { daemon } = await fixture()
    let unhandled = false
    const onUnhandled = () => { unhandled = true }
    const nodeProcess = process as unknown as { once(event: "unhandledRejection", listener: () => void): void; off(event: "unhandledRejection", listener: () => void): void }
    nodeProcess.once("unhandledRejection", onUnhandled)
    const call = async (bytes: Uint8Array) => {
      let cancels = 0
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
      const getReader = body.getReader.bind(body)
      Object.defineProperty(body, "getReader", { value() {
        const reader = getReader()
        Object.defineProperty(reader, "cancel", { value() { cancels++; return Promise.reject(new Error("hostile cancel")) } })
        return reader
      } })
      const response = await daemon.handleRequest(new Request("http://daemon/v1/tools/write", { method: "POST", body, headers: { "content-length": String(bytes.byteLength) }, duplex: "half" } as RequestInit))
      return { response, cancels }
    }
    const invalidUtf8 = await call(Uint8Array.from([0xff]))
    expect(invalidUtf8.response.status).toBe(400); expect(invalidUtf8.cancels).toBeGreaterThanOrEqual(1)
    const malformed = await call(new TextEncoder().encode("{"))
    expect(malformed.response.status).toBe(400); expect(malformed.cancels).toBeGreaterThanOrEqual(1)
    const unknown = await call(new TextEncoder().encode(JSON.stringify({ filePath: "x", content: "x", unknown: true })))
    expect(unknown.response.status).toBe(400); expect(unknown.cancels).toBeGreaterThanOrEqual(1)
    await Bun.sleep(10)
    nodeProcess.off("unhandledRejection", onUnhandled)
    expect(unhandled).toBe(false)
  })

  test("aborts while a streamed request body is waiting for another chunk", async () => {
    const { root, daemon } = await fixture()
    let canceled = false
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"filePath":"aborted-stream.txt","content":"')); }, cancel() { canceled = true } })
    const abort = new AbortController()
    const pending = daemon.handleRequest(new Request("http://daemon/v1/tools/write", { method: "POST", body, signal: abort.signal, duplex: "half" } as RequestInit))
    await Bun.sleep(10)
    abort.abort()
    expect((await pending).status).toBe(409)
    expect(canceled).toBe(true)
    await expect(readFile(join(root, "aborted-stream.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("streams before bash completes and cancellation terminates its process group", async () => {
    const { root, post } = await fixture()
    const controller = new AbortController()
    const response = await post("bash", { command: "sleep 30 & echo $! > child.pid; printf ready; wait" }, controller.signal)
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('"type":"stdout"')
    controller.abort()
    let remainder = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      remainder += new TextDecoder().decode(chunk.value)
    }
    expect(remainder).toContain('"aborted":true')
    const childPid = Number(await readFile(join(root, "child.pid"), "utf8"))
    let alive = true
    for (let attempt = 0; attempt < 50 && alive; attempt++) {
      try { process.kill(childPid, 0); await Bun.sleep(10) } catch { alive = false }
    }
    expect(alive).toBe(false)
  })

  test("serializes file mutations in request order while leaving bash outside the queue", async () => {
    const { daemon, post } = await fixture()
    const delayedBody = new ReadableStream({ start(controller) { setTimeout(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ filePath: "ordered.txt", content: "first" }))); controller.close() }, 20) } })
    const first = daemon.handleRequest(new Request("http://daemon/v1/tools/write", { method: "POST", body: delayedBody, duplex: "half" } as RequestInit))
    const second = post("write", { filePath: "ordered.txt", content: "second" })
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect((await post("read", { filePath: "ordered.txt" })).json()).resolves.toMatchObject({ output: "second" })
  })

  test("an aborted mutation waiting in the daemon queue never touches the filesystem", async () => {
    const { root, daemon, post } = await fixture()
    let release!: () => void
    const heldBody = new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ filePath: "first.txt", content: "first" }))); controller.close() } } })
    const first = daemon.handleRequest(new Request("http://daemon/v1/tools/write", { method: "POST", body: heldBody, duplex: "half" } as RequestInit))
    const abort = new AbortController()
    const queued = post("write", { filePath: "must-not-exist.txt", content: "bad" }, abort.signal)
    abort.abort()
    release()
    expect((await first).status).toBe(200)
    const response = await queued
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ title: "Error", metadata: { status: 409 } })
    await expect(readFile(join(root, "must-not-exist.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("daemon shutdown cancels a mutation waiting in the queue", async () => {
    const { root, daemon, post } = await fixture()
    let release!: () => void
    const heldBody = new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ filePath: "first.txt", content: "first" }))); controller.close() } } })
    const first = daemon.handleRequest(new Request("http://daemon/v1/tools/write", { method: "POST", body: heldBody, duplex: "half" } as RequestInit))
    const queued = post("write", { filePath: "shutdown-must-not-exist.txt", content: "bad" })
    daemon.shutdown()
    release()
    expect((await first).status).toBe(409)
    expect((await queued).status).toBe(409)
    await expect(readFile(join(root, "shutdown-must-not-exist.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
