import { resolve } from "node:path"
import { createDaemonServer } from "./index.ts"

const workspaceRoot = process.env.WORKSPACE_ROOT
if (!workspaceRoot) throw new Error("WORKSPACE_ROOT is required")
const { daemon, server } = createDaemonServer({ workspaceRoot: resolve(workspaceRoot) })
const port = Number(process.env.PORT ?? 8080)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port")

server.listen(port, "0.0.0.0")
const shutdown = () => {
  daemon.shutdown()
  server.close()
  const force = setTimeout(() => server.closeAllConnections(), 5_000)
  force.unref()
}
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)
