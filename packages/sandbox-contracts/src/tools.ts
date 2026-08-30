import { z } from "zod"

const NonEmptyStringSchema = z.string().min(1)
const PositiveIntegerSchema = z.number().int().positive()
export const FilePathSchema = NonEmptyStringSchema.max(4_096)

export const ToolNameSchema = z.enum(["read", "write", "edit", "patch", "glob", "grep", "bash"])

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

export const DispatchedBashToolResultSchema = z.object({
  ...ToolResultBaseShape,
  outcome: z.literal("dispatched"),
  metadata: z.object({
    command: z.string(),
    description: z.string().optional(),
    workdir: z.string(),
    timeout: PositiveIntegerSchema.max(2_147_483_647).optional(),
    jobId: z.string().regex(/^job_[0-9a-f]{32}$/),
    outputPath: FilePathSchema,
    statusPath: FilePathSchema,
    pollAfterMs: PositiveIntegerSchema,
  }).strict(),
}).strict()

export const BashToolResultSchema = z.discriminatedUnion("outcome", [
  CompletedBashToolResultSchema,
  DispatchedBashToolResultSchema,
])

export const ReadToolEventSchema = ReadToolResultSchema.extend({ type: z.literal("result") })
export const WriteToolEventSchema = WriteToolResultSchema.extend({ type: z.literal("result") })
export const EditToolEventSchema = EditToolResultSchema.extend({ type: z.literal("result") })
export const PatchToolEventSchema = PatchToolResultSchema.extend({ type: z.literal("result") })
export const GlobToolEventSchema = GlobToolResultSchema.extend({ type: z.literal("result") })
export const GrepToolEventSchema = GrepToolResultSchema.extend({ type: z.literal("result") })
export const BashToolEventSchema = z.union([
  z.object({ type: z.literal("stdout"), data: z.string() }).strict(),
  z.object({ type: z.literal("stderr"), data: z.string() }).strict(),
  CompletedBashToolResultSchema.extend({ type: z.literal("result") }),
  DispatchedBashToolResultSchema.extend({ type: z.literal("result") }),
])

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
export type ReadToolEvent = z.infer<typeof ReadToolEventSchema>
export type WriteToolEvent = z.infer<typeof WriteToolEventSchema>
export type EditToolEvent = z.infer<typeof EditToolEventSchema>
export type PatchToolEvent = z.infer<typeof PatchToolEventSchema>
export type GlobToolEvent = z.infer<typeof GlobToolEventSchema>
export type GrepToolEvent = z.infer<typeof GrepToolEventSchema>
export type BashToolEvent = z.infer<typeof BashToolEventSchema>
