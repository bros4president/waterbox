import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { resolve } from "node:path"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent"
import { createRuntime, runtimeErrorStatus, RuntimeError } from "@waterbox/runtime"
import { LIFECYCLE_PATHS, TOOL_PATHS } from "../../protocol/src/index.ts"

const MAX_BODY_BYTES = 1_048_576
const lifecyclePaths = new Set<string>(LIFECYCLE_PATHS)
const canonicalPaths = new Map<string, keyof typeof TOOL_PATHS>(Object.entries(TOOL_PATHS).map(([name, path]) => [path, name as keyof typeof TOOL_PATHS]))
const PI_PREFIX = "/v1/pi/tools/"
interface PiTool { name: string; description: string; parameters: unknown; execute(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> }
export interface ReceiverOptions { workspaceRoot?: string }
export interface Receiver { handleRequest(request: Request): Promise<Response>; shutdown(): void }
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })
function errorResponse(error: unknown): Response {
  const status = error instanceof HttpError ? error.status : runtimeErrorStatus(error)
  const output = error instanceof HttpError || error instanceof RuntimeError || (error instanceof Error && status < 500) ? error.message : "Internal server error"
  return json({ title: "Error", output, metadata: { status } }, status)
}
async function parseJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length"))
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large")
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, "A JSON request body is required")
  const chunks: Uint8Array[] = []; let bytes = 0
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    bytes += value.byteLength
    if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new HttpError(413, "Request body is too large") }
    chunks.push(value)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch { throw new HttpError(400, "Request body must be valid JSON") }
}
function ndjson(stream: ReadableStream<unknown>): Response {
  const reader = stream.getReader(); const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    async pull(controller) { const item = await reader.read(); if (item.done) return controller.close(); controller.enqueue(encoder.encode(`${JSON.stringify(item.value)}\n`)) },
    cancel: (reason) => reader.cancel(reason),
  }), { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } })
}
function piTools(root: string): Map<string, PiTool> {
  const tools = [createReadTool(root), createBashTool(root), createEditTool(root), createWriteTool(root), createGrepTool(root), createFindTool(root), createLsTool(root)] as PiTool[]
  return new Map(tools.map((tool) => [tool.name, tool]))
}
export function createReceiver(options: ReceiverOptions = {}): Receiver {
  const root = resolve(options.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? "/workspace")
  const runtime = createRuntime({ workspaceRoot: root }); const pi = piTools(root)
  return {
    async handleRequest(request) {
      try {
        const path = new URL(request.url).pathname
        if (request.method === "GET" && path === "/health") return json({ status: "ok" })
        if (request.method === "GET" && path === "/v1/pi/tools") return json([...pi.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })))
        if (request.method === "POST" && lifecyclePaths.has(path as (typeof LIFECYCLE_PATHS)[number])) return new Response(null, { status: 204 })
        if (request.method !== "POST") throw new HttpError(404, "Not found")
        if (path.startsWith(PI_PREFIX)) {
          const name = path.slice(PI_PREFIX.length); const tool = pi.get(name)
          if (!tool || name.includes("/")) throw new HttpError(404, "Not found")
          try { return json(await tool.execute(crypto.randomUUID(), await parseJson(request), request.signal)) }
          catch (error) { return json({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }) }
        }
        const name = canonicalPaths.get(path); if (!name) throw new HttpError(404, "Not found")
        const result = await runtime.execute(name, await parseJson(request), request.signal)
        if (result instanceof ReadableStream) return ndjson(result)
        const { type: _type, ...legacy } = result
        return json(legacy)
      } catch (error) { return errorResponse(error) }
    },
    shutdown: () => runtime.shutdown(),
  }
}
async function sendResponse(response: Response, outgoing: ServerResponse) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers)); if (!response.body) return void outgoing.end()
  for await (const chunk of Readable.fromWeb(response.body as never)) if (!outgoing.write(chunk)) await new Promise<void>((ok) => outgoing.once("drain", ok))
  outgoing.end()
}
function webRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
  const method = incoming.method ?? "GET"; const init: RequestInit & { duplex?: "half" } = { method, headers: incoming.headers as HeadersInit, signal }
  if (method !== "GET" && method !== "HEAD") { init.body = Readable.toWeb(incoming) as never; init.duplex = "half" }
  return new Request(`http://localhost${incoming.url ?? "/"}`, init)
}
export function createNodeServer(receiver: Receiver = createReceiver()): Server {
  return createServer(async (incoming, outgoing) => {
    const controller = new AbortController(); incoming.once("aborted", () => controller.abort()); outgoing.once("close", () => { if (!outgoing.writableEnded) controller.abort() })
    try { await sendResponse(await receiver.handleRequest(webRequest(incoming, controller.signal)), outgoing) }
    catch (error) { controller.abort(); if (!outgoing.headersSent) await sendResponse(errorResponse(error), outgoing); else outgoing.destroy() }
  })
}
export async function startServer(options: ReceiverOptions & { port?: number } = {}): Promise<Server> {
  const receiver = createReceiver(options); const server = createNodeServer(receiver)
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(options.port ?? Number(process.env.PORT ?? 8080), "0.0.0.0", ok) })
  const shutdown = () => { receiver.shutdown(); server.close(); const force = setTimeout(() => server.closeAllConnections(), 5_000); force.unref() }
  const nodeProcess = process as unknown as { once(signal: "SIGTERM" | "SIGINT", listener: () => void): void; off(signal: "SIGTERM" | "SIGINT", listener: () => void): void }
  nodeProcess.once("SIGTERM", shutdown); nodeProcess.once("SIGINT", shutdown); server.once("close", () => { nodeProcess.off("SIGTERM", shutdown); nodeProcess.off("SIGINT", shutdown) })
  return server
}
export { startServer as startReceiverServer }
if ((process.argv[1] ? resolve(process.argv[1]) : "") === fileURLToPath(import.meta.url)) startServer().catch((error) => { console.error(error); process.exitCode = 1 })
