import type { LocalControlPlane } from "./app.ts"

export interface LocalServerOptions { host: string; port: number; log?: (message: string) => void }

export function startLocalServer(controlPlane: LocalControlPlane, options: LocalServerOptions) {
  let server: Bun.Server<undefined>
  try { server = Bun.serve({ hostname: options.host, port: options.port, fetch: controlPlane.fetch }) }
  catch (error) { controlPlane.close(); throw error }
  options.log?.(`Waterbox local API listening on ${server.hostname}:${server.port}`)
  let closed = false
  return {
    server,
    async close() {
      if (closed) return
      closed = true
      await server.stop()
      controlPlane.close()
    },
  }
}
