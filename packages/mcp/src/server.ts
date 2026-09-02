import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { BashToolArgumentsSchema, BashToolResultSchema, CreateSandboxRequestSchema, CreateSnapshotRequestSchema, CursorPaginationRequestSchema, EditToolArgumentsSchema, FilePathSchema, GlobToolArgumentsSchema, GrepToolArgumentsSchema, IdempotencyKeySchema, PatchToolArgumentsSchema, ReadToolArgumentsSchema, SandboxIdSchema, SandboxSchema, SnapshotIdSchema, SnapshotPageSchema, SnapshotSchema, ToolNameSchema, WriteToolArgumentsSchema } from "@waterbox/contracts"
import { WaterboxClient, WaterboxClientError } from "@waterbox/client"
import { z } from "zod"
import { McpConfigurationError } from "./config.ts"
import { sendFileSecurely } from "./secure-transfer.ts"

const ARGUMENT_SCHEMAS = {
  read: ReadToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }), write: WriteToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }),
  edit: EditToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }), patch: PatchToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }),
  glob: GlobToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }), grep: GrepToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }),
  bash: BashToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }),
} as const
const CreateSandboxInputSchema = CreateSandboxRequestSchema.extend({ idempotencyKey: IdempotencyKeySchema })
const SandboxInputSchema = z.object({ sandboxId: SandboxIdSchema }).strict()
const CreateSnapshotInputSchema = CreateSnapshotRequestSchema.extend({ sandboxId: SandboxIdSchema })
const SnapshotInputSchema = z.object({ snapshotId: SnapshotIdSchema }).strict()
const SendFileInputSchema = z.object({ sandboxId: SandboxIdSchema, sourcePath: z.string().min(1).max(4_096), targetPath: FilePathSchema }).strict()
const tools: Tool[] = [
  tool("create_sandbox", "Creates a Waterbox sandbox. Reuse idempotencyKey to retry the same creation safely; use a new key to create another sandbox.", CreateSandboxInputSchema),
  tool("probe_sandbox", "Queries the provider for live sandbox status and reconciles the observed state into Waterbox.", SandboxInputSchema),
  tool("delete_sandbox", "Permanently deletes a user-owned Waterbox sandbox.", SandboxInputSchema),
  tool("list_snapshots", "Lists user-owned Waterbox snapshots with cursor pagination.", CursorPaginationRequestSchema),
  tool("create_snapshot", "Creates a user-owned snapshot from a running Waterbox sandbox. It never implicitly resumes a sandbox.", CreateSnapshotInputSchema),
  tool("delete_snapshot", "Permanently deletes a user-owned Waterbox snapshot.", SnapshotInputSchema),
  tool("send_file_securely", "Encrypts and transfers an existing local file to a sandbox without placing its contents in model context or tool arguments. The destination file is decrypted and readable inside the sandbox; avoid reading sensitive destination contents back into model context. The source file is not modified or deleted.", SendFileInputSchema),
  tool("read", "Reads any file or lists any directory in the specified Waterbox sandbox. Relative paths start at /workspace.", ARGUMENT_SCHEMAS.read),
  tool("write", "Writes complete file contents anywhere in the specified Waterbox sandbox. Relative paths start at /workspace.", ARGUMENT_SCHEMAS.write),
  tool("edit", "Replaces exact text in any file in the specified Waterbox sandbox. Relative paths start at /workspace.", ARGUMENT_SCHEMAS.edit),
  tool("patch", "Applies a Begin Patch formatted patch anywhere in the specified Waterbox sandbox. Relative paths start at /workspace.", ARGUMENT_SCHEMAS.patch),
  tool("glob", "Finds paths by glob pattern anywhere in the specified Waterbox sandbox. Relative paths start at /workspace.", ARGUMENT_SCHEMAS.glob),
  tool("grep", "Searches file contents anywhere in the specified Waterbox sandbox. Relative paths start at /workspace.", ARGUMENT_SCHEMAS.grep),
  tool("bash", "Runs unrestricted bash as root in the specified Waterbox sandbox, never on the local machine. The default working directory is /workspace.", ARGUMENT_SCHEMAS.bash, BashToolResultSchema),
]

