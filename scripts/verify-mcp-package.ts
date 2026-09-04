import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { copyFile, cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const packageRoot = resolve(root, "packages/mcp")
const packageFiles = ["dist/waterbox.js", "dist/waterbox-cli.js", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"] as const
const packedFiles = new Set<string>([...packageFiles, "package.json"])

export interface TarballIdentity { path: string; sha256: string }
export interface InstalledArtifacts { executablePath: string; executableTarget: string; runtimeArtifact: string; canonicalInstallDirectory: string; canonicalInstalledPackage: string }

export async function resolveOnlyPackedTarball(directory: string, reportedFilename: string): Promise<string> {
  if (basename(reportedFilename) !== reportedFilename || !reportedFilename.endsWith(".tgz")) throw new Error("npm pack reported an invalid tarball filename")
  const tarballs = (await readdir(directory)).filter(path => path.endsWith(".tgz"))
  if (tarballs.length !== 1 || tarballs[0] !== reportedFilename) throw new Error("npm pack must create exactly one reported tarball in the isolated pack directory")
  return resolve(directory, reportedFilename)
}

export async function captureTarballIdentity(path: string): Promise<TarballIdentity> { return { path: resolve(path), sha256: sha256(await readFile(path)) } }
export async function assertTarballIdentity(identity: TarballIdentity): Promise<void> { if (sha256(await readFile(identity.path)) !== identity.sha256) throw new Error("The retained npm tarball changed during verification") }
export function assertCompleteFriendlyWords(bundle: string, predicates: string, objects: string): void { for (const [name, source] of [["predicates", predicates], ["objects", objects]] as const) if (!bundle.includes(JSON.stringify(source))) throw new Error(`MCP bundle does not contain the complete pinned Friendly Words ${name} corpus`) }
export function assertSameBytes(expected: Uint8Array, actual: Uint8Array, label: string): void { if (expected.byteLength !== actual.byteLength || !Buffer.from(expected).equals(Buffer.from(actual))) throw new Error(`${label} does not match the exact packed artifact`) }
export function assertPackedFileAllowlist(paths: Iterable<string>): void { const actual = new Set(paths); if (actual.size !== packedFiles.size || [...actual].some(path => !packedFiles.has(path))) throw new Error(`MCP package file allowlist mismatch: ${[...actual].sort().join(", ")}`) }
export function assertCliOnlyManifest(manifest: Record<string, any>): void {
  if (manifest.name !== "waterbox" || manifest.version !== "0.1.0-alpha.1" || manifest.engines?.node !== ">=24.15.0" || manifest.license !== "MIT" || manifest.publishConfig?.access !== "public" || manifest.publishConfig?.tag !== "next") throw new Error("Packed manifest identity, version, channel, engine, or license is invalid")
  if (JSON.stringify(manifest.bin) !== JSON.stringify({ waterbox: "./dist/waterbox.js" }) || "exports" in manifest || "main" in manifest || "types" in manifest) throw new Error("Packed package must expose only the waterbox executable")
}
export function assertNodeOnlyBundles(bundles: Iterable<[string, string]>): void { for (const [name, bundle] of bundles) if (/\bbun:|\bBun\.|\/usr\/bin\/env bun|\/Users\/|\\Users\\/.test(bundle)) throw new Error(`${name} contains a Bun runtime or release-machine path reference`) }

export async function verifyMcpPackage(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "waterbox-package-"))
  try {
    const first = await buildAndPack(temporaryRoot, "first")
    const second = await buildAndPack(temporaryRoot, "second")
    await Promise.all([assertTarballIdentity(first.identity), assertTarballIdentity(second.identity)])
    await assertReproducibleContents(first.extractDirectory, second.extractDirectory)

    const installDirectory = join(temporaryRoot, "install")
    await mkdir(installDirectory)
    await verifyPackedContent(first.extractDirectory)
    await verifyImplementationVersions()
    await assertTarballIdentity(first.identity)
    await writeFile(join(installDirectory, "package.json"), '{"name":"waterbox-package-verifier","private":true}\n')
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", first.identity.path], { cwd: installDirectory, maxBuffer: 8 * 1024 * 1024 })
    await assertTarballIdentity(first.identity)
    const installedPackage = join(installDirectory, "node_modules", "waterbox")
    await verifyInstalledContent(first.extractDirectory, installedPackage)
    const artifacts = await inspectInstalledArtifacts(installDirectory, installedPackage)
    await verifyWithAvailableNode24(artifacts, temporaryRoot)
    await verifyAddMcp(temporaryRoot)
    await assertTarballIdentity(first.identity)
    if (process.env.WATERBOX_RELEASE_ARTIFACT_DIR) {
      const output = resolve(process.env.WATERBOX_RELEASE_ARTIFACT_DIR)
      await mkdir(output, { recursive: true })
      await copyFile(first.identity.path, join(output, "waterbox-0.1.0-alpha.1.tgz"))
      assertSameBytes(await readFile(first.identity.path), await readFile(join(output, "waterbox-0.1.0-alpha.1.tgz")), "Retained release tarball")
      await writeFile(join(output, "waterbox-0.1.0-alpha.1.sha256"), `${first.identity.sha256}  waterbox-0.1.0-alpha.1.tgz\n`)
      await writeFile(join(output, "waterbox-0.1.0-alpha.1.files.sha256"), `${(await contentManifest(first.extractDirectory)).join("\n")}\n`)
    }
    console.log(`Verified retained artifact ${basename(first.identity.path)} (${first.identity.sha256}), exact reproducible contents, legal and bundle closure, isolated installation, stdio protocol, and add-mcp@2.3.0 configuration where local Node 24 binaries were available.`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function verifyImplementationVersions(): Promise<void> {
  const [server, composition, development] = await Promise.all([readFile(join(packageRoot, "src/server.ts"), "utf8"), readFile(join(root, "packages/control-plane-local/src/index.ts"), "utf8"), readFile(join(root, "apps/api-local/src/app.ts"), "utf8")])
  if (!server.includes('new Server({ name: "waterbox", version: "0.1.0-alpha.1" }') || !composition.includes('loadSandboxRuntimeArtifact(artifactLocation, "0.1.0-alpha.1")') || !development.includes('DEVELOPMENT_ARTIFACT_VERSION = "0.1.0-alpha.1"')) throw new Error("Package, MCP server, and sandbox artifact versions are not aligned at 0.1.0-alpha.1")
}

async function packFromIsolatedSource(temporaryRoot: string, name: string, sourceRoot: string) {
  const packDirectory = join(temporaryRoot, `${name}-pack`), extractDirectory = join(temporaryRoot, `${name}-extract`)
  await Promise.all([mkdir(packDirectory), mkdir(extractDirectory)])
  const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory, join(sourceRoot, "packages/mcp")], { cwd: temporaryRoot, maxBuffer: 4 * 1024 * 1024 })
  const result = parsePackResult(stdout)
  assertPackedFileAllowlist(result.files.map(file => file.path))
  const tarball = await resolveOnlyPackedTarball(packDirectory, result.filename)
  const identity = await captureTarballIdentity(tarball)
  await run("tar", ["-xzf", identity.path, "-C", extractDirectory])
  return { identity, extractDirectory: join(extractDirectory, "package") }
}

async function buildAndPack(temporaryRoot: string, name: string) {
  const sourceRoot = join(temporaryRoot, `${name}-source`)
  await mkdir(sourceRoot)
  await Promise.all([
    ...["package.json", "bun.lock", "tsconfig.json", "LICENSE", "THIRD_PARTY_NOTICES.md"].map(path => copyFile(join(root, path), join(sourceRoot, path))),
    cp(join(root, "packages"), join(sourceRoot, "packages"), { recursive: true, filter: isolatedSourceFilter }),
    cp(join(root, "apps"), join(sourceRoot, "apps"), { recursive: true, filter: isolatedSourceFilter }),
  ])
  await mkdir(join(sourceRoot, "scripts"))
  await Promise.all(["build-waterbox.mjs", "verify-mcp-bundle-closure.mjs"].map(path => copyFile(join(root, "scripts", path), join(sourceRoot, "scripts", path))))
  await run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: sourceRoot, maxBuffer: 8 * 1024 * 1024 })
  await run("bun", ["run", "build:libraries"], { cwd: sourceRoot, maxBuffer: 8 * 1024 * 1024 })
  const providerPackage = join(sourceRoot, "packages/sandbox-provider-box")
  const providerRuntime = join(sourceRoot, "packages/sandbox-provider-runtime")
  const cliRuntime = join(sourceRoot, "packages/sandbox-cli")
  const sandboxRuntime = join(sourceRoot, "packages/sandbox-runtime")
  const providerNamespace = join(providerPackage, "node_modules/@waterbox")
  await mkdir(providerNamespace, { recursive: true })
  await Promise.all([
    cp(providerRuntime, join(providerNamespace, "provider-runtime"), { recursive: true }),
    cp(cliRuntime, join(providerNamespace, "cli"), { recursive: true }),
    cp(sandboxRuntime, join(providerNamespace, "runtime"), { recursive: true }),
  ])
  await run("bun", ["run", "build:provider-box"], { cwd: sourceRoot, maxBuffer: 8 * 1024 * 1024 })
  await run("node", ["../../scripts/build-waterbox.mjs", "mcp"], { cwd: join(sourceRoot, "packages/mcp"), maxBuffer: 8 * 1024 * 1024 })
  return packFromIsolatedSource(temporaryRoot, name, sourceRoot)
}

