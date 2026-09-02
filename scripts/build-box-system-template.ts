import { readFile, writeFile, mkdir } from "node:fs/promises"
import { execFile } from "node:child_process"
import { dirname, posix, resolve } from "node:path"
import { promisify } from "node:util"

const AUTHORIZATION = "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES"
const DEFAULT_BASE_URL = "https://ascii.dev/api/box/v1"
const DEFAULT_TEMPLATE = "waterbox-system-v6"
const MAX_RESPONSE_BYTES = 1_048_576
const execFileAsync = promisify(execFile)
const BOX_STATES = new Set(["init", "provisioning", "provisioned", "cloning", "ready", "idle", "running", "archiving", "archived", "error"])
const SNAPSHOT_STATES = new Set(["saving", "ready", "failed"])
const DELETION_STATES = new Set(["pending", "processing", "blocked", "completed"])
const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/
const DELETION_ID = /^bdop_[a-f0-9]{32}$/
const READY_STATES = new Set(["ready", "idle"])
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface TemplateConfig {
  apiBaseUrl: string
  apiKey: string
  templateName: string
  artifactPath: string
  metadataPath: string
  pollIntervalMs: number
  pollTimeoutMs: number
  requestTimeoutMs: number
}

export interface TemplateDependencies {
  fetch: Fetcher
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>
  randomId(): string
  log(value: Readonly<Record<string, string | number | boolean>>): void
  readArtifact(path: string): Promise<Uint8Array>
  writeMetadata(path: string, value: string): Promise<void>
}

export interface TemplateMetadata {
  schemaVersion: 2
  provider: "box"
  templateRef: string
  artifactKind: "waterbox-cli"
  cliProtocolVersion: 2
  builtAt: string
}

export function builderHelp(): string {
  return `Build: bun run build:box-template --run\nValidate only: bun run build:box-template --validate\nRequired for live build: BOX_API_KEY and BOX_TEMPLATE_BUILD_AUTHORIZATION=${AUTHORIZATION}\nOptional: BOX_API_BASE_URL, WATERBOX_BOX_TEMPLATE_NAME, WATERBOX_CLI_ARTIFACT, WATERBOX_TEMPLATE_METADATA, BOX_TEMPLATE_POLL_INTERVAL_MS, BOX_TEMPLATE_POLL_TIMEOUT_MS, BOX_TEMPLATE_REQUEST_TIMEOUT_MS`
}

export function loadTemplateConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): TemplateConfig {
  if (argv.some((value) => value !== "--validate" && value !== "--run")) throw new Error(`Unknown option. ${builderHelp()}`)
  const validate = argv.includes("--validate")
  const run = argv.includes("--run")
  if (validate === run) throw new Error(`Choose exactly one of --validate or --run. ${builderHelp()}`)
  if (run && env.BOX_TEMPLATE_BUILD_AUTHORIZATION !== AUTHORIZATION) throw new Error("Live template build is not environment-authorized")
  if (run && !plain(env.BOX_API_KEY)) throw new Error("BOX_API_KEY is required")
  const templateName = env.WATERBOX_BOX_TEMPLATE_NAME ?? DEFAULT_TEMPLATE
  validateSnapshotName(templateName)
  const artifactPath = resolve(env.WATERBOX_CLI_ARTIFACT ?? "packages/sandbox-cli/dist/waterbox-cli.js")
  return {
    apiBaseUrl: cleanUrl(env.BOX_API_BASE_URL ?? DEFAULT_BASE_URL),
    apiKey: run ? env.BOX_API_KEY! : "",
    templateName,
    artifactPath,
    metadataPath: resolve(env.WATERBOX_TEMPLATE_METADATA ?? ".waterbox/box-system-template.json"),
    pollIntervalMs: positiveInteger(env.BOX_TEMPLATE_POLL_INTERVAL_MS ?? "1000", "BOX_TEMPLATE_POLL_INTERVAL_MS"),
    pollTimeoutMs: positiveInteger(env.BOX_TEMPLATE_POLL_TIMEOUT_MS ?? "600000", "BOX_TEMPLATE_POLL_TIMEOUT_MS"),
    requestTimeoutMs: positiveInteger(env.BOX_TEMPLATE_REQUEST_TIMEOUT_MS ?? "30000", "BOX_TEMPLATE_REQUEST_TIMEOUT_MS"),
  }
}

