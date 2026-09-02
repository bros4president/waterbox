import { posix } from "node:path"

const AUTHORIZATION = "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES"
const DEFAULT_BASE_URL = "https://ascii.dev/api/box/v1"
const MARKER_PATH = "/home/user/workspace/waterbox-capability-probe-marker"
const MAX_RESPONSE_BYTES = 1_048_576
const BOX_STATES = ["init", "provisioning", "provisioned", "cloning", "ready", "idle", "running", "archiving", "archived", "error"] as const
const SNAPSHOT_STATES = ["saving", "ready", "failed"] as const
type BoxState = typeof BOX_STATES[number]
type SnapshotState = typeof SNAPSHOT_STATES[number]
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface ProbeConfig {
  apiBaseUrl: string
  apiKey: string
  pollIntervalMs: number
  pollTimeoutMs: number
  requestTimeoutMs: number
}

export interface ProbeDependencies {
  fetch: Fetcher
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>
  randomId(): string
  now?(): number
  log(observation: Readonly<Record<string, string | number | boolean>>): void
}
export interface ProbeReleaseReconciliationOptions {
  pollIntervalMs: number
  pollTimeoutMs: number
  sleep(milliseconds: number): Promise<void>
  now(): number
}
export interface ProbeReleaseReconciliation { visibleSetReleased: boolean; activeCountReleased: boolean; activeBoxes: number }

export function probeHelp(): string {
  return `Usage: BOX_API_KEY=... BOX_CAPABILITY_PROBE_AUTHORIZATION=${AUTHORIZATION} bun run scripts/box-capability-probe.ts --run`
}

export function loadProbeConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): ProbeConfig {
  if (!argv.includes("--run")) throw new Error(`Live Box capability probe requires --run. ${probeHelp()}`)
  if (env.BOX_CAPABILITY_PROBE_AUTHORIZATION !== AUTHORIZATION) throw new Error("Live Box capability probe is not environment-authorized")
  if (!plain(env.BOX_API_KEY)) throw new Error("BOX_API_KEY is required")
  return {
    apiBaseUrl: cleanUrl(env.BOX_API_BASE_URL ?? DEFAULT_BASE_URL),
    apiKey: env.BOX_API_KEY,
    pollIntervalMs: positiveInteger(env.BOX_PROBE_POLL_INTERVAL_MS ?? "1000", "BOX_PROBE_POLL_INTERVAL_MS"),
    pollTimeoutMs: positiveInteger(env.BOX_PROBE_POLL_TIMEOUT_MS ?? "120000", "BOX_PROBE_POLL_TIMEOUT_MS"),
    requestTimeoutMs: positiveInteger(env.BOX_PROBE_REQUEST_TIMEOUT_MS ?? "30000", "BOX_PROBE_REQUEST_TIMEOUT_MS"),
  }
}

export async function reconcileProbeBoxesReleased(ids: readonly string[], activeBaseline: number, readAccount: () => Promise<{ activeBoxes: number; visibleIds: readonly string[] }>, options: ProbeReleaseReconciliationOptions): Promise<ProbeReleaseReconciliation> {
  const deadline = options.now() + options.pollTimeoutMs
  while (true) {
    const account = await readAccount()
    const result = { visibleSetReleased: !ids.some(id => account.visibleIds.includes(id)), activeCountReleased: account.activeBoxes <= activeBaseline, activeBoxes: account.activeBoxes }
    if (result.visibleSetReleased && result.activeCountReleased) return result
    if (options.now() >= deadline) throw new Error(`Accepted Box deletion did not release probe resources: ${[!result.visibleSetReleased && "visible-set release", !result.activeCountReleased && "active-count release"].filter(Boolean).join(", ")} did not converge`)
    await options.sleep(options.pollIntervalMs)
  }
}

