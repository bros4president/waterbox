import { z } from "zod"

export const ErrorCodeSchema = z.enum([
  "invalid_request",
  "unauthorized",
  "not_found",
  "provider_configuration_mismatch",
  "conflict",
  "idempotency_conflict",
  "idempotency_in_progress",
  "invalid_state",
  "unsupported_capability",
  "provider_failure",
  "provider_limit",
  "ambiguous_execution",
  "transfer_expired",
  "transfer_consumed",
  "internal_error",
])

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(2_000),
    requestId: z.string().min(1).max(255),
    sandboxId: z.string().regex(/^sbx_[a-z]+-[a-z]+-[a-z0-9]+$/).optional(),
  }).strict(),
}).strict()

export type ErrorCode = z.infer<typeof ErrorCodeSchema>
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>
