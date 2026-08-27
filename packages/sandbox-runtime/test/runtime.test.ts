import { afterEach, describe, expect, test } from "bun:test"
import { BashToolEventSchema, EditToolEventSchema, GlobToolEventSchema, GrepToolEventSchema, PatchToolEventSchema, ReadToolEventSchema, WriteToolEventSchema } from "@waterbox/contracts"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { createRuntime } from "../src/index.ts"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
async function fixture() { const root = await mkdtemp(join(tmpdir(), "waterbox-runtime-")); roots.push(root); return createRuntime({ workspaceRoot: root }) }

describe("provider-neutral canonical runtime", () => {
  test("executes all seven tools with canonical events", async () => {
    const runtime = await fixture()
    WriteToolEventSchema.parse(await runtime.execute("write", { filePath: "src/a.txt", content: "alpha\n" }))
    ReadToolEventSchema.parse(await runtime.execute("read", { filePath: "src/a.txt" }))
    EditToolEventSchema.parse(await runtime.execute("edit", { filePath: "src/a.txt", oldString: "alpha", newString: "beta" }))
    PatchToolEventSchema.parse(await runtime.execute("patch", { patchText: "*** Begin Patch\n*** Add File: extra.txt\n+extra\n*** End Patch" }))
    GlobToolEventSchema.parse(await runtime.execute("glob", { pattern: "*.txt" }))
    GrepToolEventSchema.parse(await runtime.execute("grep", { pattern: "beta" }))
    const stream = await runtime.execute("bash", { command: "printf out; printf err >&2" })
    expect(stream).toBeInstanceOf(ReadableStream)
    const events = []
    for await (const event of stream as ReadableStream) events.push(BashToolEventSchema.parse(event))
    expect(events.map((event) => event.type)).toEqual(["stdout", "stderr", "result"])
  })

  test("caller abort and shutdown cancel queued mutations before filesystem work", async () => {
    const runtime = await fixture()
    const largePatch = `*** Begin Patch\n${Array.from({ length: 80 }, (_, index) => `*** Add File: hold-${index}.txt\n+${"x".repeat(5_000)}`).join("\n")}\n*** End Patch`
    const first = runtime.execute("patch", { patchText: largePatch }).catch(() => undefined)
    const caller = new AbortController()
    const aborted = runtime.execute("write", { filePath: "aborted.txt", content: "bad" }, caller.signal)
    caller.abort()
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" })
    await first
    await expect(Bun.file(join(roots.at(-1)!, "aborted.txt")).exists()).resolves.toBe(false)

    const another = runtime.execute("patch", { patchText: `*** Begin Patch\n*** Add File: shutdown-holder.txt\n+holder\n*** End Patch` }).catch(() => undefined)
    const shutdownQueued = runtime.execute("write", { filePath: "shutdown.txt", content: "bad" })
    runtime.shutdown()
    await expect(shutdownQueued).rejects.toMatchObject({ name: "AbortError" })
    await another
    await expect(Bun.file(join(roots.at(-1)!, "shutdown.txt")).exists()).resolves.toBe(false)
  })

  test.skipIf(process.platform === "win32")("escalates cancellation for TERM-resistant process-group descendants", async () => {
    const runtime = await fixture()
    const root = roots.at(-1)!
    const controller = new AbortController()
    const stream = await runtime.execute("bash", {
      command: "bash -c 'trap \"\" TERM; echo $$ > resistant.pid; printf ready; while :; do sleep 1; done' & wait",
    }, controller.signal) as ReadableStream
    const reader = stream.getReader()
    expect((await reader.read()).value).toMatchObject({ type: "stdout", data: "ready" })
    controller.abort()
    while (!(await reader.read()).done) {}
    const pid = Number(await readFile(join(root, "resistant.pid"), "utf8"))
    let alive = true
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      try { process.kill(pid, 0); await Bun.sleep(10) } catch { alive = false }
    }
    expect(alive).toBe(false)
  })

  test.skipIf(process.platform === "win32")("pauses bash output while its consumer is slow and resumes on pull", async () => {
    const runtime = await fixture()
    const pause = Readable.prototype.pause
    const resume = Readable.prototype.resume
    let pauses = 0
    let resumes = 0
    Readable.prototype.pause = function () { pauses++; return pause.call(this) }
    Readable.prototype.resume = function () { resumes++; return resume.call(this) }
    try {
      const stream = await runtime.execute("bash", { command: "printf first; sleep 0.2; printf second" }) as ReadableStream
      for (let attempt = 0; attempt < 100 && pauses === 0; attempt++) await Bun.sleep(10)
      expect(pauses).toBeGreaterThan(0)
      const resumesBeforeRead = resumes
      const reader = stream.getReader()
      expect((await reader.read()).value).toMatchObject({ type: "stdout", data: "first" })
      for (let attempt = 0; attempt < 100 && resumes === resumesBeforeRead; attempt++) await Bun.sleep(10)
      expect(resumes).toBeGreaterThan(resumesBeforeRead)
      while (!(await reader.read()).done) {}
    } finally {
      Readable.prototype.pause = pause
      Readable.prototype.resume = resume
    }
  })
})
