import { constants } from "node:fs"
import { link, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { spawn, type ChildProcess } from "node:child_process"
import {
  type BashToolArguments as BashArgs,
  type BashToolEvent as BashStreamEvent,
  type CompletedBashToolResult,
  type EditToolArguments as EditArgs,
  type EditToolResult,
  type GlobToolArguments as GlobArgs,
  type GlobToolResult,
  type GrepToolArguments as GrepArgs,
  type GrepToolResult,
  type PatchToolArguments as PatchArgs,
  type PatchToolResult,
  type ReadToolArguments as ReadArgs,
  type ReadToolResult,
  type ToolName,
  type WriteToolArguments as WriteArgs,
  type WriteToolResult,
} from "@waterbox/contracts"
import { BinaryFileError, PathKindError, readFilesystem } from "./read-filesystem.ts"
import { RipgrepError, RipgrepTimeoutError, ripgrepGlob, ripgrepSearch } from "./ripgrep.ts"
import { EditTextError, editText, joinBom as joinEditBom } from "./vendor/opencode-edit.ts"
import {
  BoundaryError,
  InvalidHunkError,
  derive,
  joinBom as joinPatchBom,
  parse,
  type Hunk,
} from "./vendor/opencode-patch.ts"

const MAX_BASH_OUTPUT_BYTES = 1_048_576
const MAX_TIMEOUT_MS = 2_147_483_647
type ToolResponse<Metadata extends Record<string, unknown>> = { title: string; output: string; metadata: Metadata }
type ReadMetadata = ReadToolResult["metadata"]
type WriteMetadata = WriteToolResult["metadata"]
type EditMetadata = EditToolResult["metadata"]
type PatchMetadata = PatchToolResult["metadata"]
type GlobMetadata = GlobToolResult["metadata"]
type GrepMetadata = GrepToolResult["metadata"]
type BashMetadata = CompletedBashToolResult["metadata"]

export class RuntimeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}
const HttpError = RuntimeError

export interface RuntimeOptions {
  workspaceRoot: string
}

export interface Runtime {
  execute(name: ToolName, args: Record<string, unknown>, signal?: AbortSignal): Promise<CanonicalToolEvent | ReadableStream<BashStreamEvent>>
  shutdown(): void
}

export type CanonicalToolEvent =
  | ({ type: "result" } & ReadToolResult)
  | ({ type: "result" } & WriteToolResult)
  | ({ type: "result" } & EditToolResult)
  | ({ type: "result" } & PatchToolResult)
  | ({ type: "result" } & GlobToolResult)
  | ({ type: "result" } & GrepToolResult)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeError(400, `${name} must be a non-empty string`)
  }
  return value
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RuntimeError(400, `${name} must be a positive integer`)
  }
  return value as number
}