export function createTemplateRequest(runId: string): { body: { noEnv: true; env: { WATERBOX_SANDBOX_ID: string }; ttlSeconds: number }; idempotencyKey: string } {
  const safe = runId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20)
  if (safe.length < 8) throw new Error("Template build identifier is invalid")
  const tag = `waterbox-template-${safe}`
  return { body: { noEnv: true, env: { WATERBOX_SANDBOX_ID: tag }, ttlSeconds: 1800 }, idempotencyKey: tag }
}

export function installCommand(): string {
  const launcher = `#!/bin/sh\nset -eu\nsudo -n install -d -m 0755 -o "$(id -u)" -g "$(id -g)" /home/user/workspace\nsudo -n install -d -m 0700 /run/waterbox/bash-jobs\ncd /home/user/workspace\nexec sudo -n env WORKSPACE_ROOT=/home/user/workspace /usr/local/bin/node /usr/local/lib/waterbox-cli.js "$@"\n`
  return [
    "set -eu",
    "sudo -n true",
    "sudo install -d -m 0755 -o \"$(id -u)\" -g \"$(id -g)\" /home/user/workspace",
    "test -x /usr/local/bin/node",
    "sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ripgrep ca-certificates && sudo rm -rf /var/lib/apt/lists/*",
    "sudo install -d -m 0755 /usr/local/lib",
    "sudo install -m 0644 /tmp/waterbox-cli.js /usr/local/lib/waterbox-cli.js",
    `printf '%s' '${launcher.replaceAll("'", "'\\''")}' | sudo tee /usr/local/bin/waterbox >/dev/null`,
    "sudo chmod 0755 /usr/local/bin/waterbox",
    `test "$(waterbox health)" = '${JSON.stringify({ ok: true, protocolVersion: 2, tools: ["read", "write", "edit", "patch", "glob", "grep", "bash"] })}'`,
    `test "$(waterbox version)" = '${JSON.stringify({ protocolVersion: 2 })}'`,
  ].join("\n")
}

export function parseMetadata(text: string): TemplateMetadata {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error("Template metadata is not valid JSON") }
  if (!object(value) || value.schemaVersion !== 2 || value.provider !== "box" || !plain(value.templateRef) || !validSnapshotName(value.templateRef) || value.artifactKind !== "waterbox-cli" || value.cliProtocolVersion !== 2 || !plain(value.builtAt) || Number.isNaN(Date.parse(value.builtAt))) throw new Error("Template metadata is invalid")
  return value as unknown as TemplateMetadata
}

export function validateCliArtifact(artifact: Uint8Array): void {
  let text: string
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(artifact) } catch { throw new Error("CLI artifact must be a Node JavaScript bundle") }
  if (!text.startsWith("#!/usr/bin/env node\n") || !text.includes("WORKSPACE_ROOT") || !text.includes("__internal-bash-worker") || !text.includes("/usr/local/bin/node") || !text.includes("/usr/local/lib/waterbox-cli.js") || /bun:|\bBun\.|\/\/ @bun|#!\/usr\/bin\/env bun/.test(text)) throw new Error("CLI artifact must be a Node JavaScript bundle with direct async worker re-exec")
}

export function validateCliReports(healthText: string, versionText: string): void {
  let health: unknown, version: unknown
  try { health = JSON.parse(healthText); version = JSON.parse(versionText) } catch { throw new Error("CLI health/version output is invalid") }
  if (!object(health) || health.ok !== true || health.protocolVersion !== 2 || !Array.isArray(health.tools) || health.tools.join(",") !== "read,write,edit,patch,glob,grep,bash") throw new Error("CLI health output is incompatible")
  if (!object(version) || Object.keys(version).length !== 1 || version.protocolVersion !== 2) throw new Error("CLI version output is incompatible")
}

