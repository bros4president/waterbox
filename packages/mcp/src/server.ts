import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import {
  BashToolArgumentsSchema,
  BashToolEventSchema,
  CreateSandboxRequestSchema,
  CreateSnapshotRequestSchema,
  CursorPaginationRequestSchema,
  EditToolArgumentsSchema,
  EditToolEventSchema,
  GlobToolArgumentsSchema,
  GlobToolEventSchema,
  GrepToolArgumentsSchema,
  GrepToolEventSchema,
  PatchToolArgumentsSchema,
  PatchToolEventSchema,
  ReadToolArgumentsSchema,
  ReadToolEventSchema,
  SandboxIdSchema,
  SandboxSchema,
  SnapshotIdSchema,
  SnapshotPageSchema,
  SnapshotSchema,
  ToolNameSchema,
  WriteToolArgumentsSchema,
  WriteToolEventSchema,
  IdempotencyKeySchema,
  FilePathSchema,
  type SandboxId,
  type ToolName,
} from "@waterbox/contracts"
import type { ToolArgumentsByName, ToolEventByName } from "@waterbox/core/provider"
import { z } from "zod"
import type { McpBackend } from "./backend.ts"
import { MissingMcpCredentialError } from "./config.ts"
import { sendFileSecurely } from "./secure-transfer.ts"

const ARGUMENT_SCHEMAS = {
  read: ReadToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }),
  write: WriteToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }),
  edit: EditToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }),
  patch: PatchToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }),
  glob: GlobToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }),
  grep: GrepToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }),
  bash: BashToolArgumentsSchema.extend({ sandboxId: SandboxIdSchema }),
} as const
const CreateSandboxInputSchema = CreateSandboxRequestSchema.extend({ idempotencyKey: IdempotencyKeySchema })
const DeleteSandboxInputSchema = z.object({ sandboxId: SandboxIdSchema }).strict()
const ListSnapshotsInputSchema = CursorPaginationRequestSchema
const CreateSnapshotInputSchema = CreateSnapshotRequestSchema.extend({ sandboxId: SandboxIdSchema })
const DeleteSnapshotInputSchema = z.object({ snapshotId: SnapshotIdSchema }).strict()
const SendFileSecurelyInputSchema = z.object({
  sandboxId: SandboxIdSchema,
  sourcePath: z.string().min(1).max(4_096),
  targetPath: FilePathSchema,
}).strict()
const EVENT_SCHEMAS = {
  read: ReadToolEventSchema,
  write: WriteToolEventSchema,
  edit: EditToolEventSchema,
  patch: PatchToolEventSchema,
  glob: GlobToolEventSchema,
  grep: GrepToolEventSchema,
  bash: BashToolEventSchema,
} as const

const tools: Tool[] = [
  tool("create_sandbox", "Creates a Waterbox sandbox. Reuse idempotencyKey to retry the same creation safely; use a new key to create another sandbox.", CreateSandboxInputSchema),
  tool("probe_sandbox", "Queries the provider for live sandbox status and reconciles the observed state into Waterbox.", DeleteSandboxInputSchema),
  tool("delete_sandbox", "Permanently deletes a user-owned Waterbox sandbox.", DeleteSandboxInputSchema),
  tool("list_snapshots", "Lists user-owned Waterbox snapshots with cursor pagination.", ListSnapshotsInputSchema),
  tool("create_snapshot", "Creates a user-owned snapshot from a running or stopped Waterbox sandbox.", CreateSnapshotInputSchema),
  tool("delete_snapshot", "Permanently deletes a user-owned Waterbox snapshot. Provider system templates are not addressable by this tool.", DeleteSnapshotInputSchema),
  tool("send_file_securely", "Encrypts and transfers an existing local file to a sandbox without placing its contents in model context or tool arguments. The destination file is decrypted and readable inside the sandbox; avoid reading sensitive destination contents back into model context. The source file is not modified or deleted.", SendFileSecurelyInputSchema),
  tool("read", "Reads any file or lists any directory in the specified Waterbox sandbox. Relative paths start at /workspace.", ARGUMENT_SCHEMAS.read),
  tool("write", "Writes complete file contents anywhere in the specified Waterbox sandbox. Relative paths start at /workspace.", ARGUMENT_SCHEMAS.write),
  tool("edit", "Replaces exact text in any file in the specified Waterbox sandbox. Relative paths start at /workspace.", ARGUMENT_SCHEMAS.edit),
  tool("patch", "Applies a Begin Patch formatted patch anywhere in the specified Waterbox sandbox. Relative paths start at /workspace.", ARGUMENT_SCHEMAS.patch),
  tool("glob", "Finds paths by glob pattern anywhere in the specified Waterbox sandbox. Relative paths start at /workspace.", ARGUMENT_SCHEMAS.glob),
  tool("grep", "Searches file contents anywhere in the specified Waterbox sandbox. Relative paths start at /workspace.", ARGUMENT_SCHEMAS.grep),
  tool("bash", "Runs unrestricted bash as root in the specified Waterbox sandbox, never on the local machine. The default working directory is /workspace.", ARGUMENT_SCHEMAS.bash),
]

