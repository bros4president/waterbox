import { resolve } from "node:path"
import { runCli } from "./index.ts"

const controller = new AbortController()
process.once("SIGTERM", () => controller.abort())
process.once("SIGINT", () => controller.abort())

const workspaceRoot = process.env.WORKSPACE_ROOT ?? "/workspace"
process.exitCode = await runCli(process.argv.slice(2), { workspaceRoot: resolve(workspaceRoot), signal: controller.signal })
