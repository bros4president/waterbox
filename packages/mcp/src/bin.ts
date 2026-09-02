#!/usr/bin/env node
import { main, startupMessage } from "./main.ts"
import { runCli } from "./cli.ts"
import { dispatch } from "./dispatch.ts"

dispatch(process.argv.slice(2), { main, cli: runCli }).then(code => { if (code !== undefined) process.exitCode = code }, error => { console.error(startupMessage(error)); process.exitCode = 1 })
