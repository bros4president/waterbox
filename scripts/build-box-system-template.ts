import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const AUTHORIZATION = "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES"
const DEFAULT_BASE_URL = "https://ascii.dev/api/box/v1"
const DEFAULT_TEMPLATE = "waterbox-system-v1"
const MAX_RESPONSE_BYTES = 1_048_576
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
  daemonPort: number
  pollIntervalMs: number
  pollTimeoutMs: number
  requestTimeoutMs: number
  replace: boolean
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
  schemaVersion: 1
  provider: "box"
  templateRef: string
  daemonPort: number
  builtAt: string
}

export function builderHelp(): string {
  return `Build: bun run build:box-template --run [--replace]\nValidate only: bun run build:box-template --validate\nRequired for live build: BOX_API_KEY and BOX_TEMPLATE_BUILD_AUTHORIZATION=${AUTHORIZATION}\nOptional: BOX_API_BASE_URL, WATERBOX_BOX_TEMPLATE_NAME, WATERBOX_DAEMON_ARTIFACT, WATERBOX_TEMPLATE_METADATA, WATERBOX_DAEMON_PORT, BOX_TEMPLATE_POLL_INTERVAL_MS, BOX_TEMPLATE_POLL_TIMEOUT_MS, BOX_TEMPLATE_REQUEST_TIMEOUT_MS`
}

export function loadTemplateConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): TemplateConfig {
  const validate = argv.includes("--validate")
  const run = argv.includes("--run")
  if (validate === run) throw new Error(`Choose exactly one of --validate or --run. ${builderHelp()}`)
  if (run && env.BOX_TEMPLATE_BUILD_AUTHORIZATION !== AUTHORIZATION) throw new Error("Live template build is not environment-authorized")
  if (run && !plain(env.BOX_API_KEY)) throw new Error("BOX_API_KEY is required")
  const templateName = env.WATERBOX_BOX_TEMPLATE_NAME ?? DEFAULT_TEMPLATE
  validateSnapshotName(templateName)
  const artifactPath = resolve(env.WATERBOX_DAEMON_ARTIFACT ?? "packages/sandbox-daemon/dist/waterbox-daemon")
  return {
    apiBaseUrl: cleanUrl(env.BOX_API_BASE_URL ?? DEFAULT_BASE_URL),
    apiKey: run ? env.BOX_API_KEY! : "",
    templateName,
    artifactPath,
    metadataPath: resolve(env.WATERBOX_TEMPLATE_METADATA ?? ".waterbox/box-system-template.json"),
    daemonPort: positiveInteger(env.WATERBOX_DAEMON_PORT ?? "8080", "WATERBOX_DAEMON_PORT", 65_535),
    pollIntervalMs: positiveInteger(env.BOX_TEMPLATE_POLL_INTERVAL_MS ?? "1000", "BOX_TEMPLATE_POLL_INTERVAL_MS"),
    pollTimeoutMs: positiveInteger(env.BOX_TEMPLATE_POLL_TIMEOUT_MS ?? "600000", "BOX_TEMPLATE_POLL_TIMEOUT_MS"),
    requestTimeoutMs: positiveInteger(env.BOX_TEMPLATE_REQUEST_TIMEOUT_MS ?? "30000", "BOX_TEMPLATE_REQUEST_TIMEOUT_MS"),
    replace: argv.includes("--replace"),
  }
}

export function createTemplateRequest(runId: string): { body: { noEnv: true; env: { WATERBOX_SANDBOX_ID: string }; ttlSeconds: number }; idempotencyKey: string } {
  const safe = runId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20)
  if (safe.length < 8) throw new Error("Template build identifier is invalid")
  const tag = `waterbox-template-${safe}`
  return { body: { noEnv: true, env: { WATERBOX_SANDBOX_ID: tag }, ttlSeconds: 1800 }, idempotencyKey: tag }
}

export function installCommand(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid daemon port")
  const unit = `[Unit]\nDescription=Waterbox sandbox daemon\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=root\nEnvironment=WORKSPACE_ROOT=/workspace\nEnvironment=PORT=${port}\nExecStart=/usr/local/bin/waterbox-daemon\nRestart=always\nRestartSec=2\nNoNewPrivileges=true\n\n[Install]\nWantedBy=multi-user.target\n`
  return [
    "set -eu",
    "install -d -m 0755 /workspace",
    "install -m 0755 /tmp/waterbox-daemon /usr/local/bin/waterbox-daemon",
    "if ! command -v rg >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ripgrep curl && rm -rf /var/lib/apt/lists/*; fi",
    `printf '%s' '${unit.replaceAll("'", "'\\''")}' > /etc/systemd/system/waterbox-daemon.service`,
    "chmod 0644 /etc/systemd/system/waterbox-daemon.service",
    "systemctl daemon-reload",
    "systemctl enable --now waterbox-daemon.service",
    `for attempt in $(seq 1 30); do curl -fsS http://127.0.0.1:${port}/health >/dev/null && exit 0; sleep 1; done`,
    "systemctl --no-pager status waterbox-daemon.service >&2 || true",
    "exit 1",
  ].join("\n")
}

