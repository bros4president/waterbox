import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"
import { resolve } from "node:path"

const run = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const bundle = await readFile(resolve(root, "packages/mcp/dist/waterbox.js"), "utf8")

for (const word of ["aback", "gigantspinosaurus", "zydeco"]) {
  if (!bundle.includes(word)) throw new Error(`MCP bundle is missing vendored Friendly Words data: ${word}`)
}

const { stdout } = await run("npm", ["pack", "--dry-run", "--json", "./packages/mcp"], { cwd: root })
const result = JSON.parse(stdout) as Array<{ files?: Array<{ path?: string }> }>
const files = new Set(result[0]?.files?.map(file => file.path) ?? [])
for (const path of ["dist/waterbox.js", "dist/waterbox-cli.js", "dist/index.js", "THIRD_PARTY_NOTICES.md"]) {
  if (!files.has(path)) throw new Error(`MCP package is missing required artifact: ${path}`)
}
