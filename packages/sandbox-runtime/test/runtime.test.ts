import { afterEach, describe, expect, test } from "bun:test"
import { BashToolEventSchema, EditToolEventSchema, GlobToolEventSchema, GrepToolEventSchema, PatchToolEventSchema, ReadToolEventSchema, WriteToolEventSchema } from "@waterbox/contracts"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
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

  test.skipIf(process.platform === "win32")("treats the provider sandbox as the boundary, not the workspace", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "waterbox-owned-sandbox-"))
    roots.push(sandbox)
    const workspace = join(sandbox, "workspace")
    const system = join(sandbox, "system")
    await mkdir(workspace)
    await mkdir(system)
    const canonicalSystem = await realpath(system)
    await symlink(system, join(workspace, "system-link"), "dir")
    const runtime = createRuntime({ workspaceRoot: workspace })

    await runtime.execute("write", { filePath: "relative.txt", content: "workspace" })
    await runtime.execute("write", { filePath: join(system, "absolute.txt"), content: "absolute" })
    await runtime.execute("write", { filePath: "../system/traversal.txt", content: "traversal" })
    await runtime.execute("write", { filePath: "system-link/symlink.txt", content: "symlink" })
    await runtime.execute("write", { filePath: ".git/config", content: "owned=true" })
    await runtime.execute("write", { filePath: ".gitignore", content: "ignored.txt\n" })
    await runtime.execute("write", { filePath: "ignored.txt", content: "visible despite ignore rules" })

    expect(await readFile(join(workspace, "relative.txt"), "utf8")).toBe("workspace")
    expect(await readFile(join(system, "absolute.txt"), "utf8")).toBe("absolute")
    expect(await readFile(join(system, "traversal.txt"), "utf8")).toBe("traversal")
    expect(await readFile(join(system, "symlink.txt"), "utf8")).toBe("symlink")
    expect(await runtime.execute("read", { filePath: "system-link/symlink.txt" })).toMatchObject({
      type: "result",
      output: "symlink",
      metadata: { filePath: join(canonicalSystem, "symlink.txt") },
    })
    expect(await runtime.execute("glob", { pattern: "**/*" })).toMatchObject({
      output: expect.stringContaining(".git/config"),
    })
    expect(await runtime.execute("grep", { pattern: "visible despite ignore rules" })).toMatchObject({
      output: expect.stringContaining("ignored.txt"),
    })

    const stream = await runtime.execute("bash", { command: "pwd", workdir: system }) as ReadableStream
    let terminal: any
    for await (const event of stream) if (event.type === "result") terminal = event
    expect(terminal).toMatchObject({ metadata: { workdir: canonicalSystem, exitCode: 0 } })
  })

  test("caller abort and shutdown reject mutations before filesystem work", async () => {
    const runtime = await fixture()
    const caller = new AbortController()
    caller.abort()
    await expect(runtime.execute("write", { filePath: "aborted.txt", content: "bad" }, caller.signal)).rejects.toMatchObject({ name: "AbortError" })
    await expect(Bun.file(join(roots.at(-1)!, "aborted.txt")).exists()).resolves.toBe(false)

    runtime.shutdown()
    await expect(runtime.execute("write", { filePath: "shutdown.txt", content: "bad" })).rejects.toMatchObject({ name: "AbortError" })
    await expect(Bun.file(join(roots.at(-1)!, "shutdown.txt")).exists()).resolves.toBe(false)
  })

  test("runs mutations independently and reports partial patch completion without rolling back newer work", async () => {
    const runtime = await fixture()
    const root = roots.at(-1)!
    await writeFile(join(root, "target.txt"), "original")
    await writeFile(join(root, "fail.txt"), "remove me")
    const holders = Array.from({ length: 80 }, (_, index) => `*** Add File: hold-${index}.txt\n+${"x".repeat(5_000)}`).join("\n")
    const patch = runtime.execute("patch", { patchText: `*** Begin Patch\n*** Update File: target.txt\n@@\n-original\n+patched\n${holders}\n*** Delete File: fail.txt\n*** End Patch` })
    let patchStarted = false
    for (let attempt = 0; attempt < 1_000; attempt++) {
      if ((await readFile(join(root, "target.txt"), "utf8")).trim() === "patched") { patchStarted = true; break }
      await Bun.sleep(1)
    }
    expect(patchStarted).toBeTrue()
    await runtime.execute("write", { filePath: "target.txt", content: "newer" })
    await rm(join(root, "fail.txt"))
    await expect(patch).rejects.toThrow("Operations completed before failure")
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe("newer")
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
