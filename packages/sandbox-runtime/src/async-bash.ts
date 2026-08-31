import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { BashToolArgumentsSchema, type BashToolArguments, type BashToolResult } from "@waterbox/contracts"
import { RuntimeError } from "./runtime.ts"

export const DEFAULT_BASH_JOBS_ROOT = "/run/waterbox/bash-jobs"
const DEFAULT_BASH_YIELD_AFTER_MS = 15_000
const MAX_BASH_OUTPUT_BYTES = 1_048_576
const MAX_STATUS_BYTES = 64 * 1024
type AsyncBashRequest = BashToolArguments & { workdir: string }

type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface OneShotBashOptions {
  jobRoot?: string
  workerExecutable?: string
  workerArguments?: readonly string[]
  bashExecutable?: string
  spawnProcess?: SpawnProcess
  yieldAfterMs?: number
}

interface JobPaths {
  directory: string
  requestPath: string
  outputPath: string
  statusPath: string
}

export interface AsyncBashObservation {
  jobId: string
  state: "starting" | "running" | "completed" | "failed"
  chunkBase64: string
  nextOffset: number
  outputSize: number
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
  durationMs?: number
  error?: "spawn_failed" | "worker_failed"
}

function pathsFor(jobRoot: string, jobId: string): JobPaths {
  if (!/^job_[0-9a-f]{32}$/.test(jobId)) throw new Error("Invalid async Bash job ID")
  const directory = resolve(jobRoot, jobId)
  return {
    directory,
    requestPath: resolve(directory, "request.json"),
    outputPath: resolve(directory, "output.log"),
    statusPath: resolve(directory, "status.json"),
  }
}

