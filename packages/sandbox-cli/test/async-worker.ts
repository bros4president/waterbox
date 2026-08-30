import { runCli } from "../src/index.ts"

const [workspaceRoot, jobRoot, ...argv] = process.argv.slice(2)
if (workspaceRoot === undefined || jobRoot === undefined) throw new Error("Missing async worker test paths")
process.exitCode = await runCli(argv, { workspaceRoot, asyncBash: { jobRoot } })