async function validateBuiltCli(artifactPath: string): Promise<void> {
  const output: string[] = []
  for (const command of ["health", "version"]) {
    const { stdout, stderr } = await execFileAsync("node", [artifactPath, command], { encoding: "utf8", maxBuffer: 64 * 1024 })
    if (stderr !== "") throw new Error(`Built CLI ${command} failed`)
    output.push(stdout)
  }
  validateCliReports(output[0]!, output[1]!)
}

export async function runTemplateBuild(config: TemplateConfig, dependencies: TemplateDependencies): Promise<TemplateMetadata> {
  const artifact = await dependencies.readArtifact(config.artifactPath)
  validateCliArtifact(artifact)
  const request = createTemplateRequest(dependencies.randomId())
  const client = new BoxTemplateClient(config, dependencies)
  let boxId: string | undefined
  let snapshotMutationAmbiguous = false
  try {
    const existing = await client.getSnapshotIfPresent(config.templateName)
    if (existing !== undefined) throw new Error("Template already exists; use a new immutable versioned name")
    if (existing === "saving") throw new Error("Template snapshot save is already in progress")
    dependencies.log({ stage: "source-create", status: "requesting" })
    const created = await createBoxWithRecovery(client, request.body, request.idempotencyKey)
    boxId = created.id
    dependencies.log({ stage: "source-create", status: "accepted" })
    await client.waitForBox(boxId, READY_STATES, "source-readiness")
    await client.uploadArtifact(boxId, artifact)
    dependencies.log({ stage: "cli-upload", status: "completed", bytes: artifact.byteLength })
    parseCommand(await client.json("POST", `/boxes/${segment(boxId)}/commands`, { body: { command: installCommand(), timeoutSeconds: 600 } }))
    dependencies.log({ stage: "cli-health", status: "verified" })
    parseAction(await client.json("POST", `/boxes/${segment(boxId)}/stop`), boxId, "box.stopping")
    await client.waitForBox(boxId, new Set(["archived"]), "source-stop")
    dependencies.log({ stage: "snapshot-save", status: "requesting" })
    try {
      parseSnapshot(await client.json("POST", "/named-snapshots", { body: { boxId, name: config.templateName } }), "snapshot.named.saving", config.templateName, boxId)
    } catch (error) {
      snapshotMutationAmbiguous = !(error instanceof BoxHttpError && error.status < 500)
      throw error
    }
    await client.waitForSnapshot(config.templateName, boxId)
    const metadata: TemplateMetadata = { schemaVersion: 2, provider: "box", templateRef: config.templateName, artifactKind: "waterbox-cli", cliProtocolVersion: 2, builtAt: new Date().toISOString() }
    await dependencies.writeMetadata(config.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
    dependencies.log({ stage: "metadata", status: "written" })
    const cleanupStatus = await client.deleteBox(boxId)
    boxId = undefined
    dependencies.log({ stage: "cleanup", deletionAccepted: true, deletionStatus: cleanupStatus })
    return metadata
  } catch (error) {
    if (boxId && !snapshotMutationAmbiguous) await client.bestEffortDelete(boxId)
    throw new Error(redact(error, [config.apiKey, boxId]))
  }
}

class BoxTemplateClient {
  constructor(private readonly config: TemplateConfig, private readonly dependencies: TemplateDependencies) {}
  get pollTimeoutMs(): number { return this.config.pollTimeoutMs }
  pause(): Promise<void> { return this.dependencies.sleep(this.config.pollIntervalMs, AbortSignal.timeout(this.config.requestTimeoutMs)) }

  async json(method: string, path: string, options: { body?: unknown; idempotencyKey?: string; confirmDelete?: string } = {}): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.config.apiKey}`, accept: "application/json" }
    if (options.body !== undefined) headers["content-type"] = "application/json"
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey
    if (options.confirmDelete) headers["x-ascii-confirm-delete"] = options.confirmDelete
    let response: Response
    try { response = await this.dependencies.fetch(`${this.config.apiBaseUrl}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: AbortSignal.timeout(this.config.requestTimeoutMs) }) }
    catch { throw new AmbiguousRequestError(method === "POST" && (path === "/named-snapshots" || path.endsWith("/commands")) ? "Mutation outcome is ambiguous; reconcile provider state before cleanup" : "Box request failed") }
    if (!response.ok) { const error = await boundedJson(response).catch(() => undefined); throw new BoxHttpError(response.status, safeErrorCode(error, response.status)) }
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") { response.body?.cancel().catch(() => {}); throw new Error("Box returned non-JSON data") }
    return boundedJson(response)
  }

  async uploadArtifact(boxId: string, artifact: Uint8Array): Promise<void> {
    const value = await this.json("PUT", `/boxes/${segment(boxId)}/files`, { body: { path: "/tmp/waterbox-cli.js", content: Buffer.from(artifact).toString("base64"), encoding: "base64" } })
    parseArtifactUpload(value, artifact.byteLength)
  }

  async getSnapshotIfPresent(name: string): Promise<string | undefined> {
    const response = await this.dependencies.fetch(`${this.config.apiBaseUrl}/named-snapshots/${segment(name)}`, { headers: { authorization: `Bearer ${this.config.apiKey}`, accept: "application/json" }, signal: AbortSignal.timeout(this.config.requestTimeoutMs) })
    if (response.status === 404) { response.body?.cancel().catch(() => {}); return undefined }
    if (!response.ok) { response.body?.cancel().catch(() => {}); throw new Error(`Box request failed with HTTP ${response.status}`) }
    return parseSnapshot(await boundedJson(response), "snapshot.named.info", name)
  }

  async waitForBox(id: string, terminal: ReadonlySet<string>, stage: string): Promise<void> {
    const deadline = Date.now() + this.config.pollTimeoutMs
    while (true) {
      const state = infoBox(await this.json("GET", `/boxes/${segment(id)}`), id)
      this.dependencies.log({ stage, state })
      if (terminal.has(state)) return
      if (state === "error" || Date.now() >= deadline) throw new Error(state === "error" ? "Box entered error state" : "Box polling timed out")
      await this.dependencies.sleep(this.config.pollIntervalMs, AbortSignal.timeout(this.config.requestTimeoutMs))
    }
  }

  async waitForSnapshot(name: string, boxId: string): Promise<void> {
    const deadline = Date.now() + this.config.pollTimeoutMs
    while (true) {
      const state = parseSnapshot(await this.json("GET", `/named-snapshots/${segment(name)}`), "snapshot.named.info", name, boxId)
      this.dependencies.log({ stage: "snapshot-save", state })
      if (state === "ready") return
      if (state === "failed" || Date.now() >= deadline) throw new Error(state === "failed" ? "Named snapshot failed" : "Snapshot polling timed out")
      await this.dependencies.sleep(this.config.pollIntervalMs, AbortSignal.timeout(this.config.requestTimeoutMs))
    }
  }

  async deleteBox(id: string): Promise<"completed" | "accepted_pending"> {
    const operationId = deletionResponse(await this.json("DELETE", `/boxes/${segment(id)}`, { confirmDelete: id }), id)
    const deadline = Date.now() + this.config.pollTimeoutMs
    while (true) {
      const status = deletionStatus(await this.json("GET", `/deletion-operations/${segment(operationId)}`), operationId, id)
      if (status === "completed") return "completed"
      if (status === "blocked") return "accepted_pending"
      if (Date.now() >= deadline) throw new Error("Template source deletion polling timed out")
      await this.dependencies.sleep(this.config.pollIntervalMs, AbortSignal.timeout(this.config.requestTimeoutMs))
    }
  }

  async bestEffortDelete(id: string): Promise<void> { try { await this.deleteBox(id) } catch {} }
}

