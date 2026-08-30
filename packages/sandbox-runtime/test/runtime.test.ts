import { afterEach, describe, expect, test } from "bun:test"
import { BashToolEventSchema, EditToolEventSchema, GlobToolEventSchema, GrepToolEventSchema, PatchToolEventSchema, ReadToolEventSchema, WriteToolEventSchema } from "@waterbox/contracts"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { createRuntime, runAsyncBashWorker, runOneShotBash } from "../src/index.ts"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
async function fixture() { const root = await mkdtemp(join(tmpdir(), "waterbox-runtime-")); roots.push(root); return createRuntime({ workspaceRoot: root }) }

function controlledChild(onKill: (signal: NodeJS.Signals) => void): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  child.kill = ((signal: NodeJS.Signals = "SIGTERM") => { onKill(signal); return true }) as ChildProcess["kill"]
  return child
}

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
    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "completed" })
  })

  test("keeps createRuntime synchronous and streaming", async () => {
    const runtime = await fixture()
    const stream = await runtime.execute("bash", { command: "printf fast", timeout: 15_001 })
    expect(stream).toBeInstanceOf(ReadableStream)
    let terminal: any
    for await (const event of stream as ReadableStream) if (event.type === "result") terminal = event
    expect(terminal).toMatchObject({ outcome: "completed", output: "fast" })
  })

  test.skipIf(process.platform === "win32")("creates private async files and runs file-backed stdout and stderr to completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "waterbox-async-runtime-"))
    roots.push(root)
    const jobRoot = join(root, "jobs")
    const receipt = await runOneShotBash(root, { command: "printf out; printf err >&2" }, undefined, {
      jobRoot,
      workerExecutable: "bash",
      workerArguments: ["-lc", "sleep 1"],
      yieldAfterMs: 0,
    })
    if (receipt.outcome !== "dispatched") throw new Error("Expected dispatched test setup")
    expect(receipt).toMatchObject({
      outcome: "dispatched",
      output: "Command dispatched. statusPath reports execution state, and outputPath receives output continuously. Repeated output reads can duplicate tokens and pollute context.",
      metadata: { pollAfterMs: 2_000 },
    })
    expect((await stat(jobRoot)).mode & 0o777).toBe(0o700)
    expect((await stat(join(jobRoot, receipt.metadata.jobId))).mode & 0o777).toBe(0o700)
    expect((await stat(receipt.metadata.outputPath)).mode & 0o777).toBe(0o600)
    const starting = JSON.parse(await readFile(receipt.metadata.statusPath, "utf8"))
    expect(starting).toMatchObject({ state: "starting" })
    expect("timeout" in starting).toBe(false)
    expect(JSON.stringify(starting)).not.toContain("printf out")
    expect(JSON.parse(await readFile(join(jobRoot, receipt.metadata.jobId, "request.json"), "utf8"))).not.toHaveProperty("timeout")

    expect(await runAsyncBashWorker(receipt.metadata.jobId, { jobRoot })).toBe(0)
    expect(await readFile(receipt.metadata.outputPath, "utf8")).toContain("out")
    expect(await readFile(receipt.metadata.outputPath, "utf8")).toContain("err")
    const completed = JSON.parse(await readFile(receipt.metadata.statusPath, "utf8"))
    expect(completed).toMatchObject({ state: "completed", exitCode: 0, timedOut: false })
    expect(JSON.stringify(completed)).not.toContain("printf out")
    expect(await Bun.file(join(jobRoot, receipt.metadata.jobId, "request.json")).exists()).toBe(false)
  })

  test.skipIf(process.platform === "win32")("terminates and settles Bash when post-spawn metadata handling fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "waterbox-async-metadata-"))
    roots.push(root)
    const jobRoot = join(root, "jobs")
    const command = "printf post-spawn-secret; sleep 30"
    const receipt = await runOneShotBash(root, { command, timeout: 15_001 }, undefined, {
      jobRoot,
      workerExecutable: "bash",
      workerArguments: ["-lc", "sleep 1"],
      yieldAfterMs: 0,
    })
    if (receipt.outcome !== "dispatched") throw new Error("Expected dispatched test setup")
    const requestPath = join(jobRoot, receipt.metadata.jobId, "request.json")
    const signals: NodeJS.Signals[] = []
    let settled = false
    const child = controlledChild(signal => {
      signals.push(signal)
      if (signal === "SIGTERM") queueMicrotask(() => { settled = true; child.emit("close", null, "SIGTERM") })
    })
    const code = await runAsyncBashWorker(receipt.metadata.jobId, {
      jobRoot,
      spawnProcess: () => {
        rmSync(requestPath)
        mkdirSync(requestPath)
        writeFileSync(join(requestPath, "block-removal"), "x")
        queueMicrotask(() => child.emit("spawn"))
        return child
      },
    })
    expect(code).toBe(1)
    expect(settled).toBe(true)
    expect(signals).toEqual(["SIGTERM"])
    const failed = JSON.parse(await readFile(receipt.metadata.statusPath, "utf8"))
    expect(failed).toMatchObject({ state: "failed", error: "worker_failed" })
    expect(JSON.stringify(failed)).not.toContain(command)
  })

  test.skipIf(process.platform === "win32")("starts timeout accounting at Bash spawn before metadata writes settle", async () => {
    const root = await mkdtemp(join(tmpdir(), "waterbox-async-deadline-"))
    roots.push(root)
    const jobRoot = join(root, "jobs")
    const command = "deadline-secret"
    const receipt = await runOneShotBash(root, { command, timeout: 15_001 }, undefined, {
      jobRoot,
      workerExecutable: "bash",
      workerArguments: ["-lc", "sleep 1"],
      yieldAfterMs: 0,
    })
    if (receipt.outcome !== "dispatched") throw new Error("Expected dispatched test setup")
    const requestPath = join(jobRoot, receipt.metadata.jobId, "request.json")
    const request = JSON.parse(await readFile(requestPath, "utf8"))
    request.timeout = 50
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 })

    const probe = await open(join(root, "probe"), "w")
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
    const originalSync = fileHandlePrototype.sync
    await probe.close()
    let delayNextSync = true
    let metadataSyncPending = false
    fileHandlePrototype.sync = async function () {
      if (delayNextSync) {
        delayNextSync = false
        metadataSyncPending = true
        await Bun.sleep(200)
        metadataSyncPending = false
      }
      await originalSync.call(this)
    }
    let spawnedAt = 0
    let termAt = 0
    let termDuringMetadataSync = false
    const signals: NodeJS.Signals[] = []
    const child = controlledChild(signal => {
      signals.push(signal)
      if (signal === "SIGTERM") { termAt = Date.now(); termDuringMetadataSync = metadataSyncPending }
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"))
    })
    try {
      const worker = runAsyncBashWorker(receipt.metadata.jobId, {
        jobRoot,
        spawnProcess: () => {
          queueMicrotask(() => { spawnedAt = Date.now(); child.emit("spawn") })
          return child
        },
      })
      for (let attempt = 0; attempt < 200 && termAt === 0; attempt++) await Bun.sleep(2)
      expect(termAt - spawnedAt).toBeGreaterThanOrEqual(30)
      expect(termDuringMetadataSync).toBe(true)
      let running: Record<string, unknown> | undefined
      for (let attempt = 0; attempt < 200; attempt++) {
        const status = JSON.parse(await readFile(receipt.metadata.statusPath, "utf8"))
        if (status.state === "running") { running = status; break }
        await Bun.sleep(2)
      }
      expect(running).toMatchObject({ state: "running" })
      expect(JSON.stringify(running)).not.toContain(command)
      expect(await worker).toBe(1)
    } finally {
      fileHandlePrototype.sync = originalSync
    }
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    const failed = JSON.parse(await readFile(receipt.metadata.statusPath, "utf8"))
    expect(failed).toMatchObject({ state: "failed", timedOut: true, signal: "SIGKILL" })
    expect(JSON.stringify(failed)).not.toContain(command)
  })

  test.skipIf(process.platform === "win32")("records a nonzero direct child as failed without leaking command text", async () => {
    const root = await mkdtemp(join(tmpdir(), "waterbox-async-nonzero-"))
    roots.push(root)
    const jobRoot = join(root, "jobs")
    const command = "exit 7 # nonzero-secret"
    const receipt = await runOneShotBash(root, { command, timeout: 15_001 }, undefined, {
      jobRoot,
      workerExecutable: "bash",
      workerArguments: ["-lc", "sleep 1"],
      yieldAfterMs: 0,
    })
    if (receipt.outcome !== "dispatched") throw new Error("Expected dispatched test setup")
    expect(await runAsyncBashWorker(receipt.metadata.jobId, { jobRoot })).toBe(1)
    const failed = JSON.parse(await readFile(receipt.metadata.statusPath, "utf8"))
    expect(failed).toMatchObject({ state: "failed", exitCode: 7, signal: null, timedOut: false })
    expect(JSON.stringify(failed)).not.toContain(command)
  })

  test.skipIf(process.platform === "win32")("records Bash spawn failure after a valid receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "waterbox-async-spawn-"))
    roots.push(root)
    const jobRoot = join(root, "jobs")
    const receipt = await runOneShotBash(root, { command: "true", timeout: 15_001 }, undefined, {
      jobRoot,
      workerExecutable: "bash",
      workerArguments: ["-lc", "sleep 1"],
      yieldAfterMs: 0,
    })
    if (receipt.outcome !== "dispatched") throw new Error("Expected dispatched test setup")
    expect(await runAsyncBashWorker(receipt.metadata.jobId, { jobRoot, bashExecutable: "/missing/waterbox-bash" })).toBe(1)
    const failed = JSON.parse(await readFile(receipt.metadata.statusPath, "utf8"))
    expect(failed).toMatchObject({ state: "failed", error: "spawn_failed" })
    expect(JSON.stringify(failed)).not.toContain("true")
  })

  test.skipIf(process.platform === "win32")("atomically reports timeout after TERM-to-KILL escalation", async () => {
    const root = await mkdtemp(join(tmpdir(), "waterbox-async-timeout-"))
    roots.push(root)
    const jobRoot = join(root, "jobs")
    const receipt = await runOneShotBash(root, { command: "trap '' TERM; while :; do sleep 1; done", timeout: 50 }, undefined, {
      jobRoot,
      workerExecutable: "bash",
      workerArguments: ["-lc", "sleep 1"],
      yieldAfterMs: 0,
    })
    if (receipt.outcome !== "dispatched") throw new Error("Expected dispatched test setup")
    const requestPath = join(jobRoot, receipt.metadata.jobId, "request.json")
    const request = JSON.parse(await readFile(requestPath, "utf8"))
    request.timeout = 50
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 })
    const worker = runAsyncBashWorker(receipt.metadata.jobId, { jobRoot })
    while ((await Bun.file(receipt.metadata.statusPath).text()).includes('"starting"')) {
      JSON.parse(await Bun.file(receipt.metadata.statusPath).text())
      await Bun.sleep(2)
    }
    expect(await worker).toBe(1)
    expect(JSON.parse(await readFile(receipt.metadata.statusPath, "utf8"))).toMatchObject({ state: "failed", timedOut: true, signal: "SIGKILL" })
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