export function createWaterboxMcpServer(backend: McpBackend, options: { onError?: (error: unknown) => void } = {}): Server {
  const server = new Server({ name: "waterbox", version: "0.1.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (request.params.name === "create_sandbox") {
        const { idempotencyKey, ...createRequest } = CreateSandboxInputSchema.parse(request.params.arguments ?? {})
        return text(SandboxSchema.parse(await backend.createSandbox(createRequest, idempotencyKey, extra.signal)))
      }
      if (request.params.name === "delete_sandbox") {
        const { sandboxId } = DeleteSandboxInputSchema.parse(request.params.arguments ?? {})
        return text(SandboxSchema.parse(await backend.deleteSandbox(sandboxId, extra.signal)))
      }
      if (request.params.name === "probe_sandbox") {
        const { sandboxId } = DeleteSandboxInputSchema.parse(request.params.arguments ?? {})
        return text(SandboxSchema.parse(await backend.probeSandbox(sandboxId, extra.signal)))
      }
      if (request.params.name === "list_snapshots") {
        const input = ListSnapshotsInputSchema.parse(request.params.arguments ?? {})
        return text(SnapshotPageSchema.parse(await backend.listSnapshots(input, extra.signal)))
      }
      if (request.params.name === "create_snapshot") {
        const { sandboxId, ...createRequest } = CreateSnapshotInputSchema.parse(request.params.arguments ?? {})
        return text(SnapshotSchema.parse(await backend.createSnapshot(sandboxId, createRequest, extra.signal)))
      }
      if (request.params.name === "delete_snapshot") {
        const { snapshotId } = DeleteSnapshotInputSchema.parse(request.params.arguments ?? {})
        return text(SnapshotSchema.parse(await backend.deleteSnapshot(snapshotId, extra.signal)))
      }
      if (request.params.name === "send_file_securely") {
        const input = SendFileSecurelyInputSchema.parse(request.params.arguments ?? {})
        return text(await sendFileSecurely(backend, input, extra.signal))
      }
      const parsedName = ToolNameSchema.safeParse(request.params.name)
      if (!parsedName.success) throw new PublicMcpError("Unknown Waterbox tool")
      const { sandboxId, arguments_ } = parseArguments(parsedName.data, request.params.arguments)
      const events = await backend.executeTool(sandboxId, parsedName.data, arguments_, extra.signal)
      return await terminalResult(parsedName.data, events)
    } catch (error) {
      options.onError?.(error)
      return { content: [{ type: "text" as const, text: safeMessage(error) }], isError: true }
    }
  })
  return server
}

function parseArguments<N extends ToolName>(name: N, value: unknown): { sandboxId: SandboxId; arguments_: ToolArgumentsByName[N] } {
  const parsed = ARGUMENT_SCHEMAS[name].safeParse(value ?? {})
  if (!parsed.success) throw new PublicMcpError(`Invalid arguments for Waterbox ${name}`)
  const { sandboxId, ...arguments_ } = parsed.data
  return { sandboxId, arguments_: arguments_ as ToolArgumentsByName[N] }
}

async function terminalResult<N extends ToolName>(name: N, events: AsyncIterable<ToolEventByName[N]>) {
  let terminal: Extract<ToolEventByName[N], { type: "result" }> | undefined
  for await (const value of events) {
    if (terminal) throw new Error("Events followed the terminal Waterbox tool result")
    const event = EVENT_SCHEMAS[name].parse(value) as ToolEventByName[N]
    if (event.type === "result") terminal = event as Extract<ToolEventByName[N], { type: "result" }>
  }
  if (!terminal) throw new Error("Waterbox tool stream ended without a result")
  let failed = false
  if (name === "bash") {
    const bashTerminal = BashToolEventSchema.parse(terminal)
    if (bashTerminal.type !== "result") throw new Error("Waterbox bash returned an invalid terminal result")
    failed = bashTerminal.metadata.exitCode !== 0 || bashTerminal.metadata.timedOut || bashTerminal.metadata.aborted
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ output: terminal.output, metadata: terminal.metadata }) }],
    ...(failed ? { isError: true } : {}),
  }
}

function tool(name: string, description: string, schema: z.ZodType): Tool {
  const { $schema: _, ...inputSchema } = z.toJSONSchema(schema)
  return { name, description, inputSchema: inputSchema as Tool["inputSchema"] }
}

class PublicMcpError extends Error {}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }
}

function safeMessage(error: unknown): string {
  return error instanceof PublicMcpError || error instanceof MissingMcpCredentialError
    ? error.message
    : "Waterbox MCP request failed"
}
