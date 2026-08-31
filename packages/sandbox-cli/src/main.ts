#!/usr/bin/env node
import { resolve } from "node:path"
import { runCli } from "./index.ts"

const workspaceRoot = process.env.WORKSPACE_ROOT ?? "/workspace"
const argv = process.argv.slice(2)
if (argv[0] === "__internal-bash-worker") {
  process.exitCode = await runCli(argv, { workspaceRoot: resolve(workspaceRoot) })
} else {
  const controller = new AbortController()
  process.once("SIGTERM", () => controller.abort())
  process.once("SIGINT", () => controller.abort())
  process.exitCode = await runCli(argv, { workspaceRoot: resolve(workspaceRoot), signal: controller.signal })
}