function isolatedSourceFilter(source: string): boolean {
  return !source.split(/[\\/]/).some(part => part === "dist" || part === "node_modules" || part === ".waterbox" || part === ".DS_Store")
}

async function verifyPackedContent(extractedPackage: string): Promise<void> {
  const [mcpBundle, cliBundle, predicates, objects, rootLicense, rootNotice, packedLicense, packedNotice] = await Promise.all([
    readFile(join(extractedPackage, "dist/waterbox.js"), "utf8"), readFile(join(extractedPackage, "dist/waterbox-cli.js"), "utf8"),
    readFile(join(root, "packages/control-plane-local/src/vendor/friendly-words/predicates.txt"), "utf8"), readFile(join(root, "packages/control-plane-local/src/vendor/friendly-words/objects.txt"), "utf8"),
    readFile(join(root, "LICENSE")), readFile(join(root, "THIRD_PARTY_NOTICES.md")), readFile(join(extractedPackage, "LICENSE")), readFile(join(extractedPackage, "THIRD_PARTY_NOTICES.md")),
  ])
  assertCompleteFriendlyWords(mcpBundle, predicates, objects)
  assertSameBytes(rootLicense, packedLicense, "Packed LICENSE")
  assertSameBytes(rootNotice, packedNotice, "Packed THIRD_PARTY_NOTICES.md")
  assertNodeOnlyBundles([["waterbox.js", mcpBundle], ["waterbox-cli.js", cliBundle]])
  const manifest = JSON.parse(await readFile(join(extractedPackage, "package.json"), "utf8")) as Record<string, any>
  assertCliOnlyManifest(manifest)
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify({ "@inquirer/prompts": "7.8.6", "@napi-rs/keyring": "2.0.0" })) throw new Error("Packed runtime dependency boundary changed")
}

