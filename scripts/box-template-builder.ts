import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"

export const METADATA_VERSION = 1 as const
export const DEFAULT_METADATA_PATH = resolve(import.meta.dir, "../.waterbox/box-system-template.json")
export const DEFAULT_ARTIFACT_PATH = resolve(import.meta.dir, "../packages/sandbox-daemon/dist/waterbox-daemon")
const MAX_RESPONSE_BYTES = 1_048_576
const BOX_STATES = ["init", "provisioning", "provisioned", "cloning", "ready", "idle", "running", "archiving", "archived", "error"] as const
const SNAPSHOT_STATES = ["saving", "ready", "failed"] as const
const JOURNAL_STAGES = ["pre_create", "box_acquired", "installing", "stopped", "snapshot_saving"] as const
const JOURNAL_MAX_AGE_MS = 23 * 60 * 60 * 1000
const JOURNAL_FUTURE_SKEW_MS = 5 * 60 * 1000
type BoxState = typeof BOX_STATES[number]
type SnapshotState = typeof SNAPSHOT_STATES[number]
type JournalStage = typeof JOURNAL_STAGES[number]
interface OperationJournal { version: 1; buildFingerprint: string; idempotencyKey: string; createBodyDigest: string; stage: JournalStage; updatedAt: string; boxId?: string; snapshotName?: string; priorSnapshotArtifactId?: string; snapshotSourceBoxId?: string }

