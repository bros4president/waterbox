import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const packageRoot = resolve(root, "packages/mcp")
const requiredFiles = ["dist/waterbox.js", "dist/waterbox-cli.js", "dist/index.js", "README.md", "THIRD_PARTY_NOTICES.md"] as const

export interface TarballIdentity { path: string; sha256: string }

export async function resolveOnlyPackedTarball(directory: string, reportedFilename: string): Promise<string> {
  if (basename(reportedFilename) !== reportedFilename || !reportedFilename.endsWith(".tgz")) throw new Error("npm pack reported an invalid tarball filename")
  const tarballs = (await readdir(directory)).filter(path => path.endsWith(".tgz"))
  if (tarballs.length !== 1 || tarballs[0] !== reportedFilename) throw new Error("npm pack must create exactly one reported tarball in the isolated pack directory")
  return resolve(directory, reportedFilename)
}

export async function captureTarballIdentity(path: string): Promise<TarballIdentity> {
  return { path: resolve(path), sha256: sha256(await readFile(path)) }
}

export async function assertTarballIdentity(identity: TarballIdentity): Promise<void> {
  if (sha256(await readFile(identity.path)) !== identity.sha256) throw new Error("The retained npm tarball changed during verification")
}

export function assertCompleteFriendlyWords(bundle: string, predicates: string, objects: string): void {
  for (const [name, source] of [["predicates", predicates], ["objects", objects]] as const) {
    if (!bundle.includes(JSON.stringify(source))) throw new Error(`MCP bundle does not contain the complete pinned Friendly Words ${name} corpus`)
  }
}

export function assertSameBytes(expected: Uint8Array, actual: Uint8Array, label: string): void {
  if (expected.byteLength !== actual.byteLength || !Buffer.from(expected).equals(Buffer.from(actual))) throw new Error(`${label} does not match the exact packed artifact`)
}

