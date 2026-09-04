import { z } from "zod"

const NonEmptyStringSchema = z.string().min(1)
const PositiveIntegerSchema = z.number().int().positive()
export const FilePathSchema = NonEmptyStringSchema.max(4_096)

export const ToolNameSchema = z.enum(["read", "write", "edit", "patch", "glob", "grep", "bash"])
export const MAX_BASH_OUTPUT_BYTES = 1_048_576
// A 1 MiB Bash byte stream can require nearly 6 MiB as JSON (for example, \u0000).
// This leaves room for result metadata without reducing the raw output contract.
export const MAX_TOOL_RESULT_BYTES = 8 * 1_024 * 1_024
export const BashJobIdSchema = z.string().regex(/^job_[0-9a-f]{32}$/)

export const ReadToolArgumentsSchema = z.object({
  filePath: FilePathSchema,
  offset: PositiveIntegerSchema.optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict()

export const WriteToolArgumentsSchema = z.object({
  filePath: FilePathSchema,
  content: z.string(),
}).strict()

export const EditToolArgumentsSchema = z.object({
  filePath: FilePathSchema,
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
}).strict()

export const PatchToolArgumentsSchema = z.object({
  patchText: NonEmptyStringSchema,
}).strict()

export const GlobToolArgumentsSchema = z.object({
  pattern: NonEmptyStringSchema,
  path: FilePathSchema.optional(),
}).strict()

export const GrepToolArgumentsSchema = z.object({
  pattern: NonEmptyStringSchema,
  path: FilePathSchema.optional(),
  include: NonEmptyStringSchema.optional(),
}).strict()

export const BashToolArgumentsSchema = z.object({
  command: NonEmptyStringSchema,
  description: z.string().optional(),
  timeout: z.number().int().positive().max(2_147_483_647).optional(),
  workdir: FilePathSchema.optional(),
}).strict()

const ToolResultBaseShape = {
  title: z.string().min(1),
  output: z.string(),
}

export const ReadToolResultSchema = z.object({
  ...ToolResultBaseShape,
  metadata: z.object({
    filePath: FilePathSchema,
    type: z.enum(["text", "directory"]).optional(),
    offset: PositiveIntegerSchema,
    lines: z.number().int().nonnegative().optional(),
    totalLines: z.number().int().nonnegative().optional(),
    entries: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    next: PositiveIntegerSchema.optional(),
  }).strict(),
}).strict()

export const WriteToolResultSchema = z.object({
  ...ToolResultBaseShape,
  metadata: z.object({ filePath: FilePathSchema, bytes: z.number().int().nonnegative() }).strict(),
}).strict()

export const EditToolResultSchema = z.object({
  ...ToolResultBaseShape,
  metadata: z.object({
    filePath: FilePathSchema,
    replacements: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }).strict(),
}).strict()

export const PatchToolResultSchema = z.object({
  ...ToolResultBaseShape,
  metadata: z.object({
    added: z.array(z.string()),
    updated: z.array(z.string()),
    deleted: z.array(z.string()),
    moved: z.array(z.object({ from: z.string(), to: z.string() }).strict()),
  }).strict(),
}).strict()

export const GlobToolResultSchema = z.object({
  ...ToolResultBaseShape,
  metadata: z.object({
    pattern: z.string(),
    path: z.string(),
    count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict(),
}).strict()

export const GrepToolResultSchema = z.object({
  ...ToolResultBaseShape,
  metadata: z.object({
    pattern: z.string(),
    path: z.string(),
    include: z.string().optional(),
    matches: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict(),
}).strict()

export const CompletedBashToolResultSchema = z.object({
  ...ToolResultBaseShape,
  outcome: z.literal("completed"),
  metadata: z.object({
    command: z.string(),
    description: z.string().optional(),
    workdir: z.string(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    durationMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  }).strict(),
}).strict()

const DispatchedBashToolResultObjectSchema = z.object({
  ...ToolResultBaseShape,
  outcome: z.literal("dispatched"),
  metadata: z.object({
    command: z.string(),
    description: z.string().optional(),
    workdir: z.string(),
    timeout: PositiveIntegerSchema.max(2_147_483_647).optional(),
    jobId: BashJobIdSchema,
    outputPath: FilePathSchema,
    statusPath: FilePathSchema,
  }).strict(),
}).strict()

function validateReceiptPaths(value: z.infer<typeof DispatchedBashToolResultObjectSchema>, context: z.RefinementCtx): void {
  const root = `/run/waterbox/bash-jobs/${value.metadata.jobId}`
  if (value.metadata.outputPath !== `${root}/output.log` || value.metadata.statusPath !== `${root}/status.json`) {
    context.addIssue({ code: "custom", path: ["metadata"], message: "Recovery paths must match jobId" })
  }
}

export const DispatchedBashToolResultSchema = DispatchedBashToolResultObjectSchema.superRefine(validateReceiptPaths)

export const BashToolResultSchema = z.discriminatedUnion("outcome", [
  CompletedBashToolResultSchema,
  DispatchedBashToolResultSchema,
])
export const ToolResultSchema = z.union([ReadToolResultSchema, WriteToolResultSchema, EditToolResultSchema, PatchToolResultSchema, GlobToolResultSchema, GrepToolResultSchema, BashToolResultSchema])

export const BashToolEventSchema = z.union([
  z.object({ type: z.literal("stdout"), data: z.string() }).strict(),
  z.object({ type: z.literal("stderr"), data: z.string() }).strict(),
  CompletedBashToolResultSchema.extend({ type: z.literal("result") }),
  DispatchedBashToolResultObjectSchema.extend({ type: z.literal("result") }).superRefine(validateReceiptPaths),
])

export const BashJobObservationRequestSchema = z.object({
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxBytes: z.number().int().min(1).max(65_536),
}).strict()

export const BashJobObservationSchema = z.object({
  jobId: BashJobIdSchema,
  state: z.enum(["starting", "running", "completed", "failed"]),
  chunkBase64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  nextOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
  timedOut: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
  error: z.enum(["spawn_failed", "worker_failed"]).optional(),
}).strict().refine(value => value.outputSize >= value.nextOffset, {
  path: ["outputSize"],
  message: "Output size must include the observed offset",
})

export type ToolName = z.infer<typeof ToolNameSchema>
export type ReadToolArguments = z.infer<typeof ReadToolArgumentsSchema>
export type WriteToolArguments = z.infer<typeof WriteToolArgumentsSchema>
export type EditToolArguments = z.infer<typeof EditToolArgumentsSchema>
export type PatchToolArguments = z.infer<typeof PatchToolArgumentsSchema>
export type GlobToolArguments = z.infer<typeof GlobToolArgumentsSchema>
export type GrepToolArguments = z.infer<typeof GrepToolArgumentsSchema>
export type BashToolArguments = z.infer<typeof BashToolArgumentsSchema>
export type ReadToolResult = z.infer<typeof ReadToolResultSchema>
export type WriteToolResult = z.infer<typeof WriteToolResultSchema>
export type EditToolResult = z.infer<typeof EditToolResultSchema>
export type PatchToolResult = z.infer<typeof PatchToolResultSchema>
export type GlobToolResult = z.infer<typeof GlobToolResultSchema>
export type GrepToolResult = z.infer<typeof GrepToolResultSchema>
export type BashToolResult = z.infer<typeof BashToolResultSchema>
export type CompletedBashToolResult = z.infer<typeof CompletedBashToolResultSchema>
export type DispatchedBashToolResult = z.infer<typeof DispatchedBashToolResultSchema>
export type BashToolEvent = z.infer<typeof BashToolEventSchema>
export type BashJobObservationRequest = z.infer<typeof BashJobObservationRequestSchema>
export type BashJobObservation = z.infer<typeof BashJobObservationSchema>

export interface ToolArgumentsByName {
  read: ReadToolArguments
  write: WriteToolArguments
  edit: EditToolArguments
  patch: PatchToolArguments
  glob: GlobToolArguments
  grep: GrepToolArguments
  bash: BashToolArguments
}

export interface ToolResultByName {
  read: ReadToolResult
  write: WriteToolResult
  edit: EditToolResult
  patch: PatchToolResult
  glob: GlobToolResult
  grep: GrepToolResult
  bash: BashToolResult
}