export function runtimeErrorStatus(error: unknown): number {
  if (error instanceof RuntimeError) return error.status
  if (isRecord(error) && error.code === "ENOENT") return 404
  if (isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY")) return 409
  if (error instanceof EditTextError) return error.code === "empty-search" || error.code === "identical" ? 400 : 409
  if (error instanceof BoundaryError || error instanceof InvalidHunkError || error instanceof BinaryFileError || error instanceof PathKindError || error instanceof RangeError || error instanceof RipgrepError) {
    return error instanceof RipgrepTimeoutError ? 409 : 400
  }
  if (error instanceof DOMException && error.name === "AbortError") return 409
  return 500
}

function lexicalPath(root: string, input: string): string {
  if (input.includes("\0")) throw new RuntimeError(400, "Path contains a null byte")
  return resolve(root, input)
}

async function existingPath(root: string, input: string): Promise<string> {
  const candidate = lexicalPath(root, input)
  return await realpath(candidate)
}

async function ensureParent(root: string, candidate: string): Promise<string> {
  const parent = dirname(candidate)
  await mkdir(parent, { recursive: true })
  const canonical = await realpath(parent)
  if (!(await lstat(canonical)).isDirectory()) throw new HttpError(400, "Write parent must be a directory")
  return canonical
}

async function preflightParent(_root: string, candidate: string): Promise<void> {
  try {
    const parent = await realpath(dirname(candidate))
    if (!(await lstat(parent)).isDirectory()) throw new HttpError(400, "Write parent must be a directory")
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return
    throw error
  }
}

function displayPath(root: string, path: string): string {
  const rel = relative(root, path)
  if (rel !== ".." && !rel.startsWith(`..${sep}`)) return rel || "."
  return path
}

async function readTool(root: string, body: Record<string, unknown>): Promise<ToolResponse<ReadMetadata>> {
  const args: ReadArgs = {
    filePath: requiredString(body.filePath, "filePath"),
    offset: optionalPositiveInteger(body.offset, "offset"),
    limit: optionalPositiveInteger(body.limit, "limit"),
  }
  const path = await existingPath(root, args.filePath)
  const result = await readFilesystem(path, args)
  const filePath = displayPath(root, path)
  if (result.type === "directory") {
    return {
      title: `Read directory ${filePath}`,
      output: result.entries.map((entry) => entry.path).join("\n") || "Directory is empty",
      metadata: {
        filePath,
        type: "directory",
        offset: result.offset,
        entries: result.entries.length,
        truncated: result.truncated,
        ...(result.next === undefined ? {} : { next: result.next }),
      },
    }
  }
  return {
    title: `Read ${filePath}`,
    output: result.content,
    metadata: {
      filePath,
      type: "text",
      offset: result.offset,
      lines: result.lines,
      totalLines: result.totalLines,
      truncated: result.truncated,
      ...(result.next === undefined ? {} : { next: result.next }),
    },
  }
}

async function atomicWrite(root: string, target: string, content: string, mode?: number): Promise<void> {
  if (target === root) throw new HttpError(400, "filePath must refer to a file")
  const parent = await ensureParent(root, target)
  const temp = resolve(parent, `.${process.pid}-${crypto.randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    if (mode !== undefined) await handle.chmod(mode)
    await handle.writeFile(content, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, target)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

async function atomicCreate(root: string, target: string, content: string, mode?: number): Promise<void> {
  if (target === root) throw new HttpError(400, "filePath must refer to a file")
  const parent = await ensureParent(root, target)
  const temp = resolve(parent, `.${process.pid}-${crypto.randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    if (mode !== undefined) await handle.chmod(mode)
    await handle.writeFile(content, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temp, target)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

async function existingTarget(target: string): Promise<{ path: string; mode?: number }> {
  try {
    const path = await realpath(target)
    const stat = await lstat(path)
    if (!stat.isFile()) throw new HttpError(400, "filePath must refer to a regular file")
    return { path, mode: stat.mode & 0o7777 }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { path: target }
    throw error
  }
}

async function writeTool(root: string, body: Record<string, unknown>): Promise<ToolResponse<WriteMetadata>> {
  const args: WriteArgs = {
    filePath: requiredString(body.filePath, "filePath"),
    content: typeof body.content === "string" ? body.content : (() => { throw new HttpError(400, "content must be a string") })(),
  }
  const requested = lexicalPath(root, args.filePath)
  const target = await existingTarget(requested)
  await atomicWrite(root, target.path, args.content, target.mode)
  const filePath = displayPath(root, target.path)
  return {
    title: `Wrote ${filePath}`,
    output: "File written successfully",
    metadata: { filePath, bytes: Buffer.byteLength(args.content) },
  }
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, name)
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new HttpError(400, `${name} must be a boolean`)
  return value
}

async function searchRoot(root: string, path: string | undefined): Promise<{ path: string; label: string }> {
  const target = path === undefined ? root : await existingPath(root, path)
  if (!(await lstat(target)).isDirectory()) throw new HttpError(400, "path must refer to a directory")
  return { path: target, label: displayPath(root, target) }
}

async function searchTarget(root: string, path: string | undefined): Promise<{ target: string; label: string }> {
  const target = path === undefined ? root : await existingPath(root, path)
  const stat = await lstat(target)
  if (!stat.isDirectory() && !stat.isFile()) throw new HttpError(400, "path must refer to a regular file or directory")
  const label = displayPath(root, target)
  return { target: label.replaceAll("\\", "/"), label }
}

async function globTool(root: string, body: Record<string, unknown>, signal: AbortSignal): Promise<ToolResponse<GlobMetadata>> {
  const args: GlobArgs = { pattern: requiredString(body.pattern, "pattern"), path: optionalString(body.path, "path") }
  const scope = await searchRoot(root, args.path)
  const result = await ripgrepGlob(scope.path, args.pattern, { signal })
  const prefix = scope.label === "." ? "" : `${scope.label.replaceAll("\\", "/")}/`
  const paths = result.paths.map((path) => prefix + path)
  return {
    title: `Glob ${args.pattern}`,
    output: paths.join("\n") || "No files found",
    metadata: { pattern: args.pattern, path: scope.label, count: paths.length, truncated: result.truncated },
  }
}

async function grepTool(root: string, body: Record<string, unknown>, signal: AbortSignal): Promise<ToolResponse<GrepMetadata>> {
  const args: GrepArgs = {
    pattern: requiredString(body.pattern, "pattern"),
    path: optionalString(body.path, "path"),
    include: optionalString(body.include, "include"),
  }
  const scope = await searchTarget(root, args.path)
  const result = await ripgrepSearch(root, args.pattern, {
    signal,
    target: scope.target,
    globs: args.include === undefined ? [] : [args.include],
  })
  return {
    title: `Grep ${args.pattern}`,
    output: result.matches.map((match) => `${match.path}:${match.lineNumber}: ${match.line}`).join("\n") || "No matches found",
    metadata: {
      pattern: args.pattern,
      path: scope.label,
      ...(args.include === undefined ? {} : { include: args.include }),
      matches: result.matches.length,
      truncated: result.truncated,
    },
  }
}

async function readEditable(root: string, input: string): Promise<{ path: string; content: string; mode: number }> {
  const path = await existingPath(root, input)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new HttpError(400, "filePath must refer to a regular file")
    const bytes = await handle.readFile()
    if (bytes.includes(0)) throw new BinaryFileError(input)
    return { path, content: bytes.toString("utf8"), mode: stat.mode & 0o7777 }
  } finally {
    await handle.close()
  }
}

async function editTool(root: string, body: Record<string, unknown>): Promise<ToolResponse<EditMetadata>> {
  const args: EditArgs = {
    filePath: requiredString(body.filePath, "filePath"),
    oldString: typeof body.oldString === "string" ? body.oldString : (() => { throw new HttpError(400, "oldString must be a string") })(),
    newString: typeof body.newString === "string" ? body.newString : (() => { throw new HttpError(400, "newString must be a string") })(),
    replaceAll: optionalBoolean(body.replaceAll, "replaceAll"),
  }
  const source = await readEditable(root, args.filePath)
  const result = editText(source.content, args.oldString, args.newString, args.replaceAll)
  const content = joinEditBom(result.content, result.bom)
  await atomicWrite(root, source.path, content, source.mode)
  const filePath = displayPath(root, source.path)
  return {
    title: `Edited ${filePath}`,
    output: `Replaced ${result.replacements} occurrence${result.replacements === 1 ? "" : "s"} in ${filePath}`,
    metadata: { filePath, replacements: result.replacements, bytes: Buffer.byteLength(content) },
  }
}

interface PreparedPatch {
  hunk: Hunk
  source: string
  destination?: string
  content?: string
  original?: string
  mode?: number
}

async function patchTool(root: string, body: Record<string, unknown>): Promise<ToolResponse<PatchMetadata>> {
  const args: PatchArgs = { patchText: requiredString(body.patchText, "patchText") }
  const hunks = parse(args.patchText)
  if (hunks.length === 0) throw new HttpError(400, "Patch contains no operations")
  const touched = new Set<string>()
  const prepared: PreparedPatch[] = []

  for (const hunk of hunks) {
    const source = lexicalPath(root, hunk.path)
    if (source === root) throw new HttpError(400, "Patch paths must refer to files")
    const destination = hunk.type === "update" && hunk.movePath !== undefined ? lexicalPath(root, hunk.movePath) : undefined
    if (destination === root) throw new HttpError(400, "Patch paths must refer to files")
    for (const path of destination === undefined ? [source] : [source, destination]) {
      if ([...touched].some((other) => path === other || path.startsWith(`${other}${sep}`) || other.startsWith(`${path}${sep}`))) {
        throw new HttpError(409, `Patch contains conflicting operations for ${displayPath(root, path)}`)
      }
      touched.add(path)
    }
    if (hunk.type === "add") {
      if (await pathExists(source)) throw new HttpError(409, `Cannot add existing path: ${hunk.path}`)
      await preflightParent(root, source)
      prepared.push({ hunk, source, content: hunk.contents })
      continue
    }
    const current = await readEditable(root, hunk.path)
    if (current.path !== source) {
      touched.delete(source)
      if ([...touched].some((other) => current.path === other || current.path.startsWith(`${other}${sep}`) || other.startsWith(`${current.path}${sep}`))) {
        throw new HttpError(409, `Patch contains conflicting operations for ${displayPath(root, current.path)}`)
      }
      touched.add(current.path)
    }
    if (destination !== undefined && await pathExists(destination)) {
      throw new HttpError(409, `Move destination already exists: ${displayPath(root, destination)}`)
    }
    if (destination !== undefined) await preflightParent(root, destination)
    if (hunk.type === "delete") prepared.push({ hunk, source: current.path, original: current.content, mode: current.mode })
    else {
      let update
      try {
        update = derive(hunk.path, hunk.chunks, current.content)
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : "Patch could not be applied")
      }
      prepared.push({
        hunk,
        source: current.path,
        destination,
        content: joinPatchBom(update.content, update.bom),
        original: current.content,
        mode: current.mode,
      })
    }
  }

  const metadata: PatchMetadata = { added: [], updated: [], deleted: [], moved: [] }
  try {
    for (const item of prepared) {
      if (item.hunk.type === "delete") {
        if (!await fileMatches(item.source, item.original!, item.mode)) throw new HttpError(409, `Patch source changed concurrently: ${item.hunk.path}`)
        await rm(item.source)
        metadata.deleted.push(item.hunk.path)
      } else if (item.hunk.type === "add") {
        await atomicCreate(root, item.source, item.content!)
        metadata.added.push(item.hunk.path)
      } else if (item.destination !== undefined) {
        if (!await fileMatches(item.source, item.original!, item.mode)) throw new HttpError(409, `Patch source changed concurrently: ${item.hunk.path}`)
        await atomicCreate(root, item.destination, item.content!, item.mode)
        if (!await fileMatches(item.source, item.original!, item.mode)) throw new HttpError(409, `Patch source changed concurrently: ${item.hunk.path}`)
        await rm(item.source)
        metadata.moved.push({ from: item.hunk.path, to: item.hunk.movePath! })
      } else {
        if (!await fileMatches(item.source, item.original!, item.mode)) throw new HttpError(409, `Patch source changed concurrently: ${item.hunk.path}`)
        await atomicWrite(root, item.source, item.content!, item.mode)
        metadata.updated.push(item.hunk.path)
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown commit error"
    const completed = [
      ...metadata.added.map((path) => `A ${path}`),
      ...metadata.updated.map((path) => `M ${path}`),
      ...metadata.deleted.map((path) => `D ${path}`),
      ...metadata.moved.map((move) => `R ${move.from} -> ${move.to}`),
    ]
    throw new HttpError(500, `Patch commit failed: ${reason}. ${completed.length === 0 ? "No operations completed." : `Operations completed before failure: ${completed.join(", ")}`}`)
  }
  const lines = [
    ...metadata.added.map((path) => `A ${path}`),
    ...metadata.updated.map((path) => `M ${path}`),
    ...metadata.deleted.map((path) => `D ${path}`),
    ...metadata.moved.map((move) => `R ${move.from} -> ${move.to}`),
  ]
  return { title: "Applied patch", output: lines.join("\n"), metadata }
}

async function fileMatches(path: string, content: string, mode = 0o600): Promise<boolean> {
  try {
    const metadata = await lstat(path)
    return metadata.isFile() && (metadata.mode & 0o7777) === mode && await readFile(path, "utf8") === content
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false
    throw error
  }
}

const terminatingProcesses = new WeakSet<ChildProcess>()

function killProcess(child: ChildProcess): void {
  if (terminatingProcesses.has(child)) return
  if (child.exitCode !== null || child.signalCode !== null) return
  terminatingProcesses.add(child)
  const processGroup = process.platform !== "win32" && child.pid !== undefined
  const signal = (name: NodeJS.Signals) => {
    try {
      if (processGroup) process.kill(-child.pid!, name)
      else child.kill(name)
    } catch {
      // The process group exited between the state check and signal.
    }
  }
  signal("SIGTERM")
  const force = setTimeout(() => {
    signal("SIGKILL")
  }, 1_000)
  force.unref()
  // A direct shell can exit while a TERM-resistant process remains in its group.
  if (!processGroup) child.once("exit", () => clearTimeout(force))
}

async function bashTool(root: string, body: Record<string, unknown>, signal: AbortSignal): Promise<ReadableStream<BashStreamEvent>> {
  const timeout = optionalPositiveInteger(body.timeout, "timeout")
  if (timeout !== undefined && timeout > MAX_TIMEOUT_MS) throw new HttpError(400, "timeout is too large")
  const args: BashArgs = {
    command: requiredString(body.command, "command"),
    description: body.description === undefined ? undefined : requiredString(body.description, "description"),
    timeout,
    workdir: body.workdir === undefined ? undefined : requiredString(body.workdir, "workdir"),
  }
  const cwd = args.workdir === undefined ? root : await existingPath(root, args.workdir)
  const cwdStat = await lstat(cwd)
  if (!cwdStat.isDirectory()) throw new HttpError(400, "workdir must refer to a directory")

  const child = spawn("bash", ["-lc", args.command], {
    cwd,
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const started = Date.now()
  let timedOut = false
  let aborted = signal.aborted
  let timeoutHandle: NodeJS.Timeout | undefined
  if (args.timeout !== undefined) {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      killProcess(child)
    }, args.timeout)
    timeoutHandle.unref()
  }
  const onAbort = () => {
    aborted = true
    killProcess(child)
  }
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()

  let canceled = false
  const outputSources = [child.stdout!, child.stderr!]
  const stream = new ReadableStream<BashStreamEvent>({
    start(controller) {
      let closed = false
      let output = ""
      let outputBytes = 0
      let outputTruncated = false
      const send = (event: BashStreamEvent) => {
        if (closed || canceled) return
        try {
          controller.enqueue(event)
          if ((controller.desiredSize ?? 0) <= 0) outputSources.forEach((source) => source.pause())
        } catch {
          canceled = true
          killProcess(child)
        }
      }
      const pipe = (type: "stdout" | "stderr", source: NodeJS.ReadableStream) => {
        const decoder = new StringDecoder("utf8")
        source.on("data", (chunk: Buffer) => {
          const data = decoder.write(chunk)
          if (data) {
            const remaining = MAX_BASH_OUTPUT_BYTES - outputBytes
            if (remaining > 0) {
              const captured = Buffer.from(data).subarray(0, remaining).toString("utf8")
              output += captured
              outputBytes += Buffer.byteLength(captured)
            }
            if (Buffer.byteLength(data) > remaining) outputTruncated = true
            send({ type, data })
          }
        })
        source.on("end", () => {
          const data = decoder.end()
          if (data) {
            const remaining = MAX_BASH_OUTPUT_BYTES - outputBytes
            if (remaining > 0) {
              const captured = Buffer.from(data).subarray(0, remaining).toString("utf8")
              output += captured
              outputBytes += Buffer.byteLength(captured)
            }
            if (Buffer.byteLength(data) > remaining) outputTruncated = true
            send({ type, data })
          }
        })
      }
      pipe("stdout", child.stdout!)
      pipe("stderr", child.stderr!)
      child.once("error", (error) => send({ type: "stderr", data: `${error.message}\n` }))
      child.once("close", (exitCode, exitSignal) => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        signal.removeEventListener("abort", onAbort)
        const metadata: Omit<BashMetadata, "outputTruncated"> = {
          command: args.command,
          ...(args.description === undefined ? {} : { description: args.description }),
          workdir: displayPath(root, cwd),
          exitCode,
          signal: exitSignal,
          timedOut,
          aborted,
          durationMs: Date.now() - started,
        }
        send({
          type: "result",
          outcome: "completed",
          title: args.description ?? "Bash command",
          output: output || (timedOut ? "Command timed out" : aborted ? "Command aborted" : "Command completed without output"),
          metadata: { ...metadata, outputTruncated },
        })
        closed = true
        controller.close()
      })
    },
    pull() {
      outputSources.forEach((source) => source.resume())
    },
    cancel() {
      canceled = true
      outputSources.forEach((source) => source.pause())
      killProcess(child)
    },
  })
  return stream
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const configuredRoot = resolve(options.workspaceRoot)
  const shutdownController = new AbortController()
  return {
    async execute(name, body, signal = new AbortController().signal) {
      const combinedSignal = AbortSignal.any([signal, shutdownController.signal])
      combinedSignal.throwIfAborted()
      const root = await realpath(configuredRoot)
      combinedSignal.throwIfAborted()
      if (name === "write") return { type: "result", ...await writeTool(root, body) }
      if (name === "edit") return { type: "result", ...await editTool(root, body) }
      if (name === "patch") return { type: "result", ...await patchTool(root, body) }
      if (name === "read") return { type: "result", ...await readTool(root, body) }
      if (name === "glob") return { type: "result", ...await globTool(root, body, combinedSignal) }
      if (name === "grep") return { type: "result", ...await grepTool(root, body, combinedSignal) }
      return await bashTool(root, body, combinedSignal)
    },
    shutdown() {
      shutdownController.abort()
    },
  }
}