export interface TemplateMetadata { version: 1; provider: "box"; templateRef: string; templateName: string; buildFingerprint: string; artifactSha256: string; snapshotArtifactId: string; daemonPort: number; builtAt: string }
export interface BuilderConfig { apiBaseUrl: string; apiKey: string; templateName: string; daemonPort: number; metadataPath: string; artifactPath: string; dryRun: boolean; pollIntervalMs: number; pollTimeoutMs: number; requestTimeoutMs: number }
export interface HttpRequestSpec { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; headers?: Readonly<Record<string, string>>; json?: unknown; bytes?: Uint8Array; expectedStatuses?: readonly number[]; timeoutMs?: number }
export interface OwnedBox { id: string; state: BoxState; ownership: "created" | "reused" }
export interface OwnedSnapshot { name: string; state: SnapshotState; snapshotArtifactId?: string; sourceBoxId?: string; ownership: "created" | "reused" }
export interface BoxTemplateTransport {
  createSource(input: { idempotencyKey: string; ownership: "created" | "reused"; signal: AbortSignal }): Promise<OwnedBox>
  inspectSource(id: string, signal: AbortSignal): Promise<{ id: string; state: BoxState }>
  resumeSource(id: string, signal: AbortSignal): Promise<void>
  upload(id: string, path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>
  command(id: string, command: string, signal: AbortSignal): Promise<void>
  stopSource(id: string, signal: AbortSignal): Promise<void>
  findSnapshot(name: string, signal: AbortSignal): Promise<OwnedSnapshot | undefined>
  createSnapshot(input: { sourceId: string; name: string; signal: AbortSignal }): Promise<OwnedSnapshot>
  inspectSnapshot(name: string, signal: AbortSignal, sourceId?: string): Promise<{ name: string; state: SnapshotState; snapshotArtifactId?: string; sourceBoxId?: string }>
  deleteSnapshot(name: string, signal: AbortSignal): Promise<void>
  deleteSource(id: string, signal: AbortSignal): Promise<void>
}
export interface BuilderDependencies { fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>; sleep(milliseconds: number, signal: AbortSignal): Promise<void>; now(): Date; log(message: string): void; buildArtifact(artifactPath: string): Promise<void>; readArtifact(artifactPath: string): Promise<Uint8Array>; readMetadata(path: string): Promise<TemplateMetadata | undefined>; writeMetadata(path: string, metadata: TemplateMetadata): Promise<void>; transport?: BoxTemplateTransport }

export function loadBuilderConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): BuilderConfig {
  const dryRun = argv.includes("--dry-run") || argv.includes("--validate")
  const config = { apiBaseUrl: cleanUrl(env.BOX_API_BASE_URL ?? "https://ascii.dev/api/box/v1"), apiKey: required(env.BOX_API_KEY ?? (dryRun ? "dry-run-placeholder" : ""), "BOX_API_KEY"), templateName: required(env.BOX_SYSTEM_TEMPLATE_NAME ?? "waterbox-system-v1", "BOX_SYSTEM_TEMPLATE_NAME"), daemonPort: integer(env.WATERBOX_DAEMON_PORT ?? "8080", "WATERBOX_DAEMON_PORT", 65_535), metadataPath: resolve(env.WATERBOX_TEMPLATE_METADATA ?? DEFAULT_METADATA_PATH), artifactPath: resolve(env.WATERBOX_DAEMON_ARTIFACT ?? DEFAULT_ARTIFACT_PATH), dryRun, pollIntervalMs: integer(env.BOX_TEMPLATE_POLL_INTERVAL_MS ?? "2000", "BOX_TEMPLATE_POLL_INTERVAL_MS"), pollTimeoutMs: integer(env.BOX_TEMPLATE_POLL_TIMEOUT_MS ?? "1200000", "BOX_TEMPLATE_POLL_TIMEOUT_MS"), requestTimeoutMs: integer(env.BOX_TEMPLATE_REQUEST_TIMEOUT_MS ?? "30000", "BOX_TEMPLATE_REQUEST_TIMEOUT_MS") }
  if (config.pollTimeoutMs < config.pollIntervalMs) throw new Error("BOX_TEMPLATE_POLL_TIMEOUT_MS must be at least BOX_TEMPLATE_POLL_INTERVAL_MS")
  if (config.pollTimeoutMs < 1_200_000) throw new Error("BOX_TEMPLATE_POLL_TIMEOUT_MS must be at least 1200000 to cover installation and snapshot follow-up")
  return config
}
export function systemdUnit(port: number): string { return `[Unit]\nDescription=Waterbox sandbox daemon\nAfter=network.target\n\n[Service]\nType=simple\nEnvironment=WORKSPACE_ROOT=/workspace\nEnvironment=PORT=${port}\nExecStart=/usr/local/bin/waterbox-daemon\nRestart=always\nRestartSec=1\nNoNewPrivileges=true\n\n[Install]\nWantedBy=multi-user.target\n` }
export function installCommand(): string { return "set -eu; if command -v apt-get >/dev/null; then sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ripgrep curl; elif command -v dnf >/dev/null; then sudo dnf install -y ripgrep curl; elif command -v yum >/dev/null; then sudo yum install -y ripgrep curl; else exit 1; fi; sudo install -d -m 0755 /workspace; sudo install -m 0755 /tmp/waterbox-daemon /usr/local/bin/waterbox-daemon; sudo install -m 0644 /home/user/waterbox-daemon.service /etc/systemd/system/waterbox-daemon.service; sudo systemctl daemon-reload; sudo systemctl enable --now waterbox-daemon.service" }
export function healthCommand(port: number): string { return `set -eu; systemctl is-enabled --quiet waterbox-daemon.service; systemctl is-active --quiet waterbox-daemon.service; curl --fail --silent --show-error http://127.0.0.1:${port}/health >/dev/null` }
export function buildFingerprint(config: BuilderConfig, artifact: Uint8Array): string { return sha256(new TextEncoder().encode(JSON.stringify({ schema: METADATA_VERSION, artifact: sha256(artifact), templateName: config.templateName, daemonPort: config.daemonPort, unit: systemdUnit(config.daemonPort), install: installCommand(), health: healthCommand(config.daemonPort), dependencies: ["ripgrep", "curl"] }))) }
export function snapshotBuildName(templateName: string): string { if (!validNamedSnapshot(templateName)) throw new Error("BOX_SYSTEM_TEMPLATE_NAME must be a safe non-reserved named snapshot name"); return templateName }
export function createBuildRequests(config: BuilderConfig, artifact: Uint8Array): readonly HttpRequestSpec[] { const fingerprint = buildFingerprint(config, artifact); const name = snapshotBuildName(config.templateName); return [{ method: "POST", path: "/boxes", headers: { "idempotency-key": `waterbox-template-${fingerprint}` }, json: { noEnv: true, env: { WATERBOX_BUILD_FINGERPRINT: fingerprint } } }, { method: "PUT", path: "/boxes/{boxId}/files", json: { path: "/tmp/waterbox-daemon", content: "<base64>", encoding: "base64" } }, { method: "PUT", path: "/boxes/{boxId}/files", json: { path: "/home/user/waterbox-daemon.service", content: "<base64>", encoding: "base64" } }, { method: "POST", path: "/boxes/{boxId}/commands", json: { command: installCommand(), timeoutSeconds: 540 } }, { method: "POST", path: "/boxes/{boxId}/commands", json: { command: healthCommand(config.daemonPort), timeoutSeconds: 30 } }, { method: "POST", path: "/boxes/{boxId}/stop" }, { method: "POST", path: "/named-snapshots", json: { boxId: "{boxId}", name } }] }
export function parseTemplateMetadata(value: unknown): TemplateMetadata { if (!object(value) || !["version", "provider", "templateRef", "templateName", "buildFingerprint", "artifactSha256", "snapshotArtifactId", "daemonPort", "builtAt"].every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !["version", "provider", "templateRef", "templateName", "buildFingerprint", "artifactSha256", "snapshotArtifactId", "daemonPort", "builtAt"].includes(key)) || value.version !== 1 || value.provider !== "box" || !plain(value.templateRef) || !plain(value.templateName) || !digest(value.buildFingerprint) || !digest(value.artifactSha256) || !plain(value.snapshotArtifactId) || !Number.isInteger(value.daemonPort) || Number(value.daemonPort) < 1 || Number(value.daemonPort) > 65_535 || !canonicalTimestamp(value.builtAt)) throw new Error("Template metadata is invalid"); return value as unknown as TemplateMetadata }
export function redactSecrets(value: unknown, secrets: readonly string[]): string { let text = value instanceof Error ? value.message : String(value); for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED]"); return text.replace(/https?:\/\/[^\s"']+/gi, (url) => /(?:token|signature|secret|key|protected)/i.test(url) ? "[REDACTED_URL]" : url) }

