import { open, lstat, readdir } from "node:fs/promises"
import { basename, sep } from "node:path"

export const MAX_READ_LINES = 2_000
export const MAX_READ_BYTES = 50 * 1024
export const MAX_LINE_LENGTH = 2_000
const READ_CHUNK_BYTES = 64 * 1024

const LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

export interface ReadPageOptions {
  offset?: number
  limit?: number
}

export interface TextReadResult {
  type: "text"
  path: string
  name: string
  content: string
  offset: number
  lines: number
  totalLines: number
  truncated: boolean
  next?: number
}

export interface DirectoryEntry {
  path: string
  type: "file" | "directory" | "symlink"
}

export interface DirectoryReadResult {
  type: "directory"
  path: string
  entries: DirectoryEntry[]
  offset: number
  truncated: boolean
  next?: number
}

export type ReadFilesystemResult = TextReadResult | DirectoryReadResult

export class BinaryFileError extends Error {
  constructor(path: string) {
    super(`Cannot read binary file: ${path}`)
    this.name = "BinaryFileError"
  }
}

export class OffsetOutOfRangeError extends RangeError {
  constructor(offset: number) {
    super(`Offset ${offset} is out of range`)
    this.name = "OffsetOutOfRangeError"
  }
}

export class PathKindError extends Error {
  constructor(path: string) {
    super(`Path is not a regular file or directory: ${path}`)
    this.name = "PathKindError"
  }
}

/** Reads an already-canonicalized path without performing any path resolution. */
export async function readFilesystem(path: string, options: ReadPageOptions = {}): Promise<ReadFilesystemResult> {
  const { offset, limit } = page(options)
  const info = await lstat(path)
  if (info.isDirectory()) return readDirectory(path, offset, limit)
  if (!info.isFile()) throw new PathKindError(path)

  const handle = await open(path, "r")
  const decoder = new TextDecoder()
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  const selected: string[] = []
  let outputBytes = 0
  let next: number | undefined
  let totalLines = 0
  let lineLength = 0
  let linePrefix = ""
  let lastCharacter = ""
  let sawInput = false

  const consumeLine = () => {
    totalLines++
    const contentLength = lineLength - (lastCharacter === "\r" ? 1 : 0)
    const source = linePrefix.endsWith("\r") ? linePrefix.slice(0, -1) : linePrefix
    const text = contentLength > MAX_LINE_LENGTH ? source.slice(0, MAX_LINE_LENGTH) + LINE_SUFFIX : source
    lineLength = 0
    linePrefix = ""
    lastCharacter = ""
    if (totalLines < offset || next !== undefined) return
    if (selected.length >= limit || outputBytes >= MAX_READ_BYTES) {
      next = totalLines
      return
    }
    const size = Buffer.byteLength(text) + (selected.length === 0 ? 0 : 1)
    if (outputBytes + size > MAX_READ_BYTES) {
      next = totalLines
      return
    }
    selected.push(text)
    outputBytes += size
  }

  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      const bytes = buffer.subarray(0, bytesRead)
      if (bytes.includes(0)) throw new BinaryFileError(path)
      sawInput = true
      const decoded = decoder.decode(bytes, { stream: true })
      for (let index = 0; index < decoded.length; index++) {
        const character = decoded[index]!
        if (character === "\n") consumeLine()
        else {
          lineLength++
          lastCharacter = character
          if (linePrefix.length < MAX_LINE_LENGTH + 1) linePrefix += character
        }
      }
    }
    const remaining = decoder.decode()
    for (let index = 0; index < remaining.length; index++) {
      const character = remaining[index]!
      if (character === "\n") consumeLine()
      else {
        lineLength++
        lastCharacter = character
        if (linePrefix.length < MAX_LINE_LENGTH + 1) linePrefix += character
      }
    }
    if (lineLength > 0 || (sawInput && lastCharacter !== "")) consumeLine()
  } finally {
    await handle.close()
  }
  if (offset > 1 && offset > totalLines) throw new OffsetOutOfRangeError(offset)

  return {
    type: "text",
    path,
    name: basename(path),
    content: selected.join("\n"),
    offset,
    lines: selected.length,
    totalLines,
    truncated: next !== undefined,
    ...(next === undefined ? {} : { next }),
  }
}

async function readDirectory(path: string, offset: number, limit: number): Promise<DirectoryReadResult> {
  const entries: DirectoryEntry[] = (await readdir(path, { withFileTypes: true }))
    .flatMap((entry): DirectoryEntry[] => {
      if (entry.isDirectory()) return [{ path: entry.name + sep, type: "directory" }]
      if (entry.isFile()) return [{ path: entry.name, type: "file" }]
      if (entry.isSymbolicLink()) return [{ path: entry.name, type: "symlink" }]
      return []
    })
    .sort((left, right) => {
      if (left.type === "directory" && right.type !== "directory") return -1
      if (left.type !== "directory" && right.type === "directory") return 1
      return left.path.localeCompare(right.path)
    })
  if (offset > 1 && offset > entries.length) throw new OffsetOutOfRangeError(offset)
  const selected = entries.slice(offset - 1, offset - 1 + limit)
  const next = offset - 1 + selected.length < entries.length ? offset + selected.length : undefined
  return {
    type: "directory",
    path,
    entries: selected,
    offset,
    truncated: next !== undefined,
    ...(next === undefined ? {} : { next }),
  }
}

function page(options: ReadPageOptions): { offset: number; limit: number } {
  const offset = options.offset ?? 1
  const requestedLimit = options.limit ?? MAX_READ_LINES
  if (!Number.isSafeInteger(offset) || offset < 1) throw new RangeError("offset must be a positive integer")
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new RangeError("limit must be a positive integer")
  return { offset, limit: Math.min(requestedLimit, MAX_READ_LINES) }
}
