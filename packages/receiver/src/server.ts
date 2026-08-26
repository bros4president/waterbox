import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { Readable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcess } from "node:child_process"
import {
  createBashTool as createPiBashTool,
  createEditTool as createPiEditTool,
  createFindTool as createPiFindTool,
  createGrepTool as createPiGrepTool,
  createLsTool as createPiLsTool,
  createReadTool as createPiReadTool,
  createWriteTool as createPiWriteTool,
} from "@earendil-works/pi-coding-agent"
import {
  LIFECYCLE_PATHS,
  TOOL_PATHS,
  type BashArgs,
  type BashMetadata,
  type BashStreamEvent,
  type EditArgs,
  type EditMetadata,
  type GlobArgs,
  type GlobMetadata,
  type GrepArgs,
  type GrepMetadata,
  type PatchArgs,
  type PatchMetadata,
  type ReadArgs,
  type ReadMetadata,
  type ToolResponse,
  type WriteArgs,
  type WriteMetadata,
} from "../../protocol/src/index.ts"
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

const MAX_BODY_BYTES = 1_048_576
const MAX_BASH_OUTPUT_BYTES = 1_048_576
const MAX_TIMEOUT_MS = 2_147_483_647
const lifecyclePaths = new Set<string>(LIFECYCLE_PATHS)
const PI_TOOL_PREFIX = "/v1/pi/tools/"

interface PiTool {
  name: string
  description: string
  parameters: unknown
  execute(toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

function createPiTools(root: string): Map<string, PiTool> {
  const tools = [
    createPiReadTool(root),
    createPiBashTool(root),
    createPiEditTool(root),
    createPiWriteTool(root),
    createPiGrepTool(root),
    createPiFindTool(root),
    createPiLsTool(root),
  ] as PiTool[]
  return new Map(tools.map((tool) => [tool.name, tool]))
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface ReceiverOptions {
  workspaceRoot?: string
}

export interface Receiver {
  handleRequest(request: Request): Promise<Response>
  shutdown(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `${name} must be a non-empty string`)
  }
  return value
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new HttpError(400, `${name} must be a positive integer`)
  }
  return value as number
}

async function parseJson(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body is too large")
  }

  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, "A JSON request body is required")
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new HttpError(413, "Request body is too large")
    }
    chunks.push(value)
  }

  let parsed: unknown
  try {
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
    parsed = JSON.parse(body)
  } catch {
    throw new HttpError(400, "Request body must be valid JSON")
  }
  if (!isRecord(parsed)) throw new HttpError(400, "Request body must be a JSON object")
  return parsed
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } })
}

function errorResponse(error: unknown): Response {
  const status = expectedStatus(error)
  const output = error instanceof HttpError || (error instanceof Error && status < 500) ? error.message : "Internal server error"
  return jsonResponse({ title: "Error", output, metadata: { status } }, status)
}

function expectedStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status
  if (isRecord(error) && error.code === "ENOENT") return 404
  if (isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY")) return 409
  if (error instanceof EditTextError) return error.code === "empty-search" || error.code === "identical" ? 400 : 409
  if (error instanceof BoundaryError || error instanceof InvalidHunkError || error instanceof BinaryFileError || error instanceof PathKindError || error instanceof RangeError || error instanceof RipgrepError) {
    return error instanceof RipgrepTimeoutError ? 409 : 400
  }
  if (error instanceof DOMException && error.name === "AbortError") return 409
  return 500
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HttpError(400, "Path must stay inside the workspace")
  }
}

function lexicalPath(root: string, input: string): string {
  if (input.includes("\0")) throw new HttpError(400, "Path contains a null byte")
  const candidate = resolve(root, input)
  assertContained(root, candidate)
  return candidate
}

async function rejectSymlinkComponents(root: string, candidate: string, allowMissing: boolean): Promise<void> {
  const rel = relative(root, candidate)
  let current = root
  for (const component of rel.split(sep).filter(Boolean)) {
    current = resolve(current, component)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new HttpError(400, "Symbolic links are not allowed in workspace paths")
    } catch (error) {
      if (allowMissing && isRecord(error) && error.code === "ENOENT") return
      throw error
    }
  }
}

async function existingPath(root: string, input: string): Promise<string> {
  const candidate = lexicalPath(root, input)
  await rejectSymlinkComponents(root, candidate, false)
  const canonical = await realpath(candidate)
  assertContained(root, canonical)
  return canonical
}