export async function buildBoxTemplate(config: BuilderConfig, overrides: Partial<BuilderDependencies> = {}, signal: AbortSignal = new AbortController().signal): Promise<TemplateMetadata | undefined> {
  const d: BuilderDependencies = { fetch, sleep: abortableSleep, now: () => new Date(), log: console.log, buildArtifact: defaultBuildArtifact, readArtifact: async path => new Uint8Array(await readFile(path)), readMetadata: readMetadataFile, writeMetadata: atomicMetadataWrite, ...overrides }
  signal.throwIfAborted(); await d.buildArtifact(config.artifactPath); signal.throwIfAborted(); const artifact = await d.readArtifact(config.artifactPath); if (!artifact.byteLength) throw new Error("Daemon artifact is empty")
  const fingerprint = buildFingerprint(config, artifact); const existing = await d.readMetadata(config.metadataPath)
  if (existing?.buildFingerprint === fingerprint) { d.log(`System template already current: ${existing.templateRef}`); return existing }
  const requests = createBuildRequests(config, artifact); if (config.dryRun) { requests.forEach(r => d.log(`${r.method} ${r.path}`)); d.log(`Validated ${basename(config.artifactPath)} (${fingerprint}); no Box requests were sent.`); return undefined }
  const transport = d.transport ?? new HttpBoxTemplateTransport(config, d.fetch); let box: OwnedBox | undefined; let snapshot: OwnedSnapshot | undefined; let restoreReusedStop = false; let success = false; let retainJournal = false
  const journalPath = `${config.metadataPath}.operation`; const createKey = `waterbox-template-${fingerprint}`; const createBodyDigest = sha256(new TextEncoder().encode(JSON.stringify({ noEnv: true, env: { WATERBOX_BUILD_FINGERPRINT: fingerprint } })))
  const journalLock = await acquireJournalLock(journalPath)
  try {
    const total = AbortSignal.any([signal, AbortSignal.timeout(config.pollTimeoutMs)])
    let journal = await readOperationJournal(journalPath, validNow(d))
    if (journal && (journal.buildFingerprint !== fingerprint || journal.idempotencyKey !== createKey || journal.createBodyDigest !== createBodyDigest)) throw new Error("Existing Box build operation journal does not match this build; refusing unsafe recovery")
    if (!journal) { journal = { version: 1, buildFingerprint: fingerprint, idempotencyKey: createKey, createBodyDigest, stage: "pre_create", updatedAt: validNow(d).toISOString() }; await writeOperationJournal(journalPath, journal) }
    if (journal.stage === "pre_create") { box = await transport.createSource({ idempotencyKey: createKey, ownership: "created", signal: total }); journal = await advanceOperationJournal(journalPath, journal, { ...journal, stage: "box_acquired", boxId: box.id, updatedAt: validNow(d).toISOString() }) }
    else { const observed = await transport.inspectSource(journal.boxId!, total); box = { ...observed, ownership: "created" } }
    restoreReusedStop = box.ownership === "reused" && box.state === "archived"
    if (["box_acquired", "installing"].includes(journal.stage)) {
      if (box.state === "archived") await transport.resumeSource(box.id, total)
      await waitForBox(transport, box.id, config, d, total)
      if (journal.stage === "box_acquired") journal = await advanceOperationJournal(journalPath, journal, { ...journal, stage: "installing", updatedAt: validNow(d).toISOString() })
      total.throwIfAborted(); await transport.upload(box.id, "/tmp/waterbox-daemon", artifact, total)
      await transport.upload(box.id, "/home/user/waterbox-daemon.service", new TextEncoder().encode(systemdUnit(config.daemonPort)), total)
      await transport.command(box.id, installCommand(), total); await transport.command(box.id, healthCommand(config.daemonPort), total)
      await transport.stopSource(box.id, total); await waitForStopped(transport, box.id, config, d, total)
      journal = await advanceOperationJournal(journalPath, journal, { ...journal, stage: "stopped", updatedAt: validNow(d).toISOString() })
    } else { await waitForStopped(transport, box.id, config, d, total) }
    const snapshotName = snapshotBuildName(config.templateName)
    let priorSnapshotArtifactId = journal.priorSnapshotArtifactId
    if (journal.stage === "stopped") {
      snapshot = await transport.findSnapshot(snapshotName, total); if (snapshot?.state === "saving") snapshot = { ...(await waitForSnapshot(transport, snapshotName, config, d, total)), ownership: snapshot.ownership }
      priorSnapshotArtifactId = snapshot?.snapshotArtifactId
      journal = await advanceOperationJournal(journalPath, journal, { ...journal, stage: "snapshot_saving", snapshotName, snapshotSourceBoxId: box.id, ...(priorSnapshotArtifactId ? { priorSnapshotArtifactId } : {}), updatedAt: validNow(d).toISOString() })
      snapshot = await transport.createSnapshot({ sourceId: box.id, name: snapshotName, signal: total })
    } else {
      snapshot = await transport.findSnapshot(snapshotName, total)
      if (!snapshot || snapshot.sourceBoxId !== box.id) throw new RecoveryRequiredError("Snapshot recovery requires operator review")
    }
    const ready = await waitForSnapshot(transport, snapshot.name, config, d, total, box.id)
    if (priorSnapshotArtifactId && ready.snapshotArtifactId === priorSnapshotArtifactId) throw new RecoveryRequiredError("System template snapshot did not replace the prior artifact")
    if (!ready.snapshotArtifactId) throw new Error("Ready system template snapshot omitted its artifact ID")
    const metadata = parseTemplateMetadata({ version: 1, provider: "box", templateRef: ready.name, templateName: config.templateName, buildFingerprint: fingerprint, artifactSha256: sha256(artifact), snapshotArtifactId: ready.snapshotArtifactId, daemonPort: config.daemonPort, builtAt: validNow(d).toISOString() })
    total.throwIfAborted(); await d.writeMetadata(config.metadataPath, metadata); total.throwIfAborted(); await unlink(journalPath).catch(() => {}); success = true; d.log(`Box system template metadata written to ${config.metadataPath}`); return metadata
  } catch (error) { retainJournal = error instanceof RecoveryRequiredError; if (retainJournal) d.log(`MANUAL RECOVERY REQUIRED: preserve ${journalPath}; inspect the recorded Box and snapshot evidence before any cleanup.`); throw new Error(`${redactSecrets(error, [config.apiKey])}${retainJournal ? `; manual recovery required and operation journal retained at ${journalPath}` : ""}`) }
  finally { if (!success && !retainJournal) { const cleaned = await cleanupOwned(transport, box, snapshot, restoreReusedStop, config, d); if (cleaned) await unlink(journalPath).catch(() => {}) } await journalLock.close().catch(() => {}); await unlink(`${journalPath}.lock`).catch(() => {}) }
}
async function cleanupOwned(t: BoxTemplateTransport, box: OwnedBox | undefined, snapshot: OwnedSnapshot | undefined, restoreReusedStop: boolean, c: BuilderConfig, d: BuilderDependencies): Promise<boolean> {
  let complete = box !== undefined
  if (snapshot?.ownership === "created") try { await boundedCleanup(c, signal => t.deleteSnapshot(snapshot.name, signal)) } catch (e) { complete = false; d.log(`WARNING: snapshot cleanup failed: ${redactSecrets(e, [c.apiKey])}`) }
  if (box?.ownership === "created") try { await boundedCleanup(c, signal => t.deleteSource(box.id, signal)) } catch (e) { complete = false; d.log(`WARNING: source cleanup failed: ${redactSecrets(e, [c.apiKey])}`) }
  else if (box && restoreReusedStop) try { await boundedCleanup(c, async signal => { await t.stopSource(box.id, signal); await waitForStopped(t, box.id, { ...c, pollTimeoutMs: c.requestTimeoutMs }, d, signal) }) } catch (e) { complete = false; d.log(`WARNING: reused source restoration failed: ${redactSecrets(e, [c.apiKey])}`) }
  return complete
}
async function boundedCleanup(c: BuilderConfig, operation: (signal: AbortSignal) => Promise<void>): Promise<void> { const signal = AbortSignal.timeout(c.requestTimeoutMs); await Promise.race([operation(signal), aborted(signal)]) }
async function waitForBox(t: BoxTemplateTransport, id: string, c: BuilderConfig, d: BuilderDependencies, s: AbortSignal): Promise<void> { await poll(c, d, s, async () => { const v = await t.inspectSource(id, s); correlate(v.id, id); if (v.state === "error") throw new Error("Temporary Box failed"); return ["ready", "idle"].includes(v.state) }) }
async function waitForStopped(t: BoxTemplateTransport, id: string, c: BuilderConfig, d: BuilderDependencies, s: AbortSignal): Promise<void> { await poll(c, d, s, async () => { const v = await t.inspectSource(id, s); correlate(v.id, id); if (v.state === "error") throw new Error("Temporary Box failed while stopping"); return v.state === "archived" }) }
async function waitForSnapshot(t: BoxTemplateTransport, name: string, c: BuilderConfig, d: BuilderDependencies, s: AbortSignal, sourceId?: string): Promise<{ name: string; state: SnapshotState; snapshotArtifactId?: string; sourceBoxId?: string }> { let result!: { name: string; state: SnapshotState; snapshotArtifactId?: string; sourceBoxId?: string }; await poll(c, d, s, async () => { try { result = await t.inspectSnapshot(name, s, sourceId) } catch (error) { if (error instanceof SnapshotCorrelationError) throw new RecoveryRequiredError(error.message); throw error } if (result.name !== name || (sourceId && result.sourceBoxId !== sourceId)) throw new RecoveryRequiredError("System template snapshot correlation mismatch"); if (result.state === "failed") throw new Error("System template snapshot failed"); return result.state === "ready" }); return result }
async function poll(c: BuilderConfig, d: BuilderDependencies, s: AbortSignal, inspect: () => Promise<boolean>): Promise<void> { const deadline = validNow(d).getTime() + c.pollTimeoutMs; while (!(await inspect())) { s.throwIfAborted(); if (validNow(d).getTime() >= deadline) throw new Error("Box template operation timed out"); await d.sleep(c.pollIntervalMs, s) } }

