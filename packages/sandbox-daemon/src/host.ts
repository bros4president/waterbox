import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { Readable } from "node:stream"
import type { Daemon } from "./index.ts"

export async function send(response: Response, outgoing: ServerResponse) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) return void outgoing.end()
  const reader = response.body.getReader()
  let canceled = false
  const cancel = () => {
    if (canceled) return
    canceled = true
    try { void reader.cancel().catch(() => undefined) } catch { /* Disconnect cleanup must not block the host. */ }
  }
  const onClose = () => cancel()
  outgoing.once("close", onClose)
  if (outgoing.destroyed) cancel()
  try {
    while (!canceled) {
      const { done, value } = await reader.read()
      if (done || canceled) break
      if (!outgoing.write(value)) {
        await new Promise<void>((resolve) => {
          const settled = () => {
            outgoing.off("drain", settled)
            outgoing.off("close", settled)
            resolve()
          }
          outgoing.once("drain", settled)
          outgoing.once("close", settled)
          if (outgoing.destroyed) settled()
        })
      }
    }
  } finally {
    outgoing.off("close", onClose)
  }
  if (!canceled && !outgoing.destroyed) outgoing.end()
}
function request(incoming: IncomingMessage, signal: AbortSignal): Request { const method = incoming.method ?? "GET"; const init: RequestInit & { duplex?: "half" } = { method, headers: incoming.headers as HeadersInit, signal }; if (method !== "GET" && method !== "HEAD") { init.body = Readable.toWeb(incoming) as never; init.duplex = "half" }; return new Request(`http://localhost${incoming.url ?? "/"}`, init) }
export function createDaemonServer(daemon: Daemon) { return createServer(async (incoming, outgoing) => { const abort = new AbortController(); incoming.once("aborted", () => abort.abort()); outgoing.once("close", () => { if (!outgoing.writableEnded) abort.abort() }); try { await send(await daemon.handleRequest(request(incoming, abort.signal)), outgoing) } catch { abort.abort(); if (!outgoing.headersSent) await send(Response.json({ title: "Error", output: "Internal server error", metadata: { status: 500 } }, { status: 500 }), outgoing); else outgoing.destroy() } }) }
