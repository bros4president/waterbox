import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  BashToolEventSchema,
  BashToolResultSchema,
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

const BASH_CLEANUP_DEADLINE_MS = 5_000

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
    outputSchema: bashOutputSchema(),
  },
]

function bashOutputSchema() {
  const result = {
    type: "object" as const,
    properties: { title: { type: "string" as const }, output: { type: "string" as const } },
    required: ["title", "output"],
    additionalProperties: false,
  }
  const commonMetadata = {
    command: { type: "string" as const }, description: { type: "string" as const }, workdir: { type: "string" as const },
  }
  return {
    type: "object" as const,
    oneOf: [
      {
        ...result,
        properties: {
          ...result.properties, outcome: { const: "completed" },
          metadata: {
            type: "object" as const,
            properties: { ...commonMetadata, exitCode: { type: ["integer", "null"] }, signal: { type: ["string", "null"] }, timedOut: { type: "boolean" as const }, aborted: { type: "boolean" as const }, durationMs: { type: "number" as const, minimum: 0 }, outputTruncated: { type: "boolean" as const } },
            required: ["command", "workdir", "exitCode", "signal", "timedOut", "aborted", "durationMs", "outputTruncated"], additionalProperties: false,
          },
        },
        required: [...result.required, "outcome", "metadata"],
      },
      {
        ...result,
        properties: {
          ...result.properties, outcome: { const: "dispatched" },
          metadata: {
            type: "object" as const,
            properties: { ...commonMetadata, timeout: { type: "integer" as const, minimum: 1, maximum: 2_147_483_647 }, jobId: { type: "string" as const, pattern: "^job_[0-9a-f]{32}$" }, outputPath: { type: "string" as const }, statusPath: { type: "string" as const } },
            required: ["command", "workdir", "jobId", "outputPath", "statusPath"], additionalProperties: false,
          },
        },
        required: [...result.required, "outcome", "metadata"],
      },
    ],
  }
}

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

export function createExperimentalMcpServer(options: ExperimentalMcpOptions, fetcher: typeof fetch = fetch, runtime: { bashObservationIntervalMs?: number; bashCleanupDeadlineMs?: number } = {}): Server {
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
        const result = request.params.name === "bash" ? await readBashResult(response, options, fetcher, active.sandboxId, extra, runtime.bashObservationIntervalMs, runtime.bashCleanupDeadlineMs) : await readToolResult(request.params.name, response)
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

async function readBashResult(response: Response, options: ExperimentalMcpOptions, fetcher: typeof fetch, sandboxId: string, extra: { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (notification: any) => Promise<void> }, intervalMs?: number, cleanupDeadlineMs?: number) {
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
  if (final.outcome === "dispatched") return absorbReceipt(options, fetcher, sandboxId, final, extra, intervalMs, cleanupDeadlineMs)
  const displayedOutput = output || final.output
  const structuredContent = BashToolResultSchema.parse({ title: final.title, outcome: "completed", output: displayedOutput, metadata: final.metadata })
  return {
    content: [{ type: "text" as const, text: displayedOutput }],
    structuredContent,
    ...(final.metadata.exitCode !== 0 || final.metadata.timedOut || final.metadata.aborted ? { isError: true } : {}),
  }
}

async function absorbReceipt(options: ExperimentalMcpOptions, fetcher: typeof fetch, sandboxId: string, receipt: Extract<ReturnType<typeof BashToolEventSchema.parse>, { type: "result"; outcome: "dispatched" }>, extra: { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (notification: any) => Promise<void> }, intervalMs = 1_000, cleanupDeadlineMs = BASH_CLEANUP_DEADLINE_MS) {
  let offset = 0, retained = "", retainedBytes = 0
  let outputTruncated = false
  const decoder = new TextDecoder("utf-8")
  const stopHeartbeat = startProgressHeartbeat(extra, intervalMs)
  try {
    while (true) {
      extra.signal.throwIfAborted()
      const response = await apiFetch(options, fetcher, `/v1/internal/sandboxes/${encodeURIComponent(sandboxId)}/bash-jobs/${encodeURIComponent(receipt.metadata.jobId)}/observe`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offset, maxBytes: 65_536 }), signal: extra.signal,
      })
      const sample = validateObservation(await response.json(), receipt.metadata.jobId, offset)
      const chunk = Buffer.from(sample.chunkBase64, "base64")
      offset = sample.nextOffset
      const drained = (sample.state === "completed" || sample.state === "failed") && offset === sample.outputSize
      const kept = retainDecoded(retained, retainedBytes, outputTruncated, decoder.decode(chunk, { stream: !drained }))
      retained = kept.value; retainedBytes = kept.bytes; outputTruncated = kept.truncated
      if (drained) {
        if (sample.error !== undefined || sample.exitCode === undefined || sample.timedOut === undefined || sample.durationMs === undefined) throw new Error("Invalid terminal observation")
        const finalOutput = retained || (sample.timedOut ? "Command timed out" : "Command completed without output")
        const metadata = { command: receipt.metadata.command, ...(receipt.metadata.description === undefined ? {} : { description: receipt.metadata.description }), workdir: receipt.metadata.workdir, exitCode: sample.exitCode, signal: sample.signal ?? null, timedOut: sample.timedOut, aborted: false, durationMs: sample.durationMs, outputTruncated }
        const structuredContent = BashToolResultSchema.parse({ title: receipt.metadata.description ?? "Bash command", outcome: "completed", output: finalOutput, metadata })
        cleanupDetached(signal => apiFetch(options, fetcher, `/v1/internal/sandboxes/${encodeURIComponent(sandboxId)}/bash-jobs/${encodeURIComponent(receipt.metadata.jobId)}`, { method: "DELETE", signal }).then(() => undefined), cleanupDeadlineMs)
        return { content: [{ type: "text" as const, text: finalOutput }], structuredContent, ...(metadata.exitCode !== 0 || metadata.timedOut ? { isError: true } : {}) }
      }
      if (chunk.byteLength === 0) await abortableSleep(1_000, extra.signal)
    }
  } catch {
    const output = `Observation stopped before completion. Job ${receipt.metadata.jobId} may still be running. Recovery statusPath: ${receipt.metadata.statusPath}\nRecovery outputPath: ${receipt.metadata.outputPath}`
    const structuredContent = BashToolResultSchema.parse({ title: receipt.title, outcome: "dispatched", output, metadata: receipt.metadata })
    return { content: [{ type: "text" as const, text: output }], structuredContent }
  } finally {
    stopHeartbeat()
  }
}