async function writeStatus(path: string, value: Record<string, unknown>): Promise<void> {
  const temp = resolve(path, `../.${process.pid}-${crypto.randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, path)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

async function createPrivateFile(path: string, content = ""): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    if (content) await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function displayPath(root: string, path: string): string {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith(`..${sep}`) ? rel || "." : path
}

function abortError(): DOMException {
  return new DOMException("This operation was aborted", "AbortError")
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = () => {
      child.off("spawn", onSpawn)
      child.off("error", onError)
    }
    const onSpawn = () => { cleanup(); resolvePromise() }
    const onError = (error: Error) => { cleanup(); reject(error) }
    child.once("spawn", onSpawn)
    child.once("error", onError)
  })
}

async function readBounded(path: string, limit: number): Promise<{ value: string; truncated: boolean }> {
  const handle = await open(path, "r")
  try {
    const size = (await handle.stat()).size
    const buffer = Buffer.alloc(Math.min(size, limit))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const decoded = buffer.subarray(0, bytesRead).toString("utf8")
    if (Buffer.byteLength(decoded, "utf8") <= limit) {
      return { value: decoded, truncated: size > bytesRead }
    }
    let encodedBytes = 0
    let end = 0
    for (const character of decoded) {
      const characterBytes = Buffer.byteLength(character, "utf8")
      if (encodedBytes + characterBytes > limit) {
        return { value: decoded.slice(0, end), truncated: true }
      }
      encodedBytes += characterBytes
      end += character.length
    }
    throw new Error("Failed to bound decoded UTF-8 output")
  } finally {
    await handle.close()
  }
}

interface TerminalWorkerStatus {
  state: "completed" | "failed"
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  durationMs: number
}

async function readTerminalStatus(path: string): Promise<TerminalWorkerStatus> {
  const statusFile = await readBounded(path, MAX_STATUS_BYTES)
  if (statusFile.truncated) throw new Error("Oversized Bash worker status")
  const status = JSON.parse(statusFile.value) as Record<string, unknown>
  if ((status.state !== "completed" && status.state !== "failed") || "error" in status
    || (typeof status.exitCode !== "number" && status.exitCode !== null)
    || (typeof status.signal !== "string" && status.signal !== null)
    || typeof status.timedOut !== "boolean" || typeof status.durationMs !== "number") {
    throw new Error("Invalid Bash worker terminal status")
  }
  return status as unknown as TerminalWorkerStatus
}

async function readCorrelatedStatus(paths: JobPaths, jobId: string): Promise<Record<string, unknown>> {
  const statusFile = await readBounded(paths.statusPath, MAX_STATUS_BYTES)
  if (statusFile.truncated) throw new Error("Oversized Bash worker status")
  const status: unknown = JSON.parse(statusFile.value)
  if (typeof status !== "object" || status === null || Array.isArray(status)) throw new Error("Invalid Bash worker status")
  const value = status as Record<string, unknown>
  if (value.jobId !== jobId || value.outputPath !== paths.outputPath || !["starting", "running", "completed", "failed"].includes(String(value.state))) {
    throw new Error("Mismatched Bash worker status")
  }
  const common = ["state", "jobId", "outputPath"]
  if (value.state === "starting") {
    if (!exactKeys(value, [...common, "createdAt"], ["timeout"]) || typeof value.createdAt !== "string" || (value.timeout !== undefined && !Number.isInteger(value.timeout))) throw new Error("Invalid Bash worker status")
  } else if (value.state === "running") {
    if (!exactKeys(value, [...common, "startedAt"], ["timeout"]) || typeof value.startedAt !== "string" || (value.timeout !== undefined && !Number.isInteger(value.timeout))) throw new Error("Invalid Bash worker status")
  } else if (value.error !== undefined) {
    if (value.state !== "failed" || !exactKeys(value, [...common, "error", "finishedAt"]) || (value.error !== "spawn_failed" && value.error !== "worker_failed") || typeof value.finishedAt !== "string") throw new Error("Invalid Bash worker status")
  } else if (!exactKeys(value, [...common, "exitCode", "signal", "timedOut", "durationMs", "finishedAt"])
    || (typeof value.exitCode !== "number" && value.exitCode !== null) || (typeof value.signal !== "string" && value.signal !== null)
    || typeof value.timedOut !== "boolean" || typeof value.durationMs !== "number" || value.durationMs < 0 || typeof value.finishedAt !== "string") {
    throw new Error("Invalid Bash worker status")
  }
  return value
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

export async function observeAsyncBashJob(jobId: string, offset: number, maxBytes: number, options: OneShotBashOptions = {}): Promise<AsyncBashObservation> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) throw new Error("Invalid async Bash observation")
  const paths = pathsFor(resolve(options.jobRoot ?? DEFAULT_BASH_JOBS_ROOT), jobId)
  const status = await readCorrelatedStatus(paths, jobId)
  const handle = await open(paths.outputPath, "r")
  try {
    const before = await handle.stat()
    if (offset > before.size) throw new Error("Invalid async Bash output offset")
    const buffer = Buffer.alloc(Math.min(maxBytes, before.size - offset))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    const outputSize = (await handle.stat()).size
    return {
      jobId,
      state: status.state as AsyncBashObservation["state"],
      chunkBase64: buffer.subarray(0, bytesRead).toString("base64"),
      nextOffset: offset + bytesRead,
      outputSize,
      ...(typeof status.exitCode === "number" || status.exitCode === null ? { exitCode: status.exitCode as number | null } : {}),
      ...(typeof status.signal === "string" || status.signal === null ? { signal: status.signal as string | null } : {}),
      ...(typeof status.timedOut === "boolean" ? { timedOut: status.timedOut } : {}),
      ...(typeof status.durationMs === "number" ? { durationMs: status.durationMs } : {}),
      ...(status.error === "spawn_failed" || status.error === "worker_failed" ? { error: status.error } : {}),
    }
  } finally {
    await handle.close()
  }
}

export async function cleanupAsyncBashJob(jobId: string, options: OneShotBashOptions = {}): Promise<boolean> {
  const paths = pathsFor(resolve(options.jobRoot ?? DEFAULT_BASH_JOBS_ROOT), jobId)
  const status = await readCorrelatedStatus(paths, jobId)
  if (status.state !== "completed" && status.state !== "failed") return false
  await rm(paths.directory, { recursive: true, force: true })
  return true
}

async function waitForWorker(child: ChildProcess, signal: AbortSignal | undefined, yieldAfterMs: number): Promise<"completed" | "yielded"> {
  await waitForSpawn(child)
  return await new Promise((resolvePromise, reject) => {
    let settled = false
    const cleanup = () => {
      child.off("close", onClose)
      signal?.removeEventListener("abort", onAbort)
      clearTimeout(yieldTimer)
    }
    const finish = (result: "completed" | "yielded") => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(result)
    }
    const onClose = () => finish("completed")
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      child.unref()
      reject(abortError())
    }
    const yieldTimer = setTimeout(() => finish("yielded"), yieldAfterMs)
    child.once("close", onClose)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (child.exitCode !== null || child.signalCode !== null) finish("completed")
    else if (signal?.aborted) onAbort()
  })
}

export async function runOneShotBash(
  workspaceRoot: string,
  input: BashToolArguments,
  signal?: AbortSignal,
  options: OneShotBashOptions = {},
): Promise<{ type: "result" } & BashToolResult> {
  const args = BashToolArgumentsSchema.parse(input)
  signal?.throwIfAborted()
  const root = await realpath(workspaceRoot)
  const cwd = args.workdir === undefined ? root : await realpath(resolve(root, args.workdir))
  if (!(await lstat(cwd)).isDirectory()) throw new RuntimeError(400, "workdir must refer to a directory")

  const jobRoot = resolve(options.jobRoot ?? DEFAULT_BASH_JOBS_ROOT)
  await mkdir(jobRoot, { recursive: true, mode: 0o700 })
  await chmod(jobRoot, 0o700)
  const jobId = `job_${randomBytes(16).toString("hex")}`
  const paths = pathsFor(jobRoot, jobId)
  let filesTransferred = false
  try {
    await mkdir(paths.directory, { mode: 0o700 })
    await createPrivateFile(paths.outputPath)
    await createPrivateFile(paths.requestPath, `${JSON.stringify({
      command: args.command,
      workdir: cwd,
      ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
      ...(args.description === undefined ? {} : { description: args.description }),
    })}\n`)
    await writeStatus(paths.statusPath, {
      state: "starting",
      jobId,
      outputPath: paths.outputPath,
      ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
      createdAt: new Date().toISOString(),
    })
    signal?.throwIfAborted()
    const spawnProcess = options.spawnProcess ?? spawn
    const child = spawnProcess(
      options.workerExecutable ?? "/usr/local/bin/bun",
      [...(options.workerArguments ?? ["/usr/local/lib/waterbox-cli.js"]), "__internal-bash-worker", jobId],
      { detached: true, stdio: "ignore", env: process.env },
    )
    let disposition: "completed" | "yielded"
    try {
      disposition = await waitForWorker(child, signal, options.yieldAfterMs ?? DEFAULT_BASH_YIELD_AFTER_MS)
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        filesTransferred = true
        throw error
      }
      throw new RuntimeError(500, "Async Bash worker failed to spawn")
    }
    if (disposition === "yielded") {
      filesTransferred = true
      child.unref()
    }
    else {
      let status: TerminalWorkerStatus
      let output: { value: string; truncated: boolean }
      try {
        [status, output] = await Promise.all([
          readTerminalStatus(paths.statusPath),
          readBounded(paths.outputPath, MAX_BASH_OUTPUT_BYTES),
        ])
      } catch {
        throw new RuntimeError(500, "Async Bash worker failed")
      }
      await rm(paths.directory, { recursive: true, force: true }).catch(() => undefined)
      return {
        type: "result",
        outcome: "completed",
        title: args.description ?? "Bash command",
        output: output.value || (status.timedOut ? "Command timed out" : "Command completed without output"),
        metadata: {
          command: args.command,
          ...(args.description === undefined ? {} : { description: args.description }),
          workdir: displayPath(root, cwd),
          exitCode: status.exitCode,
          signal: status.signal,
          timedOut: status.timedOut,
          aborted: false,
          durationMs: status.durationMs,
          outputTruncated: output.truncated,
        },
      }
    }
  } catch (error) {
    if (!filesTransferred) await rm(paths.directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  return {
    type: "result",
    outcome: "dispatched",
    title: "Bash command dispatched",
    output: "Command dispatched. statusPath reports execution state, and outputPath receives output continuously. Repeated output reads can duplicate tokens and pollute context.",
    metadata: {
      command: args.command,
      ...(args.description === undefined ? {} : { description: args.description }),
      workdir: displayPath(root, cwd),
      ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
      jobId,
      outputPath: pathsFor(DEFAULT_BASH_JOBS_ROOT, jobId).outputPath,
      statusPath: pathsFor(DEFAULT_BASH_JOBS_ROOT, jobId).statusPath,
    },
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // The direct child or process group has already exited.
  }
}

async function settleChildAfterWorkerFailure(
  child: ChildProcess,
  resultPromise: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>,
  isSettled: () => boolean,
): Promise<void> {
  if (isSettled()) return
  signalProcessGroup(child, "SIGTERM")
  let escalation: NodeJS.Timeout | undefined
  await Promise.race([
    resultPromise,
    new Promise<void>(resolvePromise => {
      escalation = setTimeout(() => { signalProcessGroup(child, "SIGKILL"); resolvePromise() }, 1_000)
    }),
  ])
  if (isSettled() && escalation !== undefined) clearTimeout(escalation)
  else await resultPromise
}

export async function runAsyncBashWorker(jobId: string, options: OneShotBashOptions = {}): Promise<number> {
  const jobRoot = resolve(options.jobRoot ?? DEFAULT_BASH_JOBS_ROOT)
  let paths: JobPaths
  try { paths = pathsFor(jobRoot, jobId) } catch { return 1 }
  let request: AsyncBashRequest
  try {
    const parsed = BashToolArgumentsSchema.parse(JSON.parse(await readFile(paths.requestPath, "utf8")))
    if (parsed.workdir === undefined) throw new Error("Invalid async Bash request")
    request = parsed as AsyncBashRequest
    const output = await open(paths.outputPath, constants.O_WRONLY | constants.O_APPEND)
    try {
      const spawnProcess = options.spawnProcess ?? spawn
      const child = spawnProcess(options.bashExecutable ?? "bash", ["-lc", request.command], {
        cwd: request.workdir,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["ignore", output.fd, output.fd],
      })
      let childSettled = false
      const resultPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
        child.once("close", (exitCode, signal) => {
          childSettled = true
          resolvePromise({ exitCode, signal })
        })
      })
      try {
        await waitForSpawn(child)
      } catch {
        await writeStatus(paths.statusPath, {
          state: "failed", jobId, outputPath: paths.outputPath, error: "spawn_failed", finishedAt: new Date().toISOString(),
        })
        return 1
      }
      const started = Date.now()
      let timedOut = false
      let forceKill: Promise<void> | undefined
      const timeout = request.timeout === undefined ? undefined : setTimeout(() => {
        timedOut = true
        signalProcessGroup(child, "SIGTERM")
        forceKill = new Promise(resolvePromise => {
          setTimeout(() => { signalProcessGroup(child, "SIGKILL"); resolvePromise() }, 1_000)
        })
      }, request.timeout)
      timeout?.unref()
      try {
        await writeStatus(paths.statusPath, {
          state: "running", jobId, outputPath: paths.outputPath, ...(request.timeout === undefined ? {} : { timeout: request.timeout }), startedAt: new Date(started).toISOString(),
        })
        await rm(paths.requestPath, { force: true })
        const result = await resultPromise
        if (timeout) clearTimeout(timeout)
        if (forceKill) await forceKill
        const state = !timedOut && result.exitCode === 0 ? "completed" : "failed"
        await writeStatus(paths.statusPath, {
          state,
          jobId,
          outputPath: paths.outputPath,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut,
          durationMs: Date.now() - started,
          finishedAt: new Date().toISOString(),
        })
        return state === "completed" ? 0 : 1
      } catch {
        if (timeout) clearTimeout(timeout)
        if (timedOut) {
          if (forceKill) await forceKill
          if (!childSettled) await resultPromise
        } else {
          await settleChildAfterWorkerFailure(child, resultPromise, () => childSettled)
        }
        await writeStatus(paths.statusPath, {
          state: "failed", jobId, outputPath: paths.outputPath, error: "worker_failed", finishedAt: new Date().toISOString(),
        }).catch(() => undefined)
        return 1
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    } finally {
      await output.close()
    }
  } catch {
    await writeStatus(paths.statusPath, {
      state: "failed", jobId, outputPath: paths.outputPath, error: "worker_failed", finishedAt: new Date().toISOString(),
    }).catch(() => undefined)
    return 1
  }
}
