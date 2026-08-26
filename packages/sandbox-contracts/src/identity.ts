import { z } from "zod"

export const AccountIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

export const IdentitySchema = z.object({
  accountId: AccountIdSchema,
}).strict()

export type Identity = z.infer<typeof IdentitySchema>