export async function runBoxCapabilityProbe(config: ProbeConfig, dependencies: ProbeDependencies): Promise<ReadonlyArray<Readonly<Record<string, string | number | boolean>>>> {
  const observations: Array<Readonly<Record<string, string | number | boolean>>> = []
  const observe = (value: Readonly<Record<string, string | number | boolean>>) => { observations.push(value); dependencies.log(value) }
  const runId = dependencies.randomId().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20)
  if (runId.length < 8) throw new Error("Probe random identifier is invalid")
  const marker = `waterbox-probe-${runId}`
  const snapshotName = `waterbox-probe-${runId}`
  const idempotencyKey = `waterbox-probe-${runId}`
  const createBody = { noEnv: true, ttlSeconds: 300 }
  const boxes: string[] = []
  let snapshotCleanupIntent = false
  const client = new ProbeClient(config, dependencies.fetch, dependencies.sleep, observe, dependencies.now ?? Date.now)

  try {
    const limits = limitsResponse(await client.json("GET", "/limits"))
    observe({ stage: "account-limits", canStart: limits.canStart, activeBoxes: limits.activeBoxes, maxActiveBoxes: limits.maxActiveBoxes })
    if (!limits.canStart || limits.maxActiveBoxes - limits.activeBoxes < 2) throw new Error("Box account does not have capacity for two probe Boxes")
    const retention = dataRetentionResponse(await client.json("GET", "/account/data-retention"))
    if (retention.enabled) throw new Error("Box account must have zero-data-retention disabled")
    observe({ stage: "data-retention", zeroDataRetention: false })

    observe({ stage: "source-create", status: "requesting" })
    const first = await createBoxWithRecovery(client, createBody, idempotencyKey)
    boxes.push(first.id)
    observe({ stage: "source-create", status: "accepted" })
    const replay = await createBoxWithRecovery(client, createBody, idempotencyKey)
    if (replay.id !== first.id) throw new Error("Box create replay returned a different identity")
    observe({ stage: "create-replay", sameIdentity: true })

    await client.waitForBox(first.id, ["ready", "idle"], "source-readiness")
    markerWriteResponse(await client.json("PUT", `/boxes/${segment(first.id)}/files`, { body: { path: MARKER_PATH, content: btoa(marker), encoding: "base64" } }), MARKER_PATH)
    observe({ stage: "marker-written", verified: true })

    snapshotCleanupIntent = true
    observe({ stage: "snapshot-save", status: "requesting" })
    const saving = snapshotResponse(await client.json("POST", "/named-snapshots", { body: { boxId: first.id, name: snapshotName } }), "snapshot.named.saving", snapshotName, first.id)
    if (saving.state !== "saving") throw new Error("Named snapshot did not enter saving")
    const readySnapshot = await client.waitForSnapshot(snapshotName, first.id)
    observe({ stage: "snapshot-ready", artifactObserved: plain(readySnapshot.artifactId) })

    const restoredBody = { from: snapshotName, noEnv: true, ttlSeconds: 300 }
    observe({ stage: "restored-create", status: "requesting" })
    const restored = await createBoxWithRecovery(client, restoredBody, `${idempotencyKey}-restore`)
    boxes.push(restored.id)
    observe({ stage: "restored-create", status: "accepted" })
    await client.waitForBox(restored.id, ["ready", "idle"], "restored-readiness")
    observe({ stage: "restored-marker", status: "verifying" })
    await verifyMarker(client, restored.id, marker)
    observe({ stage: "snapshot-restore", markerVerified: true })

    observe({ stage: "source-stop", status: "requesting" })
    actionResponse(await client.json("POST", `/boxes/${segment(first.id)}/stop`), first.id, "box.stopping")
    await client.waitForBox(first.id, ["archived"], "source-stop")
    observe({ stage: "source-resume", status: "requesting" })
    actionResponse(await client.json("POST", `/boxes/${segment(first.id)}/resume`), first.id, "box.resuming")
    const resumed = await client.waitForBox(first.id, ["ready", "idle"], "source-resume")
    if (resumed.id !== first.id) throw new Error("Resumed Box identity changed")
    await verifyMarker(client, first.id, marker)
    observe({ stage: "stop-resume", sameIdentity: true, markerVerified: true })

    const deletedBoxIds = [...boxes]
    const deletionStatuses: Array<"completed" | "accepted_pending"> = []
    for (const [index, id] of [...boxes].reverse().entries()) { deletionStatuses.push(await client.deleteBox(id, index === 0 ? "restored-delete" : "source-delete")); boxes.splice(boxes.indexOf(id), 1) }
    observe({ stage: "snapshot-delete", status: "requesting" })
    await client.deleteSnapshot(snapshotName)
    snapshotCleanupIntent = false
    observe({ stage: "snapshot-delete", status: "completed" })
    const release = await client.verifyBoxesReleased(deletedBoxIds, limits.activeBoxes)
    const boxDeletionStatus = deletionStatuses.every(status => status === "completed") ? "completed" : "accepted_pending"
    observe({ stage: "cleanup", boxesReleased: 2, boxDeletionStatus, visibleSetReleased: release.visibleSetReleased, activeCountReleased: release.activeCountReleased, snapshotDeleted: true })
    return observations
  } catch (error) {
    await bestEffortCleanup(client, boxes, snapshotCleanupIntent ? snapshotName : undefined)
    throw new Error(redact(error, [config.apiKey, ...boxes, snapshotName, marker]))
  }
}

