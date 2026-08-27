import { afterEach, describe, expect, test } from "bun:test"
import { BashToolEventSchema, EditToolEventSchema, GlobToolEventSchema, GrepToolEventSchema, PatchToolEventSchema, ReadToolEventSchema, WriteToolEventSchema } from "@waterbox/contracts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
})
