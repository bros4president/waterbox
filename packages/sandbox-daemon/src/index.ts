import { BashToolArgumentsSchema, BashToolEventSchema, EditToolArgumentsSchema, EditToolEventSchema, GlobToolArgumentsSchema, GlobToolEventSchema, GrepToolArgumentsSchema, GrepToolEventSchema, PatchToolArgumentsSchema, PatchToolEventSchema, ReadToolArgumentsSchema, ReadToolEventSchema, ToolNameSchema, WriteToolArgumentsSchema, WriteToolEventSchema } from "@waterbox/contracts"
import { createRuntime, runtimeErrorStatus, RuntimeError, type RuntimeOptions } from "@waterbox/runtime"
import { createDaemonServer as createServer } from "./host.ts"

export const CANONICAL_TOOL_CATALOG = ToolNameSchema.options.map((name) => ({
  name,
  path: `/v1/tools/${name}`,
  method: "POST" as const,
}))

export interface Daemon {
  handleRequest(request: Request): Promise<Response>
  shutdown(): void
}

const inputs = { read: ReadToolArgumentsSchema, write: WriteToolArgumentsSchema, edit: EditToolArgumentsSchema, patch: PatchToolArgumentsSchema, glob: GlobToolArgumentsSchema, grep: GrepToolArgumentsSchema, bash: BashToolArgumentsSchema }
const events = { read: ReadToolEventSchema, write: WriteToolEventSchema, edit: EditToolEventSchema, patch: PatchToolEventSchema, glob: GlobToolEventSchema, grep: GrepToolEventSchema, bash: BashToolEventSchema }
const MAX_BODY_BYTES = 1_048_576
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })
function errorResponse(error: unknown): Response { const status = error instanceof SyntaxError || (error && typeof error === "object" && "issues" in error) ? 400 : runtimeErrorStatus(error); const output = error instanceof RuntimeError || status < 500 ? (error instanceof Error ? error.message : "Invalid request") : "Internal server error"; return json({ title: "Error", output, metadata: { status } }, status) }
function ndjson(stream: ReadableStream<unknown>): Response { const reader = stream.getReader(); const encoder = new TextEncoder(); return new Response(new ReadableStream({ async pull(controller) { const item = await reader.read(); if (item.done) return controller.close(); const event = BashToolEventSchema.parse(item.value); controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)) }, cancel: (reason) => reader.cancel(reason) }), { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } }) }
function cancelDetached(reader: ReadableStreamDefaultReader<Uint8Array> | undefined, reason: unknown): void {
  if (!reader) return
  try { void reader.cancel(reason).catch(() => undefined) } catch { /* Cancellation cleanup must not mask the original error. */ }
}
async function parseBody(request: Request, shutdownSignal: AbortSignal, schema: { parse(value: unknown): unknown }): Promise<Record<string, unknown>> {
  const signal = AbortSignal.any([request.signal, shutdownSignal])
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    signal.throwIfAborted()
    const declared = request.headers.get("content-length")
    if (declared !== null) {
      if (!/^\d+$/.test(declared)) throw new RuntimeError(400, "Content-Length must be a non-negative integer")
      const declaredBytes = Number(declared)
      if (!Number.isSafeInteger(declaredBytes)) throw new RuntimeError(400, "Content-Length is invalid")
      if (declaredBytes > MAX_BODY_BYTES) throw new RuntimeError(413, "Request body is too large")
    }
    if (!reader) throw new RuntimeError(400, "A JSON request body is required")
    while (true) {
      signal.throwIfAborted()
      let rejectAbort!: (reason: unknown) => void
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
      const abort = () => rejectAbort(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
      signal.addEventListener("abort", abort, { once: true })
      const item = await Promise.race([reader.read(), aborted]).finally(() => signal.removeEventListener("abort", abort))
      signal.throwIfAborted()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > MAX_BODY_BYTES) throw new RuntimeError(413, "Request body is too large")
      chunks.push(item.value)
    }
    let text: string
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))) }
    catch { throw new RuntimeError(400, "Request body must be valid UTF-8 JSON") }
    let parsed: unknown
    try { parsed = JSON.parse(text) }
    catch { throw new RuntimeError(400, "Request body must be valid JSON") }
    return schema.parse(parsed) as Record<string, unknown>
  } catch (error) {
    cancelDetached(reader, error)
    throw error
  }
}

export function createDaemon(options: RuntimeOptions): Daemon {
  if (!options.workspaceRoot) throw new TypeError("workspaceRoot is required")
  const runtime = createRuntime(options)
  const shutdownController = new AbortController()
  return {
    async handleRequest(request) {
      try {
        const path = new URL(request.url).pathname
        if (request.method === "GET" && path === "/health") return json({ status: "ok" })
        if (request.method === "GET" && path === "/v1/tools") return json(CANONICAL_TOOL_CATALOG)
        if (request.method !== "POST" || !path.startsWith("/v1/tools/")) return json({ title: "Error", output: "Not found", metadata: { status: 404 } }, 404)
        const parsedName = ToolNameSchema.safeParse(path.slice("/v1/tools/".length)); if (!parsedName.success) return json({ title: "Error", output: "Not found", metadata: { status: 404 } }, 404)
        const args = await parseBody(request, shutdownController.signal, inputs[parsedName.data])
        request.signal.throwIfAborted()
        const result = await runtime.execute(parsedName.data, args, request.signal)
        if (result instanceof ReadableStream) return ndjson(result)
        return json(events[parsedName.data].parse(result))
      } catch (error) { return errorResponse(error) }
    },
    shutdown: () => { shutdownController.abort(); runtime.shutdown() },
  }
}

export function createDaemonServer(options: RuntimeOptions) {
  const daemon = createDaemon(options)
  return { daemon, server: createServer(daemon) }
}
