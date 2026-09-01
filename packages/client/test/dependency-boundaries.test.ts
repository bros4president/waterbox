import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { glob } from "node:fs/promises"

async function importsBelow(root: string): Promise<string[]> {
  const imports: string[] = []
  for await (const path of glob(`${root}/**/*.ts`)) {
    const source = await readFile(path, "utf8")
    imports.push(...[...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]!))
  }
  return imports
}

describe("static dependency boundaries", () => {
  test("client cannot import server, core, repository, provider, MCP, or app packages", async () => {
    const imports = await importsBelow("packages/client/src")
    expect(imports.filter(value => /^@waterbox\/(?:api|core|repository|provider|mcp|control-plane)/.test(value))).toEqual([])
  })

  test("supported MCP cannot import core or repository implementation modules", async () => {
    const imports = await importsBelow("packages/mcp/src")
    expect(imports.filter(value => /^@waterbox\/(?:core|repository)/.test(value))).toEqual([])
    // The one provider-package import is deliberately limited to validating the
    // caller-adjacent runtime artifact; provider construction stays in control-plane-local.
    expect(imports.filter(value => /^@waterbox\/provider/.test(value))).toEqual(["@waterbox/provider-box"])
  })
})