async function ensureParent(root: string, candidate: string): Promise<string> {
  const parent = dirname(candidate)
  await rejectSymlinkComponents(root, parent, true)
  const rel = relative(root, parent)
  let current = root
  for (const component of rel.split(sep).filter(Boolean)) {
    current = resolve(current, component)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new HttpError(400, "Write parent must be a directory without symbolic links")
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error
      await mkdir(current)
      const created = await lstat(current)
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new HttpError(400, "Write parent changed while it was being created")
      }
    }
  }
  const canonical = await realpath(parent)
  assertContained(root, canonical)
  return canonical
}

async function preflightParent(root: string, candidate: string): Promise<void> {
  const rel = relative(root, dirname(candidate))
  let current = root
  for (const component of rel.split(sep).filter(Boolean)) {
    current = resolve(current, component)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new HttpError(400, "Write parent must be a directory without symbolic links")
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return
      throw error
    }
  }
}

async function readTool(root: string, body: Record<string, unknown>): Promise<ToolResponse<ReadMetadata>> {
  const args: ReadArgs = {
    filePath: requiredString(body.filePath, "filePath"),
    offset: optionalPositiveInteger(body.offset, "offset"),
    limit: optionalPositiveInteger(body.limit, "limit"),
  }
  const path = await existingPath(root, args.filePath)
  const result = await readFilesystem(path, args)
  const filePath = relative(root, path) || "."
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
  await rejectSymlinkComponents(root, target, true)
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
    await rejectSymlinkComponents(root, target, true)
    await rename(temp, target)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

async function existingMode(root: string, target: string): Promise<number | undefined> {
  await rejectSymlinkComponents(root, target, true)
  try {
    const stat = await lstat(target)
    if (!stat.isFile()) throw new HttpError(400, "filePath must refer to a regular file")
    return stat.mode & 0o7777
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

async function writeTool(root: string, body: Record<string, unknown>): Promise<ToolResponse<WriteMetadata>> {
  const args: WriteArgs = {
    filePath: requiredString(body.filePath, "filePath"),
    content: typeof body.content === "string" ? body.content : (() => { throw new HttpError(400, "content must be a string") })(),
  }
  const target = lexicalPath(root, args.filePath)
  const mode = await existingMode(root, target)
  await atomicWrite(root, target, args.content, mode)
  return {
    title: `Wrote ${relative(root, target)}`,
    output: "File written successfully",
    metadata: { filePath: relative(root, target), bytes: Buffer.byteLength(args.content) },
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
  return { path: target, label: relative(root, target) || "." }
}

async function searchTarget(root: string, path: string | undefined): Promise<{ target: string; label: string }> {
  const target = path === undefined ? root : await existingPath(root, path)
  const stat = await lstat(target)
  if (!stat.isDirectory() && !stat.isFile()) throw new HttpError(400, "path must refer to a regular file or directory")
  const label = relative(root, target) || "."
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
  const filePath = relative(root, source.path)
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
        throw new HttpError(409, `Patch contains conflicting operations for ${relative(root, path)}`)
      }
      touched.add(path)
    }
    await rejectSymlinkComponents(root, source, hunk.type === "add")
    if (destination !== undefined) await rejectSymlinkComponents(root, destination, true)

    if (hunk.type === "add") {
      if (await pathExists(source)) throw new HttpError(409, `Cannot add existing path: ${hunk.path}`)
      await preflightParent(root, source)
      prepared.push({ hunk, source, content: hunk.contents })
      continue
    }
    const current = await readEditable(root, hunk.path)
    if (destination !== undefined && await pathExists(destination)) {
      throw new HttpError(409, `Move destination already exists: ${relative(root, destination)}`)
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
  const applied: PreparedPatch[] = []
  try {
    for (const item of prepared) {
      if (item.hunk.type === "delete") {
        await rejectSymlinkComponents(root, item.source, false)
        await rm(item.source)
        applied.push(item)
        metadata.deleted.push(item.hunk.path)
      } else if (item.hunk.type === "add") {
        await atomicWrite(root, item.source, item.content!)
        applied.push(item)
        metadata.added.push(item.hunk.path)
      } else if (item.destination !== undefined) {
        await atomicWrite(root, item.destination, item.content!, item.mode)
        applied.push(item)
        await rejectSymlinkComponents(root, item.source, false)
        await rm(item.source)
        metadata.moved.push({ from: item.hunk.path, to: item.hunk.movePath! })
      } else {
        await atomicWrite(root, item.source, item.content!, item.mode)
        applied.push(item)
        metadata.updated.push(item.hunk.path)
      }
    }
  } catch (error) {
    const failures = await rollbackPatch(root, applied)
    const reason = error instanceof Error ? error.message : "unknown commit error"
    const rollback = failures.length === 0
      ? "Applied operations were rolled back."
      : `Rollback was incomplete: ${failures.join("; ")}`
    throw new HttpError(500, `Patch commit failed: ${reason}. ${rollback}`)
  }
  const lines = [
    ...metadata.added.map((path) => `A ${path}`),
    ...metadata.updated.map((path) => `M ${path}`),
    ...metadata.deleted.map((path) => `D ${path}`),
    ...metadata.moved.map((move) => `R ${move.from} -> ${move.to}`),
  ]
  return { title: "Applied patch", output: lines.join("\n"), metadata }
}

async function rollbackPatch(root: string, applied: PreparedPatch[]): Promise<string[]> {
  const failures: string[] = []
  const attempt = async (description: string, operation: () => Promise<void>) => {
    try {
      await operation()
    } catch (error) {
      failures.push(`${description}: ${error instanceof Error ? error.message : "unknown error"}`)
    }
  }
  for (const item of [...applied].reverse()) {
    if (item.hunk.type === "add") {
      await attempt(`remove ${item.hunk.path}`, async () => {
        if (!await pathExists(item.source)) return
        await rejectSymlinkComponents(root, item.source, false)
        await rm(item.source)
      })
      continue
    }
    if (item.destination !== undefined) {
      await attempt(`remove ${relative(root, item.destination)}`, async () => {
        if (!await pathExists(item.destination!)) return
        await rejectSymlinkComponents(root, item.destination!, false)
        await rm(item.destination!)
      })
    }
    await attempt(`restore ${item.hunk.path}`, () => atomicWrite(root, item.source, item.original!, item.mode))
  }
  return failures
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

function killProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM")
    else child.kill("SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
  const force = setTimeout(() => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
      else child.kill("SIGKILL")
    } catch {
      // The process exited between the state check and signal.
    }
  }, 1_000)
  force.unref()
  child.once("exit", () => clearTimeout(force))
}

async function bashTool(root: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
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
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      let closed = false
      let output = ""
      let outputBytes = 0
      let outputTruncated = false
      const send = (event: BashStreamEvent) => {
        if (closed || canceled) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
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
        const metadata: BashMetadata = {
          command: args.command,
          ...(args.description === undefined ? {} : { description: args.description }),
          workdir: relative(root, cwd) || ".",
          exitCode,
          signal: exitSignal,
          timedOut,
          aborted,
          durationMs: Date.now() - started,
        }
        send({
          type: "result",
          title: args.description ?? "Bash command",
          output: output || (timedOut ? "Command timed out" : aborted ? "Command aborted" : "Command completed without output"),
          metadata: { ...metadata, outputTruncated },
        })
        closed = true
        controller.close()
      })
    },
    cancel() {
      canceled = true
      killProcess(child)
    },
  })
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  })
}

