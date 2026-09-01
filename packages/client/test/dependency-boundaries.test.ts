import { describe, expect, test } from "bun:test"
import { glob, readFile } from "node:fs/promises"

type Reference = { specifier: string; kind: "static" | "dynamic" | "require"; symbols: string[] }

function references(source: string): Reference[] {
  const found: Reference[] = []
  for (const match of source.matchAll(/(?:import|export)\s+([^;"']*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = match[1]!.trim()
    const symbols = [...clause.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map(item => item[1]!).filter(value => !["type", "as", "default"].includes(value))
    found.push({ specifier: match[2]!, kind: "static", symbols })
  }
  for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) found.push({ specifier: match[1]!, kind: "static", symbols: [] })
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push({ specifier: match[1]!, kind: "dynamic", symbols: [] })
  for (const match of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push({ specifier: match[1]!, kind: "require", symbols: [] })
  return found
}

async function referencesBelow(root: string): Promise<Reference[]> {
  const result: Reference[] = []
  for await (const path of glob(`${root}/**/*.{ts,tsx,js,mjs,cjs}`)) result.push(...references(await readFile(path, "utf8")))
  return result
}

function forbiddenClient(value: string): boolean { return /^@waterbox\/(?:api|core|repository|provider|mcp|control-plane)/.test(value) }
function forbiddenMcp(value: string): boolean { return /^@waterbox\/(?:core|repository|provider)/.test(value) }
const dependencySections = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"] as const
type Manifest = Partial<Record<(typeof dependencySections)[number], Record<string, string>>>

function manifestReferences(manifest: Manifest): Array<{ section: string; specifier: string }> {
  return dependencySections.flatMap(section => Object.keys(manifest[section] ?? {}).map(specifier => ({ section, specifier })))
}

describe("dependency scanner", () => {
  test("detects static, side-effect, re-export, dynamic, and require bypass forms", () => {
    const source = `import x from "@waterbox/core"; import "@waterbox/repository-sqlite"; export { x } from "@waterbox/provider-box"; void import("@waterbox/api"); require("@waterbox/mcp");`
    expect(references(source).map(item => [item.kind, item.specifier]).sort()).toEqual([
      ["static", "@waterbox/core"], ["static", "@waterbox/repository-sqlite"], ["static", "@waterbox/provider-box"],
      ["dynamic", "@waterbox/api"], ["require", "@waterbox/mcp"],
    ].sort())
  })
  test("detects forbidden packages in every dependency map", () => {
    for (const section of dependencySections) {
      const manifest = { [section]: { "@waterbox/core": "workspace:*" } }
      expect(manifestReferences(manifest).filter(item => forbiddenMcp(item.specifier))).toEqual([{ section, specifier: "@waterbox/core" }])
    }
  })
})

describe("static dependency boundaries", () => {
  test("client source and runtime manifest cannot depend on server-side packages", async () => {
    expect((await referencesBelow("packages/client/src")).filter(item => forbiddenClient(item.specifier))).toEqual([])
    const manifest = JSON.parse(await readFile("packages/client/package.json", "utf8")) as Manifest
    expect(manifestReferences(manifest).filter(item => forbiddenClient(item.specifier))).toEqual([])
  })

  test("supported MCP cannot reach core/repositories/providers except the exact artifact loader and test-only core support", async () => {
    const denied: Reference[] = []
    for (const item of await referencesBelow("packages/mcp/src")) {
      if (!forbiddenMcp(item.specifier)) continue
      if (item.kind === "static" && item.specifier === "@waterbox/provider-box" && item.symbols.join(",") === "loadSandboxRuntimeArtifact") continue
      denied.push(item)
    }
    expect(denied).toEqual([])
    const manifest = JSON.parse(await readFile("packages/mcp/package.json", "utf8")) as Manifest
    expect(manifestReferences(manifest).filter(item => forbiddenMcp(item.specifier) && !(item.section === "devDependencies" && ["@waterbox/provider-box", "@waterbox/core"].includes(item.specifier)))).toEqual([])
  })

  test("artifact-loader exception is symbol- and syntax-specific", () => {
    const allowed = references(`import { loadSandboxRuntimeArtifact } from "@waterbox/provider-box"`)[0]!
    expect(allowed).toMatchObject({ kind: "static", specifier: "@waterbox/provider-box", symbols: ["loadSandboxRuntimeArtifact"] })
    for (const source of [`import { BoxSandboxProvider } from "@waterbox/provider-box"`, `import "@waterbox/provider-box"`, `import("@waterbox/provider-box")`, `require("@waterbox/provider-box")`]) {
      const item = references(source)[0]!
      expect(item.kind === "static" && item.symbols.join(",") === "loadSandboxRuntimeArtifact").toBeFalse()
    }
  })
})