export async function verifyMcpPackage(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "waterbox-mcp-package-"))
  const packDirectory = join(temporaryRoot, "pack")
  const extractDirectory = join(temporaryRoot, "extract")
  const installDirectory = join(temporaryRoot, "install")
  try {
    await Promise.all([mkdir(packDirectory), mkdir(extractDirectory), mkdir(installDirectory)])
    const { stdout: packOutput } = await run("npm", ["pack", "--json", "--pack-destination", packDirectory, packageRoot], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
    const packResult = parsePackResult(packOutput)
    const tarball = await resolveOnlyPackedTarball(packDirectory, packResult.filename)
    const identity = await captureTarballIdentity(tarball)
    const listedFiles = new Set(packResult.files.map(file => file.path))
    for (const path of requiredFiles) if (!listedFiles.has(path)) throw new Error(`MCP package is missing required artifact: ${path}`)

    await run("tar", ["-xzf", identity.path, "-C", extractDirectory], { cwd: temporaryRoot })
    await assertTarballIdentity(identity)
    const extractedPackage = join(extractDirectory, "package")
    await verifyPackedContent(extractedPackage)

    await writeFile(join(installDirectory, "package.json"), '{"name":"waterbox-package-verifier","private":true}\n')
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", identity.path], { cwd: installDirectory, maxBuffer: 4 * 1024 * 1024 })
    await assertTarballIdentity(identity)
    const installedPackage = join(installDirectory, "node_modules", "@waterbox", "mcp")
    await verifyInstalledContent(extractedPackage, installedPackage)
    await verifyInstalledExecution(installDirectory, installedPackage)
    await assertTarballIdentity(identity)
    console.log(`Verified one retained npm artifact ${basename(identity.path)} (${identity.sha256}), its exact notices and complete pinned Friendly Words corpora, installed entry points, and current Node execution.`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function verifyPackedContent(extractedPackage: string): Promise<void> {
  const [bundle, predicates, objects, expectedNotice, packedNotice] = await Promise.all([
    readFile(join(extractedPackage, "dist/waterbox.js"), "utf8"),
    readFile(join(root, "packages/control-plane-local/src/vendor/friendly-words/predicates.txt"), "utf8"),
    readFile(join(root, "packages/control-plane-local/src/vendor/friendly-words/objects.txt"), "utf8"),
    readFile(join(packageRoot, "THIRD_PARTY_NOTICES.md")),
    readFile(join(extractedPackage, "THIRD_PARTY_NOTICES.md")),
  ])
  assertCompleteFriendlyWords(bundle, predicates, objects)
  assertSameBytes(expectedNotice, packedNotice, "Packed THIRD_PARTY_NOTICES.md")
  const manifest = JSON.parse(await readFile(join(extractedPackage, "package.json"), "utf8")) as { name?: unknown; engines?: { node?: unknown } }
  if (manifest.name !== "@waterbox/mcp" || manifest.engines?.node !== ">=24.15.0") throw new Error("Packed MCP manifest has an unexpected package name or Node engine")
}

async function verifyInstalledContent(extractedPackage: string, installedPackage: string): Promise<void> {
  const sourceTreePrefix = `${root}/`
  for (const path of [...requiredFiles, "package.json"] as const) {
    const [packed, installed] = await Promise.all([readFile(join(extractedPackage, path)), readFile(join(installedPackage, path))])
    assertSameBytes(packed, installed, `Installed ${path}`)
    if (installed.includes(sourceTreePrefix)) throw new Error(`Installed ${path} embeds a source-tree path`)
  }
  const [expectedNotice, installedNotice] = await Promise.all([readFile(join(packageRoot, "THIRD_PARTY_NOTICES.md")), readFile(join(installedPackage, "THIRD_PARTY_NOTICES.md"))])
  assertSameBytes(expectedNotice, installedNotice, "Installed THIRD_PARTY_NOTICES.md")
}

async function verifyInstalledExecution(installDirectory: string, installedPackage: string): Promise<void> {
  const executable = await realpath(join(installDirectory, "node_modules/.bin/waterbox"))
  const expectedExecutable = await realpath(join(installedPackage, "dist/waterbox.js"))
  if (executable !== expectedExecutable || !isWithin(installDirectory, executable)) throw new Error("Installed waterbox executable does not resolve to the retained package")
  const runtimeArtifact = await realpath(join(dirname(executable), "waterbox-cli.js"))
  if (!isWithin(installedPackage, runtimeArtifact)) throw new Error("Installed adjacent runtime artifact resolves outside the retained package")

  const currentVersion = await nodeVersion("node")
  if (!nodeSatisfiesDeclaredMinimum(currentVersion)) throw new Error(`Current Node ${currentVersion} does not satisfy the packed >=24.15.0 engine`)
  await exerciseArtifacts("node", executable, runtimeArtifact, installDirectory)

  const minimumNode = process.env.NODE_24_15_BIN
  if (minimumNode === undefined) {
    console.log("Declared-minimum execution not run: NODE_24_15_BIN is unavailable; current compatible Node execution passed.")
    return
  }
  const minimumVersion = await nodeVersion(minimumNode)
  if (minimumVersion !== "v24.15.0") throw new Error(`NODE_24_15_BIN must identify Node v24.15.0, received ${minimumVersion}`)
  await exerciseArtifacts(minimumNode, executable, runtimeArtifact, installDirectory)
  console.log("Declared-minimum execution passed with NODE_24_15_BIN (Node v24.15.0).")
}

async function exerciseArtifacts(node: string, executable: string, runtimeArtifact: string, cwd: string): Promise<void> {
  const cli = await runExpectingExit(node, [executable, "--package-verification"], 2, cwd)
  if (!cli.stderr.includes("Usage: waterbox")) throw new Error("Installed waterbox executable did not run its packaged CLI")
  const runtime = await runExpectingExit(node, [runtimeArtifact, "version"], 0, cwd)
  if (runtime.stdout.trim() !== '{"protocolVersion":2}') throw new Error("Installed adjacent runtime artifact returned an unexpected version")
}

async function runExpectingExit(command: string, arguments_: string[], expectedExit: number, cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await run(command, arguments_, { cwd, env: { ...process.env, NODE_PATH: undefined }, maxBuffer: 4 * 1024 * 1024 })
    if (expectedExit !== 0) throw new Error(`Packaged command unexpectedly exited 0 instead of ${expectedExit}`)
    return result
  } catch (caught) {
    const error = caught as Error & { code?: string | number; stdout?: string; stderr?: string }
    if (Number(error.code) !== expectedExit) throw caught
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" }
  }
}

async function nodeVersion(binary: string): Promise<string> { return (await run(binary, ["--version"])).stdout.trim() }
function nodeSatisfiesDeclaredMinimum(version: string): boolean {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const [, major, minor, patch] = match.map(Number)
  return major! > 24 || (major === 24 && (minor! > 15 || (minor === 15 && patch! >= 0)))
}
function isWithin(parent: string, child: string): boolean { const path = relative(resolve(parent), resolve(child)); return path === "" || (!path.startsWith("..") && !isAbsolute(path)) }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex") }

function parsePackResult(output: string): { filename: string; files: Array<{ path: string }> } {
  const parsed = JSON.parse(output) as unknown
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("npm pack returned an unexpected result")
  const entry = parsed[0] as { filename?: unknown; files?: unknown }
  if (typeof entry.filename !== "string" || !Array.isArray(entry.files) || entry.files.some(file => typeof (file as { path?: unknown }).path !== "string")) throw new Error("npm pack returned an invalid artifact manifest")
  return { filename: entry.filename, files: entry.files as Array<{ path: string }> }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await verifyMcpPackage()