export function createReceiver(options: ReceiverOptions = {}): Receiver {
  const configuredRoot = resolve(options.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? "/workspace")
  const shutdownController = new AbortController()
  let piTools: Promise<Map<string, PiTool>> | undefined
  const getPiTools = () => piTools ??= realpath(configuredRoot).then(createPiTools)
  let mutations: Promise<void> = Promise.resolve()
  const mutate = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = mutations.then(operation, operation)
    mutations = result.then(() => undefined, () => undefined)
    return result
  }
  return {
    async handleRequest(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        if (request.method === "GET" && url.pathname === "/health") {
          return jsonResponse({ status: "ok" })
        }
        if (request.method === "GET" && url.pathname === "/v1/pi/tools") {
          const tools = await getPiTools()
          return jsonResponse([...tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })))
        }
        if (request.method === "POST" && lifecyclePaths.has(url.pathname)) {
          return new Response(null, { status: 204 })
        }
        if (request.method !== "POST") throw new HttpError(404, "Not found")
        if (url.pathname.startsWith(PI_TOOL_PREFIX)) {
          const name = url.pathname.slice(PI_TOOL_PREFIX.length)
          const tool = (await getPiTools()).get(name)
          if (!tool || name.includes("/")) throw new HttpError(404, "Not found")
          const body = await parseJson(request)
          try {
            return jsonResponse(await tool.execute(crypto.randomUUID(), body, request.signal))
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error)
            return jsonResponse({ content: [{ type: "text", text }], isError: true })
          }
        }
        if (
          url.pathname !== TOOL_PATHS.read &&
          url.pathname !== TOOL_PATHS.write &&
          url.pathname !== TOOL_PATHS.edit &&
          url.pathname !== TOOL_PATHS.patch &&
          url.pathname !== TOOL_PATHS.glob &&
          url.pathname !== TOOL_PATHS.grep &&
          url.pathname !== TOOL_PATHS.bash
        ) {
          throw new HttpError(404, "Not found")
        }
        const root = await realpath(configuredRoot)
        const body = await parseJson(request)
        if (url.pathname === TOOL_PATHS.read) return jsonResponse(await readTool(root, body))
        if (url.pathname === TOOL_PATHS.write) return jsonResponse(await mutate(() => writeTool(root, body)))
        if (url.pathname === TOOL_PATHS.edit) return jsonResponse(await mutate(() => editTool(root, body)))
        if (url.pathname === TOOL_PATHS.patch) return jsonResponse(await mutate(() => patchTool(root, body)))

        const requestAbort = new AbortController()
        const abort = () => requestAbort.abort()
        request.signal.addEventListener("abort", abort, { once: true })
        shutdownController.signal.addEventListener("abort", abort, { once: true })
        if (request.signal.aborted || shutdownController.signal.aborted) abort()
        if (url.pathname === TOOL_PATHS.glob) {
          try {
            return jsonResponse(await globTool(root, body, requestAbort.signal))
          } finally {
            request.signal.removeEventListener("abort", abort)
            shutdownController.signal.removeEventListener("abort", abort)
          }
        }
        if (url.pathname === TOOL_PATHS.grep) {
          try {
            return jsonResponse(await grepTool(root, body, requestAbort.signal))
          } finally {
            request.signal.removeEventListener("abort", abort)
            shutdownController.signal.removeEventListener("abort", abort)
          }
        }
        if (url.pathname === TOOL_PATHS.bash) return await bashTool(root, body, requestAbort.signal)
        request.signal.removeEventListener("abort", abort)
        shutdownController.signal.removeEventListener("abort", abort)
        throw new HttpError(404, "Not found")
      } catch (error) {
        return errorResponse(error)
      }
    },
    shutdown() {
      shutdownController.abort()
    },
  }
}

