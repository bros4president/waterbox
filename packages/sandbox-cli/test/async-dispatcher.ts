import { runCli } from "../src/index.ts"

const [workspaceRoot, jobRoot, invocation] = process.argv.slice(2)
if (workspaceRoot === undefined || jobRoot === undefined || invocation === undefined) {
  throw new Error("Missing async dispatcher test arguments")
}
const worker = new URL("./async-worker.ts", import.meta.url).pathname
process.exitCode = await runCli(["run", invocation], {
  workspaceRoot,
  asyncBash: { jobRoot, workerExecutable: process.execPath, workerArguments: [worker, workspaceRoot, jobRoot], yieldAfterMs: 100 },
})
