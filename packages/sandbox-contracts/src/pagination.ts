import { z } from "zod"
import { SandboxSchema, SnapshotSchema } from "./resources.ts"

export const CursorSchema = z.string().min(1).max(2_048)
export const PageLimitSchema = z.coerce.number().int().min(1).max(100)

export const CursorPaginationRequestSchema = z.object({
  cursor: CursorSchema.optional(),
  limit: PageLimitSchema.optional(),
}).strict()

export const SandboxPageSchema = z.object({
  items: z.array(SandboxSchema),
  nextCursor: CursorSchema.optional(),
}).strict()

export const SnapshotPageSchema = z.object({
  items: z.array(SnapshotSchema),
  nextCursor: CursorSchema.optional(),
}).strict()

export type CursorPaginationRequest = z.infer<typeof CursorPaginationRequestSchema>
export type SandboxPage = z.infer<typeof SandboxPageSchema>
export type SnapshotPage = z.infer<typeof SnapshotPageSchema>