function cleanupDetached(operation: (signal: AbortSignal) => Promise<void>, deadlineMs: number): void {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException("Bash cleanup timed out", "TimeoutError")), deadlineMs)
  timer.unref()
  try {
    void operation(controller.signal).catch(() => undefined).finally(() => clearTimeout(timer))
  } catch {
    clearTimeout(timer)
  }
}

function startProgressHeartbeat(extra: { _meta?: { progressToken?: string | number }; sendNotification: (notification: any) => Promise<void> }, intervalMs: number): () => void {
  const progressToken = extra._meta?.progressToken
  if (progressToken === undefined) return () => {}
  let stopped = false, progress = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    progress += 1
    try {
      await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, message: "Remote operation in progress" } })
    } catch {}
    if (!stopped) timer = setTimeout(() => { void tick() }, intervalMs)
  }
  void tick()
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer) }
}

function validateObservation(value: unknown, jobId: string, offset: number): { jobId: string; state: "starting" | "running" | "completed" | "failed"; chunkBase64: string; nextOffset: number; outputSize: number; exitCode?: number | null; signal?: string | null; timedOut?: boolean; durationMs?: number; error?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid observation")
  const sample = value as Record<string, unknown>
  const allowed = new Set(["jobId", "state", "chunkBase64", "nextOffset", "outputSize", "exitCode", "signal", "timedOut", "durationMs", "error"])
  if (Object.keys(sample).some(key => !allowed.has(key)) || sample.jobId !== jobId || !["starting", "running", "completed", "failed"].includes(String(sample.state)) || typeof sample.chunkBase64 !== "string"
    || !Number.isSafeInteger(sample.nextOffset) || !Number.isSafeInteger(sample.outputSize) || Number(sample.nextOffset) < offset || Number(sample.nextOffset) > offset + 65_536 || Number(sample.outputSize) < Number(sample.nextOffset)
    || (sample.exitCode !== undefined && sample.exitCode !== null && !Number.isInteger(sample.exitCode)) || (sample.signal !== undefined && sample.signal !== null && typeof sample.signal !== "string")
    || (sample.timedOut !== undefined && typeof sample.timedOut !== "boolean") || (sample.durationMs !== undefined && (typeof sample.durationMs !== "number" || !Number.isFinite(sample.durationMs) || sample.durationMs < 0))
    || (sample.error !== undefined && sample.error !== "spawn_failed" && sample.error !== "worker_failed")) throw new Error("Invalid observation")
  const chunk = Buffer.from(sample.chunkBase64, "base64")
  if (chunk.toString("base64") !== sample.chunkBase64 || chunk.byteLength !== Number(sample.nextOffset) - offset) throw new Error("Invalid observation")
  return sample as ReturnType<typeof validateObservation>
}

function retainDecoded(value: string, bytes: number, truncated: boolean, decoded: string): { value: string; bytes: number; truncated: boolean } {
  if (truncated) return { value, bytes, truncated }
  let append = ""
  for (const character of decoded) {
    const size = Buffer.byteLength(character, "utf8")
    if (bytes + size > 1_048_576) return { value: value + append, bytes, truncated: true }
    append += character; bytes += size
  }
  return { value: value + append, bytes, truncated: false }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const timer = setTimeout(done, milliseconds)
    function done() { signal.removeEventListener("abort", abort); resolve() }
    function abort() { clearTimeout(timer); reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")) }
    signal.addEventListener("abort", abort, { once: true })
  })
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