export function parseMetadata(text: string): TemplateMetadata {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error("Template metadata is not valid JSON") }
  if (!object(value) || value.schemaVersion !== 1 || value.provider !== "box" || !plain(value.templateRef) || !validSnapshotName(value.templateRef) || !Number.isInteger(value.daemonPort) || Number(value.daemonPort) < 1 || Number(value.daemonPort) > 65_535 || !plain(value.builtAt) || Number.isNaN(Date.parse(value.builtAt))) throw new Error("Template metadata is invalid")
  return value as unknown as TemplateMetadata
}

export function validateDaemonArtifact(artifact: Uint8Array): void {
  if (artifact.byteLength < 64 || artifact[0] !== 0x7f || artifact[1] !== 0x45 || artifact[2] !== 0x4c || artifact[3] !== 0x46) throw new Error("Daemon artifact must be a Linux ELF executable")
  if (artifact[4] !== 2 || artifact[5] !== 1 || artifact[18] !== 0x3e || artifact[19] !== 0) throw new Error("Daemon artifact must target Linux x86-64")
}

export async function runTemplateBuild(config: TemplateConfig, dependencies: TemplateDependencies): Promise<TemplateMetadata> {
  const artifact = await dependencies.readArtifact(config.artifactPath)
  validateDaemonArtifact(artifact)
  const request = createTemplateRequest(dependencies.randomId())
  const client = new BoxTemplateClient(config, dependencies)
  let boxId: string | undefined
  let snapshotMutationAmbiguous = false
  try {
    const existing = await client.getSnapshotIfPresent(config.templateName)
    if (existing !== undefined && !config.replace) throw new Error("Template already exists; pass --replace to update it")
    if (existing === "saving") throw new Error("Template snapshot save is already in progress")
    dependencies.log({ stage: "source-create", status: "requesting" })
    const created = await createBoxWithRecovery(client, request.body, request.idempotencyKey)
    boxId = created.id
    dependencies.log({ stage: "source-create", status: "accepted" })
    await client.waitForBox(boxId, READY_STATES, "source-readiness")
    await client.uploadArtifact(boxId, artifact)
    dependencies.log({ stage: "daemon-upload", status: "completed", bytes: artifact.byteLength })
    parseCommand(await client.json("POST", `/boxes/${segment(boxId)}/commands`, { body: { command: installCommand(config.daemonPort), timeoutSeconds: 600 } }))
    parseCommand(await client.json("POST", `/boxes/${segment(boxId)}/commands`, { body: { command: `curl -fsS http://127.0.0.1:${config.daemonPort}/health`, timeoutSeconds: 30 } }))
    dependencies.log({ stage: "daemon-health", status: "verified" })
    parseAction(await client.json("POST", `/boxes/${segment(boxId)}/stop`), boxId, "box.stopping")
    await client.waitForBox(boxId, new Set(["archived"]), "source-stop")
    dependencies.log({ stage: "snapshot-save", status: "requesting", replacing: existing !== undefined })
    snapshotMutationAmbiguous = true
    parseSnapshot(await client.json("POST", "/named-snapshots", { body: { boxId, name: config.templateName } }), "snapshot.named.saving", config.templateName, boxId)
    snapshotMutationAmbiguous = false
    await client.waitForSnapshot(config.templateName, boxId)
    const metadata: TemplateMetadata = { schemaVersion: 1, provider: "box", templateRef: config.templateName, daemonPort: config.daemonPort, builtAt: new Date().toISOString() }
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
    const value = await this.json("PUT", `/boxes/${segment(boxId)}/files`, { body: { path: "/tmp/waterbox-daemon", content: Buffer.from(artifact).toString("base64"), encoding: "base64" } })
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
export function parseCommand(value: unknown): void { if (!object(value) || value.ok !== true || value.type !== "command.finished" || value.success !== true || value.exitCode !== 0 || typeof value.stdout !== "string" || typeof value.stderr !== "string" || value.timedOut !== false) throw new Error("Box command failed") }
export function parseArtifactUpload(value: unknown, expectedSize: number): void { if (!object(value) || value.ok !== true || value.type !== "file.written" || value.success !== true || value.path !== "/tmp/waterbox-daemon" || value.encoding !== "base64" || !Number.isSafeInteger(value.size) || value.size !== expectedSize) throw new Error("Box returned an invalid artifact upload response") }
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
  validateDaemonArtifact(artifact)
  if (process.argv.includes("--validate")) { console.log(JSON.stringify({ valid: true, artifactBytes: artifact.byteLength, templateRef: config.templateName, daemonPort: config.daemonPort })); return }
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
