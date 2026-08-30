import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  BashToolEventSchema,
  EditToolEventSchema,
  GlobToolEventSchema,
  GrepToolEventSchema,
  PatchToolEventSchema,
  ReadToolEventSchema,
  SandboxSchema,
  WriteToolEventSchema,
  type Sandbox,
  type ToolName,
} from "@waterbox/contracts"
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

export interface ExperimentalMcpOptions {
  apiUrl: string
  apiKey: string
  idempotencyKey: string
  statePath?: string
}

const tools = [
  {
    name: "create_sandbox",
    description: "Creates and selects one remote Waterbox sandbox. Repeated calls return the selected sandbox instead of creating another.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  {
    name: "read",
    description: "Reads any file or lists any directory in the selected remote Waterbox sandbox. Relative paths start at /workspace.",
    inputSchema: { type: "object" as const, properties: { filePath: { type: "string", minLength: 1, maxLength: 4096 }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, required: ["filePath"], additionalProperties: false },
  },
  {
    name: "write",
    description: "Writes complete file contents anywhere in the selected remote Waterbox sandbox. Relative paths start at /workspace.",
    inputSchema: { type: "object" as const, properties: { filePath: { type: "string", minLength: 1, maxLength: 4096 }, content: { type: "string" } }, required: ["filePath", "content"], additionalProperties: false },
  },
  {
    name: "edit",
    description: "Replaces exact text in any file in the selected remote Waterbox sandbox. Relative paths start at /workspace.",
    inputSchema: { type: "object" as const, properties: { filePath: { type: "string", minLength: 1, maxLength: 4096 }, oldString: { type: "string" }, newString: { type: "string" }, replaceAll: { type: "boolean" } }, required: ["filePath", "oldString", "newString"], additionalProperties: false },
  },
  {
    name: "patch",
    description: "Applies a Begin Patch formatted patch anywhere in the selected remote Waterbox sandbox. Relative paths start at /workspace.",
    inputSchema: { type: "object" as const, properties: { patchText: { type: "string", minLength: 1 } }, required: ["patchText"], additionalProperties: false },
  },
  {
    name: "glob",
    description: "Finds paths by glob pattern anywhere in the selected remote Waterbox sandbox. Relative paths start at /workspace.",
    inputSchema: { type: "object" as const, properties: { pattern: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["pattern"], additionalProperties: false },
  },
  {
    name: "grep",
    description: "Searches file contents anywhere in the selected remote Waterbox sandbox. Relative paths start at /workspace.",
    inputSchema: { type: "object" as const, properties: { pattern: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1, maxLength: 4096 }, include: { type: "string", minLength: 1 } }, required: ["pattern"], additionalProperties: false },
  },
  {
    name: "bash",
    description: "Runs unrestricted bash as root in the selected remote Waterbox sandbox, never on the local machine. The default working directory is /workspace.",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", minLength: 1 },
        description: { type: "string" },
        timeout: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
        workdir: { type: "string", minLength: 1, maxLength: 4096 },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
]

export function parseExperimentalMcpOptions(environment: Record<string, string | undefined> = process.env): ExperimentalMcpOptions {
  const rawUrl = environment.WATERBOX_API_URL
  const apiKey = environment.WATERBOX_API_KEY
  const idempotencyKey = environment.WATERBOX_MCP_IDEMPOTENCY_KEY
  if (!rawUrl || !apiKey || !idempotencyKey) throw new Error("Experimental Waterbox MCP configuration is incomplete")
  let apiUrl: string
  try {
    const url = new URL(rawUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    apiUrl = url.toString().replace(/\/$/, "")
  } catch {
    throw new Error("Experimental Waterbox MCP configuration is invalid")
  }
  return { apiUrl, apiKey, idempotencyKey, ...(environment.WATERBOX_MCP_STATE_PATH ? { statePath: environment.WATERBOX_MCP_STATE_PATH } : {}) }
}

export function createExperimentalMcpServer(options: ExperimentalMcpOptions, fetcher: typeof fetch = fetch): Server {
  let active: Sandbox | undefined
  const calls: Partial<Record<ToolName, { attempted: number; completed: number }>> = {}
  const persist = async () => {
    if (options.statePath) await writeFile(options.statePath, `${JSON.stringify({ sandboxId: active?.sandboxId, calls })}\n`, { mode: 0o600 })
  }
  const server = new Server({ name: "waterbox-control-plane-experiment", version: "0.1.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (request.params.name === "create_sandbox") {
        if (active) return text(active)
        const response = await apiFetch(options, fetcher, "/v1/sandboxes", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": options.idempotencyKey },
          body: "{}",
          signal: extra.signal,
        })
        active = SandboxSchema.parse(await response.json())
        await persist()
        return text(active)
      }
      if (isToolName(request.params.name)) {
        if (!active) throw new Error(`Create a remote sandbox before running ${request.params.name}`)
        const counts = calls[request.params.name] ?? { attempted: 0, completed: 0 }
        calls[request.params.name] = counts
        counts.attempted += 1
        await persist()
        const response = await apiFetch(options, fetcher, `/v1/sandboxes/${encodeURIComponent(active.sandboxId)}/tools/${request.params.name}`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/x-ndjson" },
          body: JSON.stringify(request.params.arguments ?? {}),
          signal: extra.signal,
        })
        const result = request.params.name === "bash" ? await readBashResult(response) : await readToolResult(request.params.name, response)
        counts.completed += 1
        await persist()
        return result
      }
      throw new Error("Unknown experimental Waterbox tool")
    } catch (error) {
      return { content: [{ type: "text" as const, text: safeMessage(error) }], isError: true }
    }
  })
  return server
}

