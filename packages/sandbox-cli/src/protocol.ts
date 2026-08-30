import {
  BashToolArgumentsSchema, EditToolArgumentsSchema, GlobToolArgumentsSchema,
  GrepToolArgumentsSchema, PatchToolArgumentsSchema, ReadToolArgumentsSchema, SecureTransferIdSchema,
  FilePathSchema,
  ToolNameSchema, WriteToolArgumentsSchema, type ToolName,
} from "@waterbox/contracts"
import { z } from "zod"

export const CLI_PROTOCOL_VERSION = 2 as const
export const MAX_ENCODED_INVOCATION_BYTES = 96 * 1024
export const MAX_DECODED_INVOCATION_BYTES = 72 * 1024
const MAX_TRANSFER_METADATA_BYTES = 16 * 1024
const SecureTransferCliInputSchema = z.object({
  transferId: SecureTransferIdSchema,
  targetPath: FilePathSchema,
  ciphertextPath: z.string().regex(/^\/tmp\/waterbox-transfer-[0-9a-f-]{36}\.age$/),
}).strict()
export type SecureTransferCliInput = z.infer<typeof SecureTransferCliInputSchema>

const argumentSchemas = {
  read: ReadToolArgumentsSchema,
  write: WriteToolArgumentsSchema,
  edit: EditToolArgumentsSchema,
  patch: PatchToolArgumentsSchema,
  glob: GlobToolArgumentsSchema,
  grep: GrepToolArgumentsSchema,
  bash: BashToolArgumentsSchema,
} as const

export type CliInvocation = {
  [Name in ToolName]: { protocolVersion: typeof CLI_PROTOCOL_VERSION; tool: Name; arguments: z.infer<(typeof argumentSchemas)[Name]> }
}[ToolName]

export class CliProtocolError extends Error {
  constructor() { super("Invalid Waterbox CLI invocation"); this.name = "CliProtocolError" }
}

export function encodeInvocation<Name extends ToolName>(tool: Name, args: z.input<(typeof argumentSchemas)[Name]>): string {
  const name = ToolNameSchema.parse(tool)
  const canonical = argumentSchemas[name].parse(args)
  const json = JSON.stringify({ protocolVersion: CLI_PROTOCOL_VERSION, tool: name, arguments: canonical })
  const bytes = new TextEncoder().encode(json)
  if (bytes.byteLength > MAX_DECODED_INVOCATION_BYTES) throw new CliProtocolError()
  const encoded = `j2.${Buffer.from(bytes).toString("base64url")}`
  if (Buffer.byteLength(encoded) > MAX_ENCODED_INVOCATION_BYTES) throw new CliProtocolError()
  return encoded
}

export function decodeInvocation(value: string): CliInvocation {
  try {
    if (typeof value !== "string" || Buffer.byteLength(value) > MAX_ENCODED_INVOCATION_BYTES || !value.startsWith("j2.")) throw new Error()
    const encoded = value.slice(3)
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error()
    const bytes = Buffer.from(encoded, "base64url")
    if (bytes.byteLength > MAX_DECODED_INVOCATION_BYTES || bytes.toString("base64url") !== encoded) throw new Error()
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (!isExactObject(parsed, ["protocolVersion", "tool", "arguments"]) || parsed.protocolVersion !== CLI_PROTOCOL_VERSION) throw new Error()
    const tool = ToolNameSchema.parse(parsed.tool)
    return { protocolVersion: CLI_PROTOCOL_VERSION, tool, arguments: argumentSchemas[tool].parse(parsed.arguments) } as CliInvocation
  } catch {
    throw new CliProtocolError()
  }
}

export function encodeSecureTransferInput(value: SecureTransferCliInput): string {
  const bytes = new TextEncoder().encode(JSON.stringify(SecureTransferCliInputSchema.parse(value)))
  if (bytes.byteLength > MAX_TRANSFER_METADATA_BYTES) throw new CliProtocolError()
  return `t1.${Buffer.from(bytes).toString("base64url")}`
}

export function decodeSecureTransferInput(value: string): SecureTransferCliInput {
  try {
    if (typeof value !== "string" || !value.startsWith("t1.") || Buffer.byteLength(value) > MAX_TRANSFER_METADATA_BYTES * 2) throw new Error()
    const encoded = value.slice(3)
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error()
    const bytes = Buffer.from(encoded, "base64url")
    if (bytes.byteLength > MAX_TRANSFER_METADATA_BYTES || bytes.toString("base64url") !== encoded) throw new Error()
    return SecureTransferCliInputSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
  } catch {
    throw new CliProtocolError()
  }
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