export class HttpBoxTemplateTransport implements BoxTemplateTransport {
  constructor(private readonly c: BuilderConfig, private readonly fetcher: BuilderDependencies["fetch"]) {}
  createSource = async (v: { idempotencyKey: string; ownership: "created" | "reused"; signal: AbortSignal }): Promise<OwnedBox> => {
    const fingerprint = v.idempotencyKey.replace(/^waterbox-template-/, "")
    if (!digest(fingerprint)) throw new Error("Builder idempotency key is invalid")
    const spec = { method: "POST", path: "/boxes", headers: { "idempotency-key": v.idempotencyKey }, json: { noEnv: true, env: { WATERBOX_BUILD_FINGERPRINT: fingerprint } }, expectedStatuses: [202] } as const
    try { return { ...(await this.parsed(spec, v.signal, strictCreatedBox)).value, ownership: v.ownership } }
    catch (error) {
      if (v.signal.aborted || !isAmbiguousTransport(error)) throw error
      return { ...(await this.parsed(spec, v.signal, strictCreatedBox)).value, ownership: v.ownership }
    }
  }
  inspectSource = async (id: string, s: AbortSignal) => (await this.parsed({ method: "GET", path: `/boxes/${segment(id)}`, expectedStatuses: [200] }, s, value => strictInfoBox(value, id))).value
  resumeSource = async (id: string, s: AbortSignal) => { await this.parsed({ method: "POST", path: `/boxes/${segment(id)}/resume`, expectedStatuses: [202] }, s, value => strictActionBox(value, id, "box.resuming")) }
  upload = async (id: string, path: string, bytes: Uint8Array, s: AbortSignal) => { await this.parsed({ method: "PUT", path: `/boxes/${segment(id)}/files`, json: { path, content: Buffer.from(bytes).toString("base64"), encoding: "base64" }, expectedStatuses: [200] }, s, value => strictFileWritten(value, path)) }
  command = async (id: string, command: string, s: AbortSignal) => { const timeoutSeconds = command === installCommand() ? 540 : 30; await this.parsed({ method: "POST", path: `/boxes/${segment(id)}/commands`, json: { command, timeoutSeconds }, expectedStatuses: [200], timeoutMs: (timeoutSeconds + 10) * 1000 }, s, strictCommand) }
  stopSource = async (id: string, s: AbortSignal) => { await this.parsed({ method: "POST", path: `/boxes/${segment(id)}/stop`, expectedStatuses: [202] }, s, value => strictActionBox(value, id, "box.stopping")) }
  findSnapshot = async (name: string, s: AbortSignal): Promise<OwnedSnapshot | undefined> => { try { return { ...(await this.parsed({ method: "GET", path: `/named-snapshots/${segment(name)}`, expectedStatuses: [200] }, s, value => strictNamedSnapshot(value, name))).value, ownership: "reused" } } catch (error) { if (error instanceof NotFoundError) return undefined; throw error } }
  createSnapshot = async (v: { sourceId: string; name: string; signal: AbortSignal }): Promise<OwnedSnapshot> => {
    const prior = await this.findSnapshot(v.name, v.signal); const spec = { method: "POST", path: "/named-snapshots", json: { boxId: v.sourceId, name: v.name }, expectedStatuses: [202] } as const
    try { return { ...(await this.parsed(spec, v.signal, value => strictNamedSnapshot(value, v.name, v.sourceId))).value, ownership: prior ? "reused" : "created" } }
    catch (error) {
      if (v.signal.aborted || !isAmbiguousTransport(error)) throw error
      let current: OwnedSnapshot | undefined
      try { current = await this.findSnapshot(v.name, v.signal) } catch (lookupError) { if (lookupError instanceof SnapshotCorrelationError) throw new RecoveryRequiredError(lookupError.message); throw lookupError }
      if (!current || current.sourceBoxId !== v.sourceId || (current.state === "ready" && prior?.state === "ready" && current.snapshotArtifactId === prior.snapshotArtifactId)) throw new RecoveryRequiredError("Named snapshot save outcome is ambiguous")
      return { ...current, ownership: prior ? "reused" : "created" }
    }
  }
  inspectSnapshot = async (name: string, s: AbortSignal, sourceId?: string) => (await this.parsed({ method: "GET", path: `/named-snapshots/${segment(name)}`, expectedStatuses: [200] }, s, value => strictNamedSnapshot(value, name, sourceId))).value
  deleteSnapshot = async (name: string, s: AbortSignal) => { await this.parsed({ method: "DELETE", path: `/named-snapshots/${segment(name)}`, expectedStatuses: [200] }, s, value => strictNamedDeleted(value, name)) }
  deleteSource = async (id: string, s: AbortSignal) => { const op = (await this.parsed({ method: "DELETE", path: `/boxes/${segment(id)}`, headers: { "x-ascii-confirm-delete": id }, expectedStatuses: [202] }, s, value => strictDeletion(value, id))).value; while ((await this.parsed({ method: "GET", path: `/deletion-operations/${segment(op.id)}`, expectedStatuses: [200] }, s, value => strictDeletion(value, id, op.id))).value.status !== "completed") await abortableSleep(this.c.pollIntervalMs, s) }
  private async parsed<T>(spec: HttpRequestSpec, signal: AbortSignal, parse: (value: unknown) => T): Promise<{ status: number; value: T }> { return this.ownRequest(spec, signal, async (response, ownedSignal) => ({ status: response.status, value: parse(await boundedJson(response, ownedSignal)) })) }
  private async request(spec: HttpRequestSpec, signal: AbortSignal): Promise<Response> { return this.ownRequest(spec, signal, async response => response) }
  private async ownRequest<T>(spec: HttpRequestSpec, caller: AbortSignal, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    const owned = new AbortController()
    const timeout = setTimeout(() => owned.abort(new DOMException("Box request timed out", "TimeoutError")), spec.timeoutMs ?? this.c.requestTimeoutMs)
    const callerAbort = () => owned.abort(caller.reason ?? new DOMException("Aborted", "AbortError"))
    caller.addEventListener("abort", callerAbort, { once: true })
    try {
      caller.throwIfAborted()
      const headers: Record<string, string> = { authorization: `Bearer ${this.c.apiKey}`, accept: "application/json", ...spec.headers }; let body: BodyInit | undefined
      if (spec.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(spec.json) } else if (spec.bytes) { headers["content-type"] = "application/octet-stream"; body = spec.bytes as Uint8Array<ArrayBuffer> }
      const response = await this.fetcher(`${this.c.apiBaseUrl}${spec.path}`, { method: spec.method, headers, body, signal: owned.signal })
      if (!response.ok) { cancel(response.body); if (response.status === 404) throw new NotFoundError(); throw new HttpStatusError(response.status) }
      if (spec.expectedStatuses && !spec.expectedStatuses.includes(response.status)) { cancel(response.body); throw new Error("Box returned an unexpected HTTP status") }
      return await consume(response, owned.signal)
    } catch (error) {
      if (caller.aborted) throw caller.reason ?? error
      if (owned.signal.aborted) throw owned.signal.reason ?? error
      throw error
    } finally { clearTimeout(timeout); caller.removeEventListener("abort", callerAbort) }
  }
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const body = response.body
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") { cancelDetached(body); throw new Error("Box returned invalid JSON media type") }
  const header = response.headers.get("content-length")
  let declared: number | undefined
  if (header !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(header) || !Number.isSafeInteger(Number(header))) { cancelDetached(body); throw new Error("Box returned invalid Content-Length") }
    declared = Number(header)
    if (declared > MAX_RESPONSE_BYTES) { cancelDetached(body); throw new Error("Box response is too large") }
  }
  if (!body) throw new Error("Box returned an empty response")
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let total = 0; let succeeded = false
  try {
    while (true) { signal.throwIfAborted(); const item = await readAbortable(reader, signal); if (item.done) break; total += item.value.byteLength; if (total > MAX_RESPONSE_BYTES) throw new Error("Box response is too large"); chunks.push(item.value) }
    if (declared !== undefined && total !== declared) throw new Error("Box response Content-Length mismatch")
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    let value: unknown
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { throw new Error("Box returned invalid JSON") }
    succeeded = true; return value
  } finally { if (succeeded) reader.releaseLock(); else cancelReaderDetached(reader) }
}
class NotFoundError extends Error {}
class HttpStatusError extends Error { constructor(readonly status: number) { super(`Box request failed (${status})`) } }
class RecoveryRequiredError extends Error {}
class SnapshotCorrelationError extends Error {}
const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/
const DELETION_ID = /^bdop_[a-f0-9]{32}$/
function object(v: unknown): v is Record<string, any> { return typeof v === "object" && v !== null && !Array.isArray(v) }
function strictBox(v: unknown): { id: string; state: BoxState; env?: Record<string, string> } { if (!object(v) || !BOX_ID.test(v.id) || typeof v.state !== "string" || !BOX_STATES.includes(v.state as BoxState) || (v.env !== undefined && (!object(v.env) || Object.values(v.env).some(value => typeof value !== "string")))) throw new Error("Box returned an invalid response"); return { id: v.id, state: v.state as BoxState, ...(v.env === undefined ? {} : { env: v.env }) } }
function strictCreatedBox(v: unknown) { if (!object(v) || v.ok !== true || v.type !== "box.created" || v.status !== "provisioning" || !(v.ttlSeconds === null || Number.isInteger(v.ttlSeconds))) throw new Error("Box returned an invalid create response"); return strictBox(v.box) }
function strictInfoBox(v: unknown, id: string) { if (!object(v) || v.ok !== true || v.type !== "box.info") throw new Error("Box returned an invalid info response"); const box = strictBox(v.box); correlate(box.id, id); return box }
function strictActionBox(v: unknown, id: string, type: string): void { if (!object(v) || v.ok !== true || v.type !== type || v.id !== id || v.status !== (type === "box.stopping" ? "archiving" : "resuming") || (v.box != null && strictBox(v.box).id !== id)) throw new Error("Box returned an invalid action response") }
function strictNamedSnapshot(v: unknown, name: string, sourceId?: string): { name: string; state: SnapshotState; snapshotArtifactId?: string; sourceBoxId: string } { if (!object(v) || v.ok !== true || !["snapshot.named.saving", "snapshot.named.info"].includes(v.type) || !object(v.snapshot) || !SNAPSHOT_STATES.includes(v.snapshot.status) || !BOX_ID.test(v.snapshot.sourceBoxId) || !providerTimestamp(v.snapshot.createdAt) || (v.snapshot.snapshotId !== undefined && !plain(v.snapshot.snapshotId)) || (v.snapshot.status === "ready" && !plain(v.snapshot.snapshotId))) throw new Error("Box returned an invalid named snapshot response"); if (v.snapshot.name !== name || (sourceId !== undefined && v.snapshot.sourceBoxId !== sourceId)) throw new SnapshotCorrelationError("Box returned a mismatched named snapshot response"); return { name, state: v.snapshot.status, ...(v.snapshot.snapshotId ? { snapshotArtifactId: v.snapshot.snapshotId } : {}), sourceBoxId: v.snapshot.sourceBoxId } }
function strictNamedDeleted(v: unknown, name: string): void { if (!object(v) || v.ok !== true || v.type !== "snapshot.named.deleted" || v.name !== name || v.status !== "deleted") throw new Error("Box returned an invalid named snapshot deletion response") }
function strictFileWritten(v: unknown, path: string): void { if (!object(v) || v.ok !== true || v.type !== "file.written" || v.success !== true || v.path !== path || v.encoding !== "base64" || !Number.isSafeInteger(v.size)) throw new Error("Box returned an invalid file response") }
function strictCommand(v: unknown): void { if (!object(v) || v.ok !== true || v.type !== "command.finished" || v.success !== true || !Number.isSafeInteger(v.exitCode) || typeof v.stdout !== "string" || typeof v.stderr !== "string" || typeof v.timedOut !== "boolean" || v.exitCode !== 0 || v.timedOut) throw new Error("Box command failed") }
function strictDeletion(v: unknown, targetId: string, id?: string): { id: string; status: string } { if (!object(v) || v.ok !== true || !["box.deleting", "deletion.operation"].includes(v.type) || !object(v.operation) || !DELETION_ID.test(v.operation.id) || (id !== undefined && v.operation.id !== id) || v.operation.kind !== "box" || v.operation.targetId !== targetId || !["pending", "processing", "blocked", "completed"].includes(v.operation.status) || v.operation.status === "blocked") throw new Error("Box returned an invalid deletion response"); return { id: v.operation.id, status: v.operation.status } }

