import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const version = "0.1.0-alpha.1"
const packages = [
  { directory: "packages/sandbox-contracts", name: "@waterbox/contracts" },
  { directory: "packages/sandbox-core", name: "@waterbox/core" },
  { directory: "packages/sandbox-api", name: "@waterbox/api" },
] as const

interface PackResult {
  filename: string
  files: { path: string }[]
  name: string
  version: string
}

function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}${result.stderr}`)
  }
  return result.stdout
}

function assertPackedFiles(result: PackResult): void {
  const files = new Set(result.files.map(({ path }) => path))
  for (const required of ["LICENSE", "README.md", "package.json", "dist/index.js", "dist/index.d.ts"]) {
    if (!files.has(required)) throw new Error(`${result.name} tarball is missing ${required}`)
  }
  for (const path of files) {
    if (!["LICENSE", "README.md", "package.json"].includes(path) && !path.startsWith("dist/")) {
      throw new Error(`${result.name} tarball contains unexpected file ${path}`)
    }
  }
}

const temporary = await mkdtemp(join(tmpdir(), "waterbox-packages-"))
try {
  const rootLicense = await readFile(join(root, "LICENSE"), "utf8")
  const tarballs: string[] = []

  for (const item of packages) {
    const packageRoot = join(root, item.directory)
    if (await readFile(join(packageRoot, "LICENSE"), "utf8") !== rootLicense) {
      throw new Error(`${item.name} license differs from the repository license`)
    }
    const output = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], packageRoot)
    const results = JSON.parse(output) as PackResult[]
    if (results.length !== 1) throw new Error(`${item.name} produced ${results.length} tarballs`)
    const result = results[0]!
    if (result.name !== item.name || result.version !== version) throw new Error(`${item.name} package identity is invalid`)
    assertPackedFiles(result)
    tarballs.push(join(temporary, result.filename))
  }

  const consumer = join(temporary, "consumer")
  await mkdir(consumer)
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2))
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], consumer)

  await writeFile(join(consumer, "runtime.mjs"), `
import { CreateSandboxRequestSchema } from "@waterbox/contracts"
import { SandboxService } from "@waterbox/core"
import { InMemorySandboxRepository } from "@waterbox/core/test-support"
import { createWaterboxApi } from "@waterbox/api"

await Promise.all([
  "@waterbox/contracts/errors",
  "@waterbox/contracts/identity",
  "@waterbox/contracts/lifecycle",
  "@waterbox/contracts/pagination",
  "@waterbox/contracts/resources",
  "@waterbox/contracts/secure-transfer",
  "@waterbox/contracts/tools",
  "@waterbox/core/errors",
  "@waterbox/core/ports",
  "@waterbox/core/provider",
  "@waterbox/core/records",
].map(specifier => import(specifier)))

if (!CreateSandboxRequestSchema.parse({})) throw new Error("contracts import failed")
if (typeof SandboxService !== "function") throw new Error("core import failed")
if (typeof InMemorySandboxRepository !== "function") throw new Error("core subpath import failed")
if (typeof createWaterboxApi !== "function") throw new Error("api import failed")
`)
  run(process.execPath, ["runtime.mjs"], consumer)

  await writeFile(join(consumer, "consumer.ts"), `
import { IdentitySchema, type Identity } from "@waterbox/contracts"
import type { SandboxRepository } from "@waterbox/core/ports"
import type { IdentityResolver, WaterboxCore } from "@waterbox/api"

const identity: Identity = IdentitySchema.parse({ accountId: "account" })
const resolver: IdentityResolver = { async resolveBearer() { return identity } }
declare const repository: SandboxRepository
declare const core: WaterboxCore
void [resolver, repository, core]
`)
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      target: "ES2022",
    },
    include: ["consumer.ts"],
  }, null, 2))
  run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], consumer)

  console.log(`Verified ${packages.map(({ name }) => `${name}@${version}`).join(", ")} as isolated npm artifacts.`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