class AmbiguousRequestError extends Error {}
class BoxHttpError extends Error { constructor(readonly status: number, readonly code?: string) { super(`Box request failed with HTTP ${status}${code ? ` (${code})` : ""}`) } }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function plain(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 }
function validSnapshotName(value: string): boolean { return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) && !["latest", "tree", "pull", "rm", "save", "current", "self", "new"].includes(value) }
function validateSnapshotName(value: string): void { if (!validSnapshotName(value)) throw new Error("WATERBOX_BOX_TEMPLATE_NAME is invalid or reserved") }
function segment(value: string): string { return encodeURIComponent(value) }
function positiveInteger(value: string, name: string, maximum = Number.MAX_SAFE_INTEGER): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be a positive integer`); return parsed }
function cleanUrl(value: string): string { let url: URL; try { url = new URL(value) } catch { throw new Error("BOX_API_BASE_URL must be a valid HTTPS URL") }; if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("BOX_API_BASE_URL must be a credential-free HTTPS URL"); return url.toString().replace(/\/$/, "") }
function validBox(value: unknown, expectedId?: string): value is Record<string, unknown> { return object(value) && plain(value.id) && BOX_ID.test(value.id) && (expectedId === undefined || value.id === expectedId) && plain(value.name) && plain(value.state) && BOX_STATES.has(value.state) && typeof value.desktopAvailable === "boolean" && typeof value.snapshotAvailable === "boolean" }
export function parseCreatedBox(value: unknown): { id: string } { if (!object(value) || value.ok !== true || value.type !== "box.created" || !plain(value.status) || !BOX_STATES.has(value.status) || !(Number.isSafeInteger(value.ttlSeconds) && Number(value.ttlSeconds) >= 1 || value.ttlSeconds === null) || !validBox(value.box) || (value.status !== "provisioning" && value.status !== value.box.state)) throw new Error("Box returned an invalid create response"); return { id: String(value.box.id) } }
function infoBox(value: unknown, id: string): string { if (!object(value) || value.ok !== true || value.type !== "box.info" || !validBox(value.box, id)) throw new Error("Box returned an invalid lifecycle response"); return String(value.box.state) }
export function parseAction(value: unknown, id: string, type: string): void { if (!object(value) || value.ok !== true || value.type !== type || value.id !== id || !plain(value.status) || (value.box !== undefined && value.box !== null && !validBox(value.box, id))) throw new Error("Box returned an invalid action response") }
export function parseCommand(value: unknown): void { if (!object(value) || value.ok !== true || value.type !== "command.finished" || typeof value.stdout !== "string" || typeof value.stderr !== "string" || typeof value.exitCode !== "number" || typeof value.timedOut !== "boolean") throw new Error("Box returned an invalid command response"); if (value.success !== true || value.exitCode !== 0 || value.timedOut !== false) { const detail = value.stderr.trim().slice(-1_000).replace(/[\r\n\t]+/g, " "); throw new Error(`Box command failed${detail ? `: ${detail}` : ""}`) } }
export function parseArtifactUpload(value: unknown, expectedSize: number): void { if (!object(value) || value.ok !== true || value.type !== "file.written" || value.success !== true || typeof value.path !== "string" || posix.resolve("/home/user", value.path) !== "/tmp/waterbox-cli.js" || value.encoding !== "base64" || !Number.isSafeInteger(value.size) || value.size !== expectedSize) throw new Error("Box returned an invalid artifact upload response") }
export function parseSnapshot(value: unknown, type: string, name: string, sourceBoxId?: string): string { if (!object(value) || value.ok !== true || value.type !== type || !object(value.snapshot) || (type === "snapshot.named.saving" && (value.status !== "saving" || value.snapshot.status !== "saving")) || value.snapshot.name !== name || !plain(value.snapshot.status) || !SNAPSHOT_STATES.has(value.snapshot.status) || !plain(value.snapshot.sourceBoxId) || !BOX_ID.test(value.snapshot.sourceBoxId) || !validDate(value.snapshot.createdAt) || (sourceBoxId !== undefined && value.snapshot.sourceBoxId !== sourceBoxId) || (value.snapshot.status === "ready" && !plain(value.snapshot.snapshotId))) throw new Error("Box returned an invalid named snapshot response"); return value.snapshot.status }
function validDeletion(value: unknown, boxId: string, operationId?: string): value is Record<string, unknown> { return object(value) && plain(value.id) && DELETION_ID.test(value.id) && (operationId === undefined || value.id === operationId) && value.kind === "box" && value.targetId === boxId && ["explicit", "zdr", "account"].includes(String(value.reason)) && plain(value.status) && DELETION_STATES.has(value.status) && Number.isInteger(value.attemptCount) && Number(value.attemptCount) >= 0 && validDate(value.requestedAt) && (value.completedAt === null || validDate(value.completedAt)) }
function deletionResponse(value: unknown, boxId: string): string { if (!object(value) || value.ok !== true || value.type !== "box.deleting" || !validDeletion(value.operation, boxId)) throw new Error("Box returned an invalid deletion response"); return String(value.operation.id) }
function deletionStatus(value: unknown, operationId: string, boxId: string): string { if (!object(value) || value.ok !== true || value.type !== "deletion.operation" || !validDeletion(value.operation, boxId, operationId)) throw new Error("Box returned an invalid deletion operation"); return String(value.operation.status) }
async function createBoxWithRecovery(client: BoxTemplateClient, body: unknown, idempotencyKey: string): Promise<{ id: string }> { const deadline = Date.now() + client.pollTimeoutMs; while (true) { try { return parseCreatedBox(await client.json("POST", "/boxes", { body, idempotencyKey })) } catch (error) { const recoverable = error instanceof AmbiguousRequestError || error instanceof BoxHttpError && (error.status >= 500 || error.status === 409 && error.code === "idempotency_in_progress"); if (!recoverable || Date.now() >= deadline) throw error; await client.pause() } } }
export async function boundedJson(response: Response): Promise<unknown> { if (!response.body) throw new Error("Box returned an empty response"); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("Box response exceeded size limit") } chunks.push(value) } } catch (error) { try { await reader.cancel() } catch {}; throw error } const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength } try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { throw new Error("Box returned invalid JSON") } }
function safeErrorCode(value: unknown, status: number): string | undefined { if (!object(value) || value.ok !== false || value.type !== "box.error" || value.status !== status || !plain(value.code) || !plain(value.message) || !plain(value.requestId) || !object(value.error) || value.error.code !== value.code || value.error.status !== status || !plain(value.error.message)) return undefined; return value.code }
function validDate(value: unknown): boolean { return plain(value) && !Number.isNaN(Date.parse(value)) }
function redact(error: unknown, secrets: readonly (string | undefined)[]): string { let message = error instanceof Error ? error.message : "Template build failed"; for (const secret of secrets) if (plain(secret)) message = message.replaceAll(secret, "[REDACTED]"); return message.replace(/https:\/\/[^\s"']+\?_token=[^\s"']+/gi, "[REDACTED_URL]") }

async function main(): Promise<void> {
  if (process.argv.includes("--help")) { console.log(builderHelp()); return }
  if (process.env.NODE_ENV === "test" || process.argv.some(value => value.includes("bun-test"))) throw new Error("Live Box template builds are disabled under bun test")
  const config = loadTemplateConfig(process.env, process.argv.slice(2))
  const artifact = await readFile(config.artifactPath)
  validateCliArtifact(artifact)
  await validateBuiltCli(config.artifactPath)
  if (process.argv.includes("--validate")) { console.log(JSON.stringify({ valid: true, artifactBytes: artifact.byteLength, templateRef: config.templateName, cliProtocolVersion: 2 })); return }
  const dependencies: TemplateDependencies = {
    fetch,
    sleep: (milliseconds, signal) => new Promise((resolveSleep, reject) => { const timer = setTimeout(resolveSleep, milliseconds); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason) }, { once: true }) }),
    randomId: () => crypto.randomUUID(),
    log: value => console.log(JSON.stringify(value)),
    readArtifact: path => readFile(path),
    writeMetadata: async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value, { mode: 0o600 }) },
  }
  const metadata = await runTemplateBuild(config, dependencies)
  console.log(JSON.stringify({ stage: "complete", templateRef: metadata.templateRef, metadataPath: config.metadataPath }))
}

if (import.meta.main) main().catch(error => { console.error(redact(error, [process.env.BOX_API_KEY])); process.exitCode = 1 })
