#!/usr/bin/env node
import { main, startupMessage } from "./main.ts"

main().catch((error) => {
  console.error(startupMessage(error))
  process.exitCode = 1
})