export function createWaterboxMcpServer(client: WaterboxClient & { preflight?: () => void }, options: { onError?: (error: unknown) => void } = {}): Server {
  const server = new Server({ name: "waterbox", version: "0.1.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      client.preflight?.()
      const context = { signal: extra.signal, ...(extra._meta?.progressToken === undefined ? {} : { onProgress: async ({ sequence }: { sequence: number }) => {
        try { await extra.sendNotification({ method: "notifications/progress", params: { progressToken: extra._meta!.progressToken!, progress: sequence } }) } catch {}
      } }) }
      if (request.params.name === "create_sandbox") { const { idempotencyKey, ...input } = CreateSandboxInputSchema.parse(request.params.arguments ?? {}); return text(SandboxSchema.parse(await client.createSandbox(input, { ...context, idempotencyKey }))) }
      if (request.params.name === "probe_sandbox") return text(SandboxSchema.parse(await client.probeSandbox(SandboxInputSchema.parse(request.params.arguments ?? {}), context)))
      if (request.params.name === "delete_sandbox") return text(SandboxSchema.parse(await client.deleteSandbox(SandboxInputSchema.parse(request.params.arguments ?? {}), context)))
      if (request.params.name === "list_snapshots") return text(SnapshotPageSchema.parse(await client.listSnapshots(CursorPaginationRequestSchema.parse(request.params.arguments ?? {}), context)))
      if (request.params.name === "create_snapshot") return text(SnapshotSchema.parse(await client.createSnapshot(CreateSnapshotInputSchema.parse(request.params.arguments ?? {}), context)))
      if (request.params.name === "delete_snapshot") return text(SnapshotSchema.parse(await client.deleteSnapshot(SnapshotInputSchema.parse(request.params.arguments ?? {}), context)))
      if (request.params.name === "send_file_securely") return text(await sendFileSecurely(client, SendFileInputSchema.parse(request.params.arguments ?? {}), context))
      const name = ToolNameSchema.safeParse(request.params.name)
      if (!name.success) throw new PublicMcpError("Unknown Waterbox tool")
      const parsed = ARGUMENT_SCHEMAS[name.data].safeParse(request.params.arguments ?? {})
      if (!parsed.success) throw new PublicMcpError(`Invalid arguments for Waterbox ${name.data}`)
      const result = await client[name.data](parsed.data as never, context)
      if (name.data === "bash") return bashResult(BashToolResultSchema.parse(result))
      return { content: [{ type: "text" as const, text: JSON.stringify({ output: result.output, metadata: result.metadata }) }] }
    } catch (error) { options.onError?.(error); return { content: [{ type: "text" as const, text: safeMessage(error) }], isError: true } }
  })
  return server
}
function bashResult(result: z.infer<typeof BashToolResultSchema>) { const failed = result.outcome === "completed" && (result.metadata.exitCode !== 0 || result.metadata.timedOut || result.metadata.aborted); return { content: [{ type: "text" as const, text: result.output }], structuredContent: result, ...(failed ? { isError: true } : {}) } }
function tool(name: string, description: string, schema: z.ZodType, output?: z.ZodType): Tool { const { $schema: _, ...inputSchema } = z.toJSONSchema(schema); if (!output) return { name, description, inputSchema: inputSchema as Tool["inputSchema"] }; const { $schema: _output, ...outputSchema } = z.toJSONSchema(output); return { name, description, inputSchema: inputSchema as Tool["inputSchema"], outputSchema: { type: "object", ...outputSchema } as Tool["outputSchema"] } }
class PublicMcpError extends Error {}
function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] } }
function safeMessage(error: unknown): string {
  if (error instanceof WaterboxClientError || (error instanceof Error && error.name === "WaterboxClientError")) {
    const clientError = error as WaterboxClientError
    const recovery = clientError.recoverySandboxId === undefined ? "" : ` Recovery sandbox: ${clientError.recoverySandboxId}. Retry creation only with the same idempotency key, or use probe_sandbox or delete_sandbox with this sandbox ID.`
    return `${clientError.message}${recovery}`
  }
  return error instanceof PublicMcpError || error instanceof McpConfigurationError || (error instanceof Error && error.name === "UnsupportedMcpProviderError") ? error.message : "Waterbox MCP request failed"
}