export async function atomicMetadataWrite(path: string, metadata: TemplateMetadata): Promise<void> { const directory = dirname(path); await mkdir(directory, { recursive: true }); const lockPath = `${path}.lock`; let lock: Awaited<ReturnType<typeof open>> | undefined; let temporary: string | undefined; try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600); try { const target = await lstat(path); if (target.isSymbolicLink() || !target.isFile()) throw new Error("Metadata target is unsafe") } catch (e: any) { if (e?.code !== "ENOENT") throw e } temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`; const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600); try { await file.writeFile(`${JSON.stringify(parseTemplateMetadata(metadata), null, 2)}\n`); await file.sync() } finally { await file.close() } await rename(temporary, path); temporary = undefined; try { const dir = await open(directory, constants.O_RDONLY); try { await dir.sync() } finally { await dir.close() } } catch {} } finally { if (temporary) await unlink(temporary).catch(() => {}); if (lock) { await lock.close().catch(() => {}); await unlink(lockPath).catch(() => {}) } } }
async function writeOperationJournal(path: string, value: unknown): Promise<void> { const directory = dirname(path); await mkdir(directory, { recursive: true }); const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`; const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600); try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() } finally { await file.close() } await rename(temporary, path); try { const dir = await open(directory, constants.O_RDONLY); try { await dir.sync() } finally { await dir.close() } } catch {} }
async function advanceOperationJournal(path: string, current: OperationJournal, next: OperationJournal): Promise<OperationJournal> { if (JOURNAL_STAGES.indexOf(next.stage) !== JOURNAL_STAGES.indexOf(current.stage) + 1 || next.buildFingerprint !== current.buildFingerprint || next.idempotencyKey !== current.idempotencyKey || next.createBodyDigest !== current.createBodyDigest) throw new Error("Box build operation journal transition is invalid"); await writeOperationJournal(path, next); return next }
async function acquireJournalLock(path: string) { await mkdir(dirname(path), { recursive: true }); return open(`${path}.lock`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600) }
async function readOperationJournal(path: string, now: Date): Promise<OperationJournal | undefined> { let raw: unknown; try { const stat = await lstat(path); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe journal"); raw = JSON.parse(await readFile(path, "utf8")) } catch (error: any) { if (error?.code === "ENOENT") return undefined; throw new Error("Box build operation journal is corrupt") } if (!object(raw) || raw.version !== 1 || !digest(raw.buildFingerprint) || raw.idempotencyKey !== `waterbox-template-${raw.buildFingerprint}` || !digest(raw.createBodyDigest) || !JOURNAL_STAGES.includes(raw.stage) || typeof raw.updatedAt !== "string") throw new Error("Box build operation journal is corrupt"); let updated: Date; try { updated = new Date(raw.updatedAt); if (updated.toISOString() !== raw.updatedAt) throw new Error() } catch { throw new Error("Box build operation journal is corrupt") } const age = now.getTime() - updated.getTime(); if (age > JOURNAL_MAX_AGE_MS || age < -JOURNAL_FUTURE_SKEW_MS) throw new Error("Box build operation journal is stale; manual recovery is required")
  const hasBox = raw.boxId !== undefined, hasSnapshot = raw.snapshotName !== undefined || raw.snapshotSourceBoxId !== undefined || raw.priorSnapshotArtifactId !== undefined
  if ((raw.stage === "pre_create" && (hasBox || hasSnapshot)) || (raw.stage !== "pre_create" && (!BOX_ID.test(raw.boxId) || (raw.stage !== "snapshot_saving" && hasSnapshot))) || (raw.stage === "snapshot_saving" && (!validNamedSnapshot(raw.snapshotName) || raw.snapshotSourceBoxId !== raw.boxId || (raw.priorSnapshotArtifactId !== undefined && !plain(raw.priorSnapshotArtifactId)))) || Object.keys(raw).some(key => !["version", "buildFingerprint", "idempotencyKey", "createBodyDigest", "stage", "updatedAt", "boxId", "snapshotName", "priorSnapshotArtifactId", "snapshotSourceBoxId"].includes(key))) throw new Error("Box build operation journal is corrupt")
  return raw as OperationJournal }
async function readMetadataFile(path: string): Promise<TemplateMetadata | undefined> { try { const stat = await lstat(path); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Metadata target is unsafe"); return parseTemplateMetadata(JSON.parse(await readFile(path, "utf8"))) } catch (e: any) { if (e?.code === "ENOENT") return undefined; throw e } }
async function defaultBuildArtifact(path: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); const r = spawnSync(process.execPath, ["build", resolve(import.meta.dir, "../packages/sandbox-daemon/src/main.ts"), "--compile", "--outfile", path], { stdio: "inherit" }); if (r.error) throw r.error; if (r.status !== 0) throw new Error(`Daemon build exited with status ${r.status}`) }
async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> { await Promise.race([Bun.sleep(ms), aborted(signal)]) }
async function readAbortable(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> { return new Promise((resolve, reject) => { const abort = () => { cleanup(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")) }; const cleanup = () => signal.removeEventListener("abort", abort); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) return abort(); reader.read().then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) }) }) }
function aborted(signal: AbortSignal): Promise<never> { return new Promise((_, reject) => { const fail = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")); signal.addEventListener("abort", fail, { once: true }); if (signal.aborted) fail() }) }
function validNow(d: BuilderDependencies): Date { const v = d.now(); if (!(v instanceof Date) || !Number.isFinite(v.getTime())) throw new Error("Builder clock is invalid"); return v }
function correlate(actual: string, expected: string): void { if (actual !== expected) throw new Error("Box returned a mismatched response") }
function exact(v: unknown, keys: readonly string[]): v is Record<string, any> { return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",") }
function plain(v: unknown): v is string { return typeof v === "string" && v.length > 0 && v === v.trim() }
function canonicalTimestamp(v: unknown): v is string { if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) return false; return new Date(v).toISOString() === v }
function providerTimestamp(v: unknown): v is string { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v)) }
function digest(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{64}$/.test(v) }
function validNamedSnapshot(v: unknown): v is string { return typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(v) && !["latest", "tree", "pull", "rm", "save", "current", "self", "new"].includes(v) }
function isAmbiguousTransport(error: unknown): boolean { return error instanceof TypeError || (error instanceof HttpStatusError && error.status >= 500) || (error instanceof DOMException && error.name === "TimeoutError") }
function sha256(v: Uint8Array): string { return createHash("sha256").update(v).digest("hex") }
function segment(v: string): string { return encodeURIComponent(v) }
function cancel(stream: ReadableStream<Uint8Array> | null): void { cancelDetached(stream) }
function cancelDetached(stream: ReadableStream<Uint8Array> | null): void { if (!stream) return; try { void Promise.resolve(stream.cancel()).catch(() => {}) } catch {} }
function cancelReaderDetached(reader: ReadableStreamDefaultReader<Uint8Array>): void { try { void Promise.resolve(reader.cancel()).catch(() => {}) } catch {} }
function noFollow(): number { return constants.O_NOFOLLOW ?? 0 }
function cleanUrl(v: string): string { try { const u = new URL(v); if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new Error(); return u.href.replace(/\/+$/, "") } catch { throw new Error("BOX_API_BASE_URL must be an HTTPS origin without credentials, query, or fragment") } }
function required(v: string | undefined, n: string): string { if (!plain(v)) throw new Error(`${n} is required`); return v }
function integer(v: string, n: string, max = Number.MAX_SAFE_INTEGER): number { const x = Number(v); if (!Number.isSafeInteger(x) || x < 1 || x > max) throw new Error(`${n} must be a positive integer`); return x }
export async function main(): Promise<void> { const controller = new AbortController(); const stop = () => controller.abort(new DOMException("Interrupted", "AbortError")); const nodeProcess = process as unknown as NodeJS.Process; nodeProcess.once("SIGINT", stop); nodeProcess.once("SIGTERM", stop); try { await buildBoxTemplate(loadBuilderConfig(process.env, process.argv.slice(2)), {}, controller.signal) } finally { (nodeProcess.removeListener as any)("SIGINT", stop); (nodeProcess.removeListener as any)("SIGTERM", stop) } }
if (import.meta.main) await main().catch(e => { console.error(redactSecrets(e, [process.env.BOX_API_KEY ?? ""])); process.exitCode = 1 })