async function apiFetch(options: ExperimentalMcpOptions, fetcher: typeof fetch, path: string, init: RequestInit): Promise<Response> {
  const response = await fetcher(`${options.apiUrl}${path}`, { ...init, headers: { authorization: `Bearer ${options.apiKey}`, ...init.headers } })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`Waterbox API request failed (${response.status})`)
  }
  return response
}

async function readBashResult(response: Response) {
  if (!response.body || response.headers.get("content-type")?.split(";", 1)[0] !== "application/x-ndjson") throw new Error("Waterbox bash returned an invalid stream")
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const events: Array<ReturnType<typeof BashToolEventSchema.parse>> = []
  let pending = ""
  while (true) {
    const item = await reader.read()
    if (item.done) break
    pending += item.value
    let newline: number
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (!line) throw new Error("Waterbox bash returned an invalid stream")
      events.push(BashToolEventSchema.parse(JSON.parse(line)))
    }
  }
  if (pending || events.filter(event => event.type === "result").length !== 1 || events.at(-1)?.type !== "result") throw new Error("Waterbox bash returned an incomplete stream")
  const final = events.at(-1)
  if (!final || final.type !== "result") throw new Error("Waterbox bash stream ended without a result")
  const output = events.filter(event => event.type === "stdout" || event.type === "stderr").map(event => event.data).join("")
  const displayedOutput = final.outcome === "dispatched" ? final.output : output
  return {
    content: [{ type: "text" as const, text: `${displayedOutput}${displayedOutput && !displayedOutput.endsWith("\n") ? "\n" : ""}${JSON.stringify(final.metadata)}` }],
    ...(final.outcome === "completed" && (final.metadata.exitCode !== 0 || final.metadata.timedOut || final.metadata.aborted) ? { isError: true } : {}),
  }
}

async function readToolResult(name: Exclude<ToolName, "bash">, response: Response) {
  if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/x-ndjson") throw new Error(`Waterbox ${name} returned an invalid stream`)
  const body = await response.text()
  if (!body.endsWith("\n") || body.slice(0, -1).includes("\n")) throw new Error(`Waterbox ${name} returned an incomplete stream`)
  const value = JSON.parse(body.slice(0, -1))
  const event = ({ read: ReadToolEventSchema, write: WriteToolEventSchema, edit: EditToolEventSchema, patch: PatchToolEventSchema, glob: GlobToolEventSchema, grep: GrepToolEventSchema } as const)[name].parse(value)
  return text({ output: event.output, metadata: event.metadata })
}

function isToolName(value: string): value is ToolName { return ["read", "write", "edit", "patch", "glob", "grep", "bash"].includes(value) }

function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] } }
function safeMessage(error: unknown): string { return error instanceof Error && /^Waterbox |^Create |^Unknown /.test(error.message) ? error.message : "Experimental Waterbox MCP request failed" }

export async function main(): Promise<void> {
  const server = createExperimentalMcpServer(parseExperimentalMcpOptions())
  await server.connect(new StdioServerTransport())
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(safeMessage(error)); process.exitCode = 1 })
}
