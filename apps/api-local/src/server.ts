import type { LocalControlPlane } from "@waterbox/control-plane-local"

export interface LocalServerOptions { host: string; port: number; idleTimeoutSeconds?: number; log?: (message: string) => void }

export async function startLocalServer(controlPlane: LocalControlPlane, options: LocalServerOptions) {
  let server: Bun.Server<undefined>
  try { server = Bun.serve({ hostname: options.host, port: options.port, fetch: controlPlane.fetch, ...(options.idleTimeoutSeconds === undefined ? {} : { idleTimeout: options.idleTimeoutSeconds }) }) }
  catch (error) { await controlPlane.close(); throw error }
  options.log?.(`Waterbox local API listening on ${server.hostname}:${server.port}`)
  let closed = false
  return {
    server,
    async close() {
      if (closed) return
      closed = true
      try { await server.stop() }
      finally { await controlPlane.close() }
    },
  }
}
