import { z } from "zod"
import { CursorPaginationRequestSchema } from "./pagination.ts"
import { SandboxIdSchema, SnapshotIdSchema } from "./resources.ts"
import { ToolNameSchema } from "./tools.ts"

export const IdempotencyKeySchema = z.string().min(1).max(255)

export const CreateSandboxRequestSchema = z.object({
  sourceSnapshotId: SnapshotIdSchema.optional(),
}).strict()

export const CreateSnapshotRequestSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2_000).optional(),
}).strict()

export const SandboxPathRequestSchema = z.object({
  sandboxId: SandboxIdSchema,
}).strict()

export const SnapshotPathRequestSchema = z.object({
  snapshotId: SnapshotIdSchema,
}).strict()

export const ToolPathRequestSchema = z.object({
  sandboxId: SandboxIdSchema,
  toolName: ToolNameSchema,
}).strict()

export const CreateSandboxHeadersSchema = z.object({
  "Idempotency-Key": IdempotencyKeySchema.optional(),
}).strict()

export const ListSandboxesRequestSchema = CursorPaginationRequestSchema
export const ListSnapshotsRequestSchema = CursorPaginationRequestSchema

export type CreateSandboxRequest = z.infer<typeof CreateSandboxRequestSchema>
export type CreateSnapshotRequest = z.infer<typeof CreateSnapshotRequestSchema>
export type SandboxPathRequest = z.infer<typeof SandboxPathRequestSchema>
export type SnapshotPathRequest = z.infer<typeof SnapshotPathRequestSchema>
export type ToolPathRequest = z.infer<typeof ToolPathRequestSchema>
export type CreateSandboxHeaders = z.infer<typeof CreateSandboxHeadersSchema>
