import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { ServerResponse } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDaemon } from "../src/index.ts"
import { send } from "../src/host.ts"
import { BashToolEventSchema, EditToolResultSchema, GlobToolResultSchema, GrepToolResultSchema, PatchToolResultSchema, ReadToolResultSchema, WriteToolResultSchema } from "@waterbox/contracts"

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
  test("cancels a response body when the client disconnects or is already gone", async () => {
    let canceled = false
    class Outgoing extends EventEmitter {
      destroyed = false
      writableEnded = false
      writeHead() {}
      write() {
        queueMicrotask(() => { this.destroyed = true; this.emit("close") })
        return false
      }
      end() { this.writableEnded = true }
    }
    const outgoing = new Outgoing()
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("chunk")) },
      cancel() { canceled = true },
    }))
    await send(response, outgoing as unknown as ServerResponse)
    expect(canceled).toBe(true)
    expect(outgoing.listenerCount("drain")).toBe(0)
    expect(outgoing.listenerCount("close")).toBe(0)

    let preCanceled = false
    const destroyed = new Outgoing()
    destroyed.destroyed = true
    await send(new Response(new ReadableStream({ cancel() { preCanceled = true } })), destroyed as unknown as ServerResponse)
    expect(preCanceled).toBe(true)
    expect(destroyed.listenerCount("close")).toBe(0)
  })

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
    WriteToolResultSchema.parse(await (await post("write", { filePath: "src/a.txt", content: "alpha\n" })).json())
    ReadToolResultSchema.parse(await (await post("read", { filePath: "src/a.txt" })).json())
    EditToolResultSchema.parse(await (await post("edit", { filePath: "src/a.txt", oldString: "alpha", newString: "beta" })).json())
    PatchToolResultSchema.parse(await (await post("patch", { patchText: "*** Begin Patch\n*** Add File: extra.txt\n+extra\n*** End Patch" })).json())
    GlobToolResultSchema.parse(await (await post("glob", { pattern: "*.txt" })).json())
    GrepToolResultSchema.parse(await (await post("grep", { pattern: "beta" })).json())
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

  test("rejects invalid UTF-8, malformed JSON, and non-canonical input", async () => {
    const { daemon } = await fixture()
    const call = (body: BodyInit) => daemon.handleRequest(new Request("http://daemon/v1/tools/write", {
      method: "POST", body, duplex: "half",
    } as RequestInit))
    expect((await call(Uint8Array.of(0xff))).status).toBe(400)
    expect((await call("{")).status).toBe(400)
    expect((await call(JSON.stringify({ filePath: "x", content: "x", unknown: true }))).status).toBe(400)
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

  test("does not enforce Content-Length equality", async () => {
    const { daemon } = await fixture()
    const payload = JSON.stringify({ filePath: "framed.txt", content: "ok" })
    const call = (declared: number | undefined) => daemon.handleRequest(new Request("http://daemon/v1/tools/write", {
      method: "POST", body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close() } }),
      ...(declared === undefined ? {} : { headers: { "content-length": String(declared) } }), duplex: "half",
    } as RequestInit))
    expect((await call(Buffer.byteLength(payload) - 1)).status).toBe(200)
    expect((await call(Buffer.byteLength(payload) + 1)).status).toBe(200)
    expect((await call(Buffer.byteLength(payload))).status).toBe(200)
    expect((await call(undefined)).status).toBe(200)
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

})