async function verifyInstalledContent(extractedPackage: string, installedPackage: string): Promise<void> {
  const sourceTreePrefix = `${root}/`
  for (const path of [...packageFiles, "package.json"] as const) {
    const [packed, installed] = await Promise.all([readFile(join(extractedPackage, path)), readFile(join(installedPackage, path))])
    assertSameBytes(packed, installed, `Installed ${path}`)
    if (installed.includes(sourceTreePrefix)) throw new Error(`Installed ${path} embeds a source-tree path`)
  }
  for (const dependency of ["@inquirer/prompts", "@napi-rs/keyring"]) {
    const manifest = JSON.parse(await readFile(join(dirname(installedPackage), ...dependency.split("/"), "package.json"), "utf8"))
    if (manifest.license !== "MIT") throw new Error(`${dependency} has an unexpected external runtime license`)
  }
}

export async function inspectInstalledArtifacts(installDirectory: string, installedPackage: string): Promise<InstalledArtifacts> {
  const executablePath = join(installDirectory, "node_modules/.bin/waterbox")
  const [canonicalInstallDirectory, canonicalInstalledPackage, executableTarget, expectedExecutable] = await Promise.all([realpath(installDirectory), realpath(installedPackage), realpath(executablePath), realpath(join(installedPackage, "dist/waterbox.js"))])
  if (executableTarget !== expectedExecutable || !isWithin(canonicalInstallDirectory, executableTarget)) throw new Error("Installed waterbox executable does not resolve to the retained package")
  const runtimeArtifact = await realpath(join(dirname(executableTarget), "waterbox-cli.js"))
  if (!isWithin(canonicalInstalledPackage, runtimeArtifact)) throw new Error("Installed adjacent runtime artifact resolves outside the retained package")
  if (((await stat(executableTarget)).mode & 0o111) === 0) throw new Error("Installed waterbox executable does not have executable mode")
  if (!(await readFile(executableTarget, "utf8")).startsWith("#!/usr/bin/env node\n")) throw new Error("Installed waterbox executable does not have the expected Node shebang")
  return { executablePath, executableTarget, runtimeArtifact, canonicalInstallDirectory, canonicalInstalledPackage }
}

