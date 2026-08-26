import { z } from "zod"
import { ErrorCodeSchema } from "./errors.ts"

export const SandboxIdSchema = z.string().regex(/^sbx_[a-z]+-[a-z]+-[a-z0-9]+$/)
export const SnapshotIdSchema = z.string().regex(/^snap_[a-z]+-[a-z]+-[a-z0-9]+$/)
export const ProviderNameSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/)
export const TimestampSchema = z.string().datetime({ offset: true })

export const SandboxStateSchema = z.enum([
  "provisioning",
  "running",
  "suspending",
  "suspended",
  "resuming",
  "terminating",
  "terminated",
  "failed",
])

export const SnapshotStateSchema = z.enum([
  "creating",
  "ready",
  "failed",
  "deleting",
  "deleted",
])

export const PublicResourceErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(2_000),
}).strict()

export const SandboxSchema = z.object({
  sandboxId: SandboxIdSchema,
  provider: ProviderNameSchema,
  state: SandboxStateSchema,
  sourceSnapshotId: SnapshotIdSchema.optional(),
  version: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastError: PublicResourceErrorSchema.optional(),
}).strict()

export const SnapshotSchema = z.object({
  snapshotId: SnapshotIdSchema,
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2_000).optional(),
  provider: ProviderNameSchema,
  sourceSandboxId: SandboxIdSchema,
  state: SnapshotStateSchema,
  version: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastError: PublicResourceErrorSchema.optional(),
}).strict()

export const ProviderCapabilitiesSchema = z.object({
  suspend: z.boolean(),
  resume: z.boolean(),
  snapshots: z.boolean(),
  createFromSnapshot: z.boolean(),
  fork: z.boolean(),
  streaming: z.boolean(),
}).strict()

export type SandboxId = z.infer<typeof SandboxIdSchema>
export type SnapshotId = z.infer<typeof SnapshotIdSchema>
export type SandboxState = z.infer<typeof SandboxStateSchema>
export type SnapshotState = z.infer<typeof SnapshotStateSchema>
export type PublicResourceError = z.infer<typeof PublicResourceErrorSchema>
export type Sandbox = z.infer<typeof SandboxSchema>
export type Snapshot = z.infer<typeof SnapshotSchema>
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>

export const SandboxDtoSchema = SandboxSchema
export const SnapshotDtoSchema = SnapshotSchema
export type SandboxDto = Sandbox
export type SnapshotDto = Snapshot