class ProbeClient {
  constructor(private readonly config: ProbeConfig, private readonly fetcher: Fetcher, private readonly sleep: ProbeDependencies["sleep"], private readonly progress: ProbeDependencies["log"], private readonly now: () => number) {}

  async json(method: string, path: string, options: { body?: unknown; idempotencyKey?: string; confirmDelete?: string; signal?: AbortSignal } = {}): Promise<unknown> {
    const signal = options.signal ?? AbortSignal.timeout(this.config.requestTimeoutMs)
    const headers: Record<string, string> = { authorization: `Bearer ${this.config.apiKey}`, accept: "application/json" }
    if (options.body !== undefined) headers["content-type"] = "application/json"
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey
    if (options.confirmDelete) headers["x-ascii-confirm-delete"] = options.confirmDelete
    const response = await this.fetcher(`${this.config.apiBaseUrl}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal })
    if (!response.ok) { cancel(response.body); throw new ProbeHttpError(response.status) }
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") { cancel(response.body); throw new Error("Box returned non-JSON data") }
    return boundedJson(response, signal)
  }

  async waitForBox(id: string, terminal: readonly BoxState[], stage: string): Promise<{ id: string; state: BoxState }> {
    const deadline = this.now() + this.config.pollTimeoutMs
    let lastState: string | undefined
    let lastLogAt = 0
    while (true) {
      const box = infoBox(await this.json("GET", `/boxes/${segment(id)}`), id)
      ;({ lastState, lastLogAt } = this.#reportProgress(stage, box.state, lastState, lastLogAt))
      if (terminal.includes(box.state)) return box
      if (box.state === "error") throw new Error("Box entered error state")
      if (this.now() >= deadline) throw new Error("Box state polling timed out")
      await this.sleep(this.config.pollIntervalMs, AbortSignal.timeout(this.config.requestTimeoutMs))
    }
  }

  async waitForSnapshot(name: string, sourceId: string): Promise<{ state: SnapshotState; artifactId?: string }> {
    const deadline = this.now() + this.config.pollTimeoutMs
    let lastState: string | undefined
    let lastLogAt = 0
    while (true) {
      const snapshot = snapshotResponse(await this.json("GET", `/named-snapshots/${segment(name)}`), "snapshot.named.info", name, sourceId)
      ;({ lastState, lastLogAt } = this.#reportProgress("snapshot-save", snapshot.state, lastState, lastLogAt))
      if (snapshot.state === "ready") return snapshot
      if (snapshot.state === "failed") throw new Error("Named snapshot failed")
      if (this.now() >= deadline) throw new Error("Snapshot polling timed out")
      await this.sleep(this.config.pollIntervalMs, AbortSignal.timeout(this.config.requestTimeoutMs))
    }
  }

  async deleteBox(id: string, stage = "box-delete"): Promise<"completed" | "accepted_pending"> {
    const operation = deletionResponse(await this.json("DELETE", `/boxes/${segment(id)}`, { confirmDelete: id }), "box.deleting", id)
    const deadline = this.now() + this.config.pollTimeoutMs
    let lastState: string | undefined
    let lastLogAt = 0
    while (true) {
      const current = deletionResponse(await this.json("GET", `/deletion-operations/${segment(operation.id)}`), "deletion.operation", id, operation.id)
      ;({ lastState, lastLogAt } = this.#reportProgress(stage, current.status, lastState, lastLogAt))
      if (current.status === "completed") return "completed"
      if (current.status === "blocked") return "accepted_pending"
      if (this.now() >= deadline) throw new Error("Box deletion polling timed out")
      await this.sleep(this.config.pollIntervalMs, AbortSignal.timeout(this.config.requestTimeoutMs))
    }
  }

  async deleteSnapshot(name: string): Promise<void> {
    const value = await this.json("DELETE", `/named-snapshots/${segment(name)}`)
    if (!object(value) || value.ok !== true || value.type !== "snapshot.named.deleted" || value.name !== name || value.status !== "deleted") throw new Error("Box returned an invalid snapshot deletion")
  }

  async verifyBoxesReleased(ids: readonly string[], activeBaseline: number): Promise<ProbeReleaseReconciliation> {
    const result = await reconcileProbeBoxesReleased(ids, activeBaseline, async () => {
      const limits = limitsResponse(await this.json("GET", "/limits"))
      const visibleIds = boxListResponse(await this.json("GET", "/boxes"))
      return { activeBoxes: limits.activeBoxes, visibleIds }
    }, { pollIntervalMs: this.config.pollIntervalMs, pollTimeoutMs: this.config.pollTimeoutMs, sleep: milliseconds => this.sleep(milliseconds, AbortSignal.timeout(this.config.requestTimeoutMs)), now: this.now })
    this.progress({ stage: "cleanup-verification", activeBoxes: result.activeBoxes, probeBoxesVisible: false })
    return result
  }

  #reportProgress(stage: string, state: string, previousState: string | undefined, previousLogAt: number): { lastState: string; lastLogAt: number } {
    const now = this.now()
    if (state !== previousState || now - previousLogAt >= 10_000) {
      this.progress({ stage, state })
      return { lastState: state, lastLogAt: now }
    }
    return { lastState: state, lastLogAt: previousLogAt }
  }
}

async function verifyMarker(client: ProbeClient, boxId: string, marker: string): Promise<void> {
  const command = `test \"$(cat ${MARKER_PATH})\" = \"${marker}\"`
  const value = await client.json("POST", `/boxes/${segment(boxId)}/commands`, { body: { command, timeoutSeconds: 30 } })
  if (!object(value) || value.ok !== true || value.type !== "command.finished" || value.success !== true || value.exitCode !== 0 || value.timedOut !== false) throw new Error("Box marker verification failed")
}

async function createBoxWithRecovery(client: ProbeClient, body: unknown, idempotencyKey: string): Promise<{ id: string; state: BoxState }> {
  try { return createdBox(await client.json("POST", "/boxes", { body, idempotencyKey })) }
  catch (error) {
    if (error instanceof ProbeHttpError && error.status < 500) throw error
    return createdBox(await client.json("POST", "/boxes", { body, idempotencyKey }))
  }
}

async function bestEffortCleanup(client: ProbeClient, boxes: readonly string[], snapshotName?: string): Promise<void> {
  if (snapshotName) try { await client.deleteSnapshot(snapshotName) } catch {}
  for (const [index, id] of [...boxes].reverse().entries()) try { await client.deleteBox(id, index === 0 ? "restored-delete" : "source-delete") } catch {}
}

function limitsResponse(value: unknown): { canStart: boolean; activeBoxes: number; maxActiveBoxes: number } {
  if (!object(value) || value.ok !== true || value.type !== "limits.info" || typeof value.canStart !== "boolean" || !nonnegativeInteger(value.activeBoxes) || !nonnegativeInteger(value.maxActiveBoxes)) throw new Error("Box returned invalid account limits")
  return { canStart: value.canStart, activeBoxes: value.activeBoxes, maxActiveBoxes: value.maxActiveBoxes }
}
function dataRetentionResponse(value: unknown): { enabled: boolean } { if (!object(value) || value.ok !== true || value.type !== "data_retention.info" || typeof value.enabled !== "boolean") throw new Error("Box returned invalid data-retention policy"); return { enabled: value.enabled } }
function boxListResponse(value: unknown): string[] { if (!object(value) || value.ok !== true || value.type !== "box.list" || !Array.isArray(value.boxes)) throw new Error("Box returned an invalid list response"); return value.boxes.map(item => box(item).id) }
function createdBox(value: unknown): { id: string; state: BoxState } { if (!object(value) || value.ok !== true || value.type !== "box.created") throw new Error("Box returned an invalid create response"); const result = box(value.box); if (value.status !== "provisioning" && value.status !== result.state) throw new Error("Box returned an invalid create response"); return result }
function infoBox(value: unknown, id: string): { id: string; state: BoxState } { if (!object(value) || value.ok !== true || value.type !== "box.info") throw new Error("Box returned an invalid info response"); const result = box(value.box); if (result.id !== id) throw new Error("Box response identity mismatch"); return result }
function box(value: unknown): { id: string; state: BoxState } { if (!object(value) || !/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(String(value.id)) || !BOX_STATES.includes(value.state as BoxState)) throw new Error("Box returned an invalid Box"); return { id: String(value.id), state: value.state as BoxState } }
function actionResponse(value: unknown, id: string, type: "box.stopping" | "box.resuming"): void { if (!object(value) || value.ok !== true || value.type !== type || value.id !== id || value.status !== (type === "box.stopping" ? "archiving" : "resuming")) throw new Error("Box returned an invalid lifecycle response") }
function markerWriteResponse(value: unknown, path: string): void { if (!object(value) || value.ok !== true || value.type !== "file.written" || value.success !== true || value.encoding !== "base64" || !nonnegativeInteger(value.size) || typeof value.path !== "string" || posix.resolve("/home/user", value.path) !== path) throw new Error("Box returned an invalid marker write response") }
function snapshotResponse(value: unknown, type: "snapshot.named.saving" | "snapshot.named.info", name: string, sourceId: string): { state: SnapshotState; artifactId?: string } { if (!object(value) || value.ok !== true || value.type !== type || !object(value.snapshot) || value.snapshot.name !== name || value.snapshot.sourceBoxId !== sourceId || !SNAPSHOT_STATES.includes(value.snapshot.status as SnapshotState) || (value.snapshot.status === "ready" && !plain(value.snapshot.snapshotId))) throw new Error("Box returned an invalid named snapshot"); return { state: value.snapshot.status as SnapshotState, ...(plain(value.snapshot.snapshotId) ? { artifactId: value.snapshot.snapshotId } : {}) } }
function deletionResponse(value: unknown, type: "box.deleting" | "deletion.operation", targetId: string, operationId?: string): { id: string; status: "pending" | "processing" | "blocked" | "completed" } { if (!object(value) || value.ok !== true || value.type !== type || !object(value.operation) || !/^bdop_[a-f0-9]{32}$/.test(String(value.operation.id)) || (operationId && value.operation.id !== operationId) || value.operation.kind !== "box" || value.operation.targetId !== targetId || !["pending", "processing", "blocked", "completed"].includes(String(value.operation.status))) throw new Error("Box returned an invalid deletion operation"); return { id: String(value.operation.id), status: value.operation.status as "pending" | "processing" | "blocked" | "completed" } }
function redact(error: unknown, secrets: readonly string[]): string { let text = error instanceof Error ? error.message : String(error); for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED]"); return text.replace(/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]") }
function cleanUrl(value: string): string { try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(); return url.href.replace(/\/+$/, "") } catch { throw new Error("BOX_API_BASE_URL must be a credential-free HTTPS URL") } }
function positiveInteger(value: string, name: string): number { const number = Number(value); if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`); return number }
function nonnegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function plain(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value === value.trim() }
function object(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function segment(value: string): string { return encodeURIComponent(value) }
function cancel(stream: ReadableStream<Uint8Array> | null): void { if (stream) try { void stream.cancel().catch(() => undefined) } catch {} }
class ProbeHttpError extends Error { constructor(readonly status: number) { super(`Box request failed (${status})`) } }
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Box returned an empty response")
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0; let complete = false
  const abort = () => { try { void reader.cancel(signal.reason).catch(() => undefined) } catch {} }
  signal.addEventListener("abort", abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const item = await readAbortable(reader, signal)
      if (item.done) break
      total += item.value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new Error("Box response is too large")
      chunks.push(item.value)
    }
    const bytes = new Uint8Array(total); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    complete = true
    return value
  } finally {
    signal.removeEventListener("abort", abort)
    if (complete) reader.releaseLock()
    else try { void reader.cancel(signal.reason).catch(() => undefined) } catch {}
  }
}
function readAbortable(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> { return new Promise((resolve, reject) => { const fail = () => { cleanup(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")) }; const cleanup = () => signal.removeEventListener("abort", fail); signal.addEventListener("abort", fail, { once: true }); if (signal.aborted) return fail(); reader.read().then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) }) }) }
function testRuntime(): boolean { return process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1" || process.argv.some(value => /(?:^|\/)bun(?:$|\s)/.test(value) && process.argv.includes("test")) }

export async function main(): Promise<void> {
  if (process.argv.includes("--help")) { console.log(probeHelp()); return }
  if (testRuntime()) throw new Error("Live Box capability probe is disabled under bun test")
  const config = loadProbeConfig(process.env, process.argv.slice(2))
  await runBoxCapabilityProbe(config, { fetch, sleep: async (milliseconds, signal) => { signal.throwIfAborted(); await Bun.sleep(milliseconds); signal.throwIfAborted() }, randomId: () => crypto.randomUUID(), log: observation => console.log(JSON.stringify(observation)) })
}

if (import.meta.main) await main().catch(error => { console.error(redact(error, [process.env.BOX_API_KEY ?? ""])); process.exitCode = 1 })
