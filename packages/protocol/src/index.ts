export const TOOL_PATHS = {
  read: "/v1/tools/read",
  write: "/v1/tools/write",
  bash: "/v1/tools/bash",
  glob: "/v1/tools/glob",
  grep: "/v1/tools/grep",
  edit: "/v1/tools/edit",
  patch: "/v1/tools/patch",
} as const

export const LIFECYCLE_PATHS = [
  "/aws/lambda-microvms/runtime/v1/run",
  "/aws/lambda-microvms/runtime/v1/resume",
  "/aws/lambda-microvms/runtime/v1/suspend",
  "/aws/lambda-microvms/runtime/v1/terminate",
  "/aws/lambda-microvms/runtime/v1/ready",
  "/aws/lambda-microvms/runtime/v1/validate",
] as const

export interface ReadArgs {
  filePath: string
  /** First line to return, starting at 1. */
  offset?: number
  limit?: number
}

export interface WriteArgs {
  filePath: string
  content: string
}

export interface BashArgs {
  command: string
  description?: string
  timeout?: number
  workdir?: string
}

export interface GlobArgs {
  pattern: string
  path?: string
}

export interface GrepArgs {
  pattern: string
  path?: string
  include?: string
}

export interface EditArgs {
  filePath: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

export interface PatchArgs {
  patchText: string
}

export interface ToolResponse<Metadata extends Record<string, unknown> = Record<string, unknown>> {
  title: string
  output: string
  metadata: Metadata
}

export interface ReadMetadata extends Record<string, unknown> {
  filePath: string
  type?: "text" | "directory"
  offset: number
  lines?: number
  totalLines?: number
  entries?: number
  truncated?: boolean
  next?: number
}

export interface WriteMetadata extends Record<string, unknown> {
  filePath: string
  bytes: number
}

export interface BashMetadata extends Record<string, unknown> {
  command: string
  description?: string
  workdir: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

export interface GlobMetadata extends Record<string, unknown> {
  pattern: string
  path: string
  count: number
  truncated: boolean
}

export interface GrepMetadata extends Record<string, unknown> {
  pattern: string
  path: string
  include?: string
  matches: number
  truncated: boolean
}

export interface EditMetadata extends Record<string, unknown> {
  filePath: string
  replacements: number
  bytes: number
}

export interface PatchMetadata extends Record<string, unknown> {
  added: string[]
  updated: string[]
  deleted: string[]
  moved: Array<{ from: string; to: string }>
}

export type BashStreamEvent =
  | { type: "stdout" | "stderr"; data: string }
  | ({ type: "result" } & ToolResponse<BashMetadata>)
