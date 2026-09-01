import { createDevelopmentControlPlane, loadDevelopmentRuntimeArtifact } from "./app.ts"
import { parseLocalApiConfig } from "./config.ts"
import { startLocalServer } from "./server.ts"

const config = parseLocalApiConfig(process.env)
const runtimeArtifact = await loadDevelopmentRuntimeArtifact()
const controlPlane = await createDevelopmentControlPlane(config, runtimeArtifact)
const running = await startLocalServer(controlPlane, { host: config.host, port: config.port, log: console.log })
let closing = false
async function close() {
  if (closing) return
  closing = true
  await running.close()
}
process.once("SIGINT", () => void close())
process.once("SIGTERM", () => void close())