async function verifyWithAvailableNode24(artifacts: InstalledArtifacts, temporaryRoot: string): Promise<void> {
  const candidates = new Map<string, { binary: string; exact?: string }>()
  if (basename(process.execPath) === "node" && process.versions.node.startsWith("24.")) candidates.set("current process", { binary: process.execPath })
  if (process.env.NODE_24_15_BIN) candidates.set("declared minimum", { binary: process.env.NODE_24_15_BIN, exact: "v24.15.0" })
  if (process.env.NODE_24_CURRENT_BIN) candidates.set("current Node 24", { binary: process.env.NODE_24_CURRENT_BIN })
  if (candidates.size === 0) { console.log("Node artifact execution not run: NODE_24_15_BIN and NODE_24_CURRENT_BIN are unavailable, and the current process is not Node 24."); return }
  for (const [label, candidate] of candidates) {
    const version = (await run(candidate.binary, ["--version"])).stdout.trim()
    if (candidate.exact ? version !== candidate.exact : !/^v24\.(?:1[5-9]|[2-9]\d)\.\d+$/.test(version)) throw new Error(`${label} has unsupported version ${version}`)
    await exerciseArtifactsWithNode(candidate.binary, artifacts, temporaryRoot)
  }
}

async function exerciseArtifactsWithNode(node: string, artifacts: InstalledArtifacts, temporaryRoot: string): Promise<void> {
  const nodeOnlyBin = join(temporaryRoot, `node-only-${crypto.randomUUID()}`)
  await mkdir(nodeOnlyBin)
  await symlink(resolve(node), join(nodeOnlyBin, "node"))
  const environment = cleanEnvironment(temporaryRoot, nodeOnlyBin)
  await run(node, ["--input-type=module", "--eval", 'const [keyring, prompts] = await Promise.all([import("@napi-rs/keyring"), import("@inquirer/prompts")]); if (typeof keyring.AsyncEntry !== "function" || typeof prompts.input !== "function") process.exit(1)'], { cwd: artifacts.canonicalInstallDirectory, env: environment })
  const cli = await runExpectingExit(node, [artifacts.executableTarget, "--package-verification"], 2, artifacts.canonicalInstallDirectory, environment)
  if (cli.stdout !== "" || !cli.stderr.includes("Usage: waterbox")) throw new Error("Unknown packaged arguments did not remain terminal-only")
  const runtime = await runExpectingExit(node, [artifacts.runtimeArtifact, "version"], 0, artifacts.canonicalInstallDirectory, environment)
  if (runtime.stdout.trim() !== '{"protocolVersion":2}') throw new Error("Adjacent runtime artifact returned an unexpected version")
  await protocolSmoke(node, artifacts.executableTarget, temporaryRoot, environment)
}

async function protocolSmoke(node: string, executable: string, temporaryRoot: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const home = join(temporaryRoot, `protocol-home-${crypto.randomUUID()}`)
  await mkdir(home)
  const child = spawn(node, [executable], { cwd: home, env: { ...environment, HOME: home, XDG_CONFIG_HOME: join(home, ".config") }, stdio: ["pipe", "pipe", "pipe"] })
  const messages: any[] = [], stdoutLines: string[] = [], stderr: Buffer[] = []
  child.stderr.on("data", chunk => stderr.push(chunk))
  createInterface({ input: child.stdout }).on("line", line => { stdoutLines.push(line); try { messages.push(JSON.parse(line)) } catch { child.kill(); } })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "waterbox-package-verifier", version: "1" } } }) + "\n")
  await waitForMessage(messages, 1)
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n")
  const listed = await waitForMessage(messages, 2)
  if (!Array.isArray(listed.result?.tools) || listed.result.tools.length !== 15) throw new Error("Packaged MCP returned an unexpected tool catalog")
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_sandbox", arguments: { idempotencyKey: "package-verification" } } }) + "\n")
  const called = await waitForMessage(messages, 3)
  if (called.result?.isError !== true || !called.result?.content?.[0]?.text?.toLowerCase().includes("run npx waterbox@next setup")) throw new Error("Packaged MCP did not return unconfigured setup guidance")
  child.stdin.end()
  const exit = await new Promise<number | null>((resolveExit, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error("Packaged MCP did not shut down after stdio EOF")) }, 5_000); child.once("exit", code => { clearTimeout(timer); resolveExit(code) }) })
  if (exit !== 0 || stdoutLines.length !== messages.length || Buffer.concat(stderr).toString().includes("package-verification")) throw new Error("Packaged MCP stdio was not protocol-clean or diagnostics-safe")
}

