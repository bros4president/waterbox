import { z } from "zod"
import { TimestampSchema } from "./resources.ts"
import { FilePathSchema } from "./tools.ts"

export const MAX_SECURE_FILE_BYTES = 1_048_576
export const MAX_SECURE_CIPHERTEXT_BYTES = 1_100_000
export const MAX_SECURE_CIPHERTEXT_BASE64_LENGTH = Math.ceil(MAX_SECURE_CIPHERTEXT_BYTES / 3) * 4
export const SECURE_TRANSFER_ALGORITHM = "age-x25519" as const

export const SecureTransferIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
export const AgeRecipientSchema = z.string().min(10).max(200).regex(/^age1[0-9a-z]+$/)
export const SecureTransferInitiatedSchema = z.object({
  transferId: SecureTransferIdSchema,
  publicKey: AgeRecipientSchema,
  algorithm: z.literal(SECURE_TRANSFER_ALGORITHM),
  expiresAt: TimestampSchema,
}).strict()

export const SecureTransferConsumeRequestSchema = z.object({
  targetPath: FilePathSchema,
  ciphertext: z.string().min(1).max(MAX_SECURE_CIPHERTEXT_BASE64_LENGTH).refine(isCanonicalBase64, "ciphertext must be canonical base64"),
}).strict()

export const SecureTransferDeliveredSchema = z.object({
  transferId: SecureTransferIdSchema,
  targetPath: FilePathSchema,
  bytes: z.number().int().nonnegative().max(MAX_SECURE_FILE_BYTES),
}).strict()

export type SecureTransferId = z.infer<typeof SecureTransferIdSchema>
export type SecureTransferInitiated = z.infer<typeof SecureTransferInitiatedSchema>
export type SecureTransferConsumeRequest = z.infer<typeof SecureTransferConsumeRequestSchema>
export type SecureTransferDelivered = z.infer<typeof SecureTransferDeliveredSchema>

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  try {
    const decoded = atob(value)
    return decoded.length <= MAX_SECURE_CIPHERTEXT_BYTES && btoa(decoded) === value
  } catch {
    return false
  }
}
