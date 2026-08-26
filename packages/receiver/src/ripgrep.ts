import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"

export const DEFAULT_RIPGREP_LIMIT = 2_000
export const DEFAULT_RIPGREP_TIMEOUT_MS = 10_000
export const MAX_LINE_PREVIEW = 2_000

export interface RipgrepOptions {
  limit?: number
  timeoutMs?: number
  signal?: AbortSignal
  globs?: readonly string[]
  /** File or directory to search, passed after `--` so it cannot be parsed as an option. */
  target?: string
}

export interface RipgrepGlobResult {
  paths: string[]
  truncated: boolean
}

export interface RipgrepSubmatch {
  text: string
  start: number
  end: number
}

export interface RipgrepMatch {
  path: string
  lineNumber: number
  line: string
  lineTruncated: boolean
  submatches: RipgrepSubmatch[]
}

export interface RipgrepSearchResult {
  matches: RipgrepMatch[]
  truncated: boolean
}

export class RipgrepError extends Error {
  constructor(message: string, readonly exitCode?: number) {
    super(message)
    this.name = "RipgrepError"
  }
}

export class RipgrepTimeoutError extends RipgrepError {
  constructor(timeoutMs: number) {
    super(`ripgrep timed out after ${timeoutMs}ms`)
    this.name = "RipgrepTimeoutError"
  }
}

export async function ripgrepGlob(root: string, pattern?: string, options: RipgrepOptions = {}): Promise<RipgrepGlobResult> {
  const args = ["--no-config", "--files", "--hidden", "--glob", "!.git", "--glob", "!.git/**"]
  if (pattern !== undefined) args.push("--glob", pattern)
  for (const glob of options.globs ?? []) args.push("--glob", glob)
  args.push(".")
  const paths: string[] = []
  const result = await runRipgrep(root, args, options, (line) => {
    paths.push(normalizePath(line))
    return paths.length > resultLimit(options)
  })
  if (paths.length > resultLimit(options)) paths.length = resultLimit(options)
  return { paths, truncated: result.stoppedForLimit }
}

export async function ripgrepSearch(root: string, pattern: string, options: RipgrepOptions = {}): Promise<RipgrepSearchResult> {
  const args = ["--no-config", "--json", "--hidden", "--no-messages", "--glob", "!.git", "--glob", "!.git/**"]
  for (const glob of options.globs ?? []) args.push("--glob", glob)
  const target = options.target ?? "."
  if (target.length === 0 || target.includes("\0")) throw new RangeError("target must be a non-empty path")
  args.push("--", pattern, target)
  const matches: RipgrepMatch[] = []
  const result = await runRipgrep(root, args, options, (line) => {
    const event = JSON.parse(line) as RgEvent
    if (event.type !== "match") return false
    const source = rgText(event.data.lines).replace(/\r?\n$/, "")
    matches.push({
      path: normalizePath(rgText(event.data.path)),
      lineNumber: event.data.line_number,
      line: source.slice(0, MAX_LINE_PREVIEW),
      lineTruncated: source.length > MAX_LINE_PREVIEW,
      submatches: event.data.submatches.map((match) => ({
        text: rgText(match.match),
        start: match.start,
        end: match.end,
      })),
    })
    return matches.length > resultLimit(options)
  })
  if (matches.length > resultLimit(options)) matches.length = resultLimit(options)
  return { matches, truncated: result.stoppedForLimit }
}

interface RgText {
  text?: string
  bytes?: string
}

interface RgEvent {
  type: string
  data: {
    path: RgText
    lines: RgText
    line_number: number
    submatches: Array<{ match: RgText; start: number; end: number }>
  }
}

function rgText(value: RgText): string {
  if (value.text !== undefined) return value.text
  if (value.bytes !== undefined) return Buffer.from(value.bytes, "base64").toString("utf8")
  return ""
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "")
}

function resultLimit(options: RipgrepOptions): number {
  const limit = options.limit ?? DEFAULT_RIPGREP_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer")
  return limit
}

async function runRipgrep(
  root: string,
  args: string[],
  options: RipgrepOptions,
  onLine: (line: string) => boolean,
): Promise<{ stoppedForLimit: boolean }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RIPGREP_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("timeoutMs must be a positive integer")
  if (options.signal?.aborted) throw abortError()

  const child = spawn("rg", args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
  let stderr = ""
  let stoppedForLimit = false
  let timedOut = false
  let aborted = false
  let settled = false
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const stop = () => kill(child)
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, timeoutMs)
  timer.unref()
  const onAbort = () => {
    aborted = true
    stop()
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 8_192) stderr += chunk.slice(0, 8_192 - stderr.length)
  })
  lines.on("line", (line) => {
    if (stoppedForLimit) return
    try {
      if (onLine(line)) {
        stoppedForLimit = true
        stop()
      }
    } catch (error) {
      lines.emit("error", error)
    }
  })

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      lines.close()
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      stop()
      reject(error)
    }
    lines.once("error", fail)
    child.once("error", fail)
    child.once("close", (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (aborted) return reject(abortError())
      if (timedOut) return reject(new RipgrepTimeoutError(timeoutMs))
      if (stoppedForLimit) return resolve({ stoppedForLimit: true })
      if (code === 0 || code === 1) return resolve({ stoppedForLimit: false })
      const detail = stderr.trim() || `ripgrep exited with code ${code ?? "unknown"}`
      reject(new RipgrepError(detail, code ?? undefined))
    })
  })
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError")
}

function kill(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const force = setTimeout(() => child.kill("SIGKILL"), 500)
  force.unref()
  child.once("close", () => clearTimeout(force))
}