async function verifyAddMcp(temporaryRoot: string): Promise<void> {
  for (const agent of ["opencode", "codex"] as const) {
    const project = join(temporaryRoot, `add-mcp-${agent}`), home = join(temporaryRoot, `add-mcp-${agent}-home`)
    await Promise.all([mkdir(project), mkdir(home)])
    await run(join(root, "node_modules/.bin/add-mcp"), ["waterbox@next", "--name", "waterbox", "-a", agent, "-y"], { cwd: project, env: cleanEnvironment(home), maxBuffer: 4 * 1024 * 1024 })
    if (agent === "opencode") {
      const config = JSON.parse(await readFile(join(project, "opencode.jsonc"), "utf8"))
      if (JSON.stringify(config.mcp?.waterbox?.command) !== JSON.stringify(["npx", "-y", "waterbox@next"]) || config.mcp.waterbox.type !== "local") throw new Error("add-mcp@2.3.0 generated an unexpected OpenCode command")
    } else {
      const config = await readFile(join(project, ".codex/config.toml"), "utf8")
      if (!config.includes('command = "npx"') || !/args\s*=\s*\[\s*"-y"\s*,\s*"waterbox@next"\s*\]/.test(config)) throw new Error("add-mcp@2.3.0 generated an unexpected Codex command")
    }
  }
}

async function assertReproducibleContents(first: string, second: string): Promise<void> {
  const firstManifest = await contentManifest(first), secondManifest = await contentManifest(second)
  if (JSON.stringify(firstManifest) !== JSON.stringify(secondManifest)) throw new Error("Two isolated package builds have different normalized content")
}
async function contentManifest(directory: string) { return Promise.all([...packedFiles].sort().map(async path => `${path} ${sha256(await readFile(join(directory, path)))}`)) }
async function waitForMessage(messages: any[], id: number): Promise<any> { for (let attempt = 0; attempt < 500; attempt++) { const found = messages.find(message => message.id === id); if (found) return found; await new Promise(resolveWait => setTimeout(resolveWait, 10)) } throw new Error(`Timed out waiting for MCP response ${id}`) }
function cleanEnvironment(home: string, path = process.env.PATH): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), INIT_CWD: undefined, NODE_PATH: undefined }
  env.PATH = path
  for (const key of ["WATERBOX_PROVIDER", "WATERBOX_API_KEY", "WATERBOX_AUTO_STOP", "WATERBOX_MCP_DIAGNOSTICS", "BOX_API_KEY", "BOX_API_BASE_URL", "BOX_POLL_INTERVAL_MS", "BOX_POLL_TIMEOUT_MS", "VERCEL_TOKEN", "VERCEL_API_ORIGIN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "VERCEL_POLL_INTERVAL_MS", "VERCEL_POLL_TIMEOUT_MS", "VERCEL_REQUEST_TIMEOUT_MS"]) delete env[key]
  return env
}
async function runExpectingExit(command: string, arguments_: string[], expectedExit: number, cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> { try { const result = await run(command, arguments_, { cwd, env, maxBuffer: 4 * 1024 * 1024 }); if (expectedExit !== 0) throw new Error(`Packaged command unexpectedly exited 0 instead of ${expectedExit}`); return result } catch (caught) { const error = caught as Error & { code?: string | number; stdout?: string; stderr?: string }; if (Number(error.code) !== expectedExit) throw caught; return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" } } }
function isWithin(parent: string, child: string): boolean { const path = relative(parent, child); return path === "" || (!path.startsWith("..") && !isAbsolute(path)) }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex") }
function parsePackResult(output: string): { filename: string; files: Array<{ path: string }> } { const parsed = JSON.parse(output) as unknown; if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("npm pack returned an unexpected result"); const entry = parsed[0] as { filename?: unknown; files?: unknown }; if (typeof entry.filename !== "string" || !Array.isArray(entry.files) || entry.files.some(file => typeof (file as { path?: unknown }).path !== "string")) throw new Error("npm pack returned an invalid artifact manifest"); return { filename: entry.filename, files: entry.files as Array<{ path: string }> } }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await verifyMcpPackage()
