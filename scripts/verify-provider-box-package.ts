import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const packageRoot = join(root, "packages/sandbox-provider-box")
const version = "0.1.0-alpha.1"
const expectedFiles = new Set(["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "dist/index.d.ts", "dist/index.js", "dist/waterbox-cli.js", "package.json"])

async function verify(): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "waterbox-provider-box-"))
  try {
    const packDirectory = join(temporary, "pack")
    const consumer = join(temporary, "consumer")
    await Promise.all([mkdir(packDirectory), mkdir(consumer)])
    const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory, packageRoot], { cwd: temporary })
    const packed = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>
    if (packed.length !== 1 || !packed[0]) throw new Error("npm pack did not produce exactly one provider artifact")
    const artifact = packed[0]
    const packedFiles = new Set(artifact.files.map(file => file.path))
    if (packedFiles.size !== expectedFiles.size || [...packedFiles].some(path => !expectedFiles.has(path))) throw new Error("Provider package file allowlist changed")
    const tarball = join(packDirectory, artifact.filename)
    if (!artifact.filename.endsWith(".tgz") || !(await readdir(packDirectory)).includes(basename(tarball))) throw new Error("npm pack reported an invalid provider artifact")
    await writeFile(join(consumer, "package.json"), '{"name":"provider-box-consumer","private":true,"type":"module"}\n')
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball], { cwd: consumer })
    const installed = join(consumer, "node_modules/@waterbox/provider-box")
    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as Record<string, unknown>
    if (manifest.name !== "@waterbox/provider-box" || manifest.version !== version || manifest.engines === undefined || JSON.stringify(manifest.dependencies) !== JSON.stringify({ "@waterbox/contracts": version, "@waterbox/core": version })) throw new Error("Provider manifest identity or public dependency boundary is invalid")
    const host = await readFile(join(installed, "dist/index.js"), "utf8")
    if (/from ["']@waterbox\/(?:provider-runtime|cli|runtime)/.test(host)) throw new Error("Provider host bundle retains a private Waterbox runtime import")
    await writeFile(join(consumer, "runtime.mjs"), `
import { BoxSandboxProvider, createBoxSandboxProvider, deriveBoxProviderConfigurationId } from "@waterbox/provider-box"
const config = { apiBaseUrl: "https://box.example/v1", apiKey: "test-key", polling: { intervalMs: 1, timeoutMs: 2 } }
const provider = new BoxSandboxProvider(config)
if (provider.name !== "box" || !(createBoxSandboxProvider(config) instanceof BoxSandboxProvider) || !deriveBoxProviderConfigurationId(config).startsWith("pcfg_")) throw new Error("provider public runtime failed")
`)
    await run(process.execPath, ["runtime.mjs"], { cwd: consumer })
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "typescript@^5.9.2", "@types/node@^24.3.0"], { cwd: consumer })
    await writeFile(join(consumer, "consumer.ts"), `
import { BoxSandboxProvider, createBoxSandboxProvider, deriveBoxProviderConfigurationId, type BoxProviderConfig } from "@waterbox/provider-box"
const config: BoxProviderConfig = { apiBaseUrl: "https://box.example/v1", apiKey: "test-key", polling: { intervalMs: 1, timeoutMs: 2 } }
void [new BoxSandboxProvider(config), createBoxSandboxProvider(config), deriveBoxProviderConfigurationId(config)]
`)
    await writeFile(join(consumer, "tsconfig.json"), '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","noEmit":true,"strict":true,"target":"ES2022"},"include":["consumer.ts"]}\n')
    await run(process.execPath, [join(consumer, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: consumer })
    console.log(`Verified @waterbox/provider-box@${version}: packed allowlist, isolated install, public runtime, and consumer typecheck.`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

await verify()