export const handleRequest = createReceiver().handleRequest

async function sendNodeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) return void outgoing.end()
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!outgoing.write(value)) {
      await new Promise<void>((resolveDrain) => {
        outgoing.once("drain", resolveDrain)
        outgoing.once("close", resolveDrain)
      })
    }
  }
  outgoing.end()
}

function nodeRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
  const method = incoming.method ?? "GET"
  const init: RequestInit & { duplex?: "half" } = { method, headers: incoming.headers as HeadersInit, signal }
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(incoming) as unknown as ReadableStream
    init.duplex = "half"
  }
  return new Request(`http://localhost${incoming.url ?? "/"}`, init)
}

export function createNodeServer(receiver: Receiver = createReceiver()): Server {
  return createServer(async (incoming, outgoing) => {
    const controller = new AbortController()
    incoming.once("aborted", () => controller.abort())
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) controller.abort()
    })
    try {
      await sendNodeResponse(await receiver.handleRequest(nodeRequest(incoming, controller.signal)), outgoing)
    } catch (error) {
      controller.abort()
      if (!outgoing.headersSent) await sendNodeResponse(errorResponse(error), outgoing)
      else outgoing.destroy(error instanceof Error ? error : undefined)
    }
  })
}

export async function startServer(options: ReceiverOptions & { port?: number } = {}): Promise<Server> {
  const receiver = createReceiver(options)
  const server = createNodeServer(receiver)
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? Number(process.env.PORT ?? 8080), "0.0.0.0", () => {
      server.off("error", reject)
      resolveListening()
    })
  })

  const shutdown = () => {
    receiver.shutdown()
    server.close()
    const force = setTimeout(() => server.closeAllConnections(), 5_000)
    force.unref()
  }
  const signalProcess = process as unknown as {
    once(signal: "SIGTERM" | "SIGINT", listener: () => void): void
    off(signal: "SIGTERM" | "SIGINT", listener: () => void): void
  }
  signalProcess.once("SIGTERM", shutdown)
  signalProcess.once("SIGINT", shutdown)
  server.once("close", () => {
    signalProcess.off("SIGTERM", shutdown)
    signalProcess.off("SIGINT", shutdown)
  })
  return server
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : ""
if (entrypoint === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
