import { mkdir, open, writeFile } from "node:fs/promises"
import { join } from "node:path"

const AUTHORIZATION = "I_UNDERSTAND_THIS_ERROR_PROBE_CREATES_STOPS_RESUMES_SNAPSHOTS_AND_PERMANENTLY_DELETES_BOX_RESOURCES"
const DEFAULT_BASE_URL = "https://ascii.dev/api/box/v1"
const MAX_RESPONSE_BYTES = 1_048_576
const INVALID_KEY = "deliberately-invalid-box-key"
const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/
const DELETION_ID = /^bdop_[a-f0-9]{32}$/
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface BoxErrorProbeConfig {
  apiBaseUrl: string
  apiKey: string
  artifactDirectory: string
  pollIntervalMs: number
  pollTimeoutMs: number
  requestTimeoutMs: number
}

export interface ProbeCase {
  caseId: string
  operation: string
  request: { method: string; pathTemplate: string; mutation: boolean; idempotencyKeyLabel?: string; bodyShapeKeys?: string[] }
  response: { status?: number; contentType?: string; bodyKind: "json" | "empty" | "text" | "transport-error"; body?: unknown; bodyShapeKeys?: string[]; ok?: boolean; type?: string; outerCode?: string; innerCode?: string; innerStatus?: number; innerConsistent?: boolean; messageLength?: number; messageSha256?: string; requestIdPresent?: boolean }
  expectation: string
  certainty: "observed" | "transport-uncertain" | "documentation-only"
  correlation?: { trackedBoxCreated?: boolean; trackedDeletionCreated?: boolean; trackedSnapshotName?: boolean }
}

export interface ProbeArtifact {
  schemaVersion: 1
  run: string
  startedAt: string
  baseline: { visibleIds: string[]; activeCount: number }
  cases: ProbeCase[]
  tracked: { boxIds: string[]; deletionIds: string[]; snapshotNames: string[] }
  cleanup: { complete: boolean; baselinePreserved: boolean; trackedBoxesAbsent: boolean; activeCountRestored: boolean }
}

export interface BoxErrorProbeDependencies {
  fetch: Fetcher
  sleep(milliseconds: number): Promise<void>
  random(): string
  now(): Date
  writeArtifacts(artifact: ProbeArtifact): Promise<{ raw: string; sanitized: string }>
  log(line: string): void
}

export interface BoxErrorProbeResult { artifact: ProbeArtifact; paths: { raw: string; sanitized: string } }

export function loadBoxErrorProbeConfig(env: Record<string, string | undefined>, argv: readonly string[], underBunTest = testRuntime()): BoxErrorProbeConfig {
  if (underBunTest) throw new Error("Live Box error probe is disabled under bun test")
  if (!argv.includes("--run")) throw new Error("Live Box error probe requires exact --run")
  if (env.BOX_ERROR_CONFORMANCE_PROBE_AUTHORIZATION !== AUTHORIZATION) throw new Error("Live Box error probe lacks literal authorization")
  if (env.WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT !== "YES") throw new Error("Live Box error probe requires WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT=YES")
  if (!plain(env.BOX_API_KEY)) throw new Error("BOX_API_KEY is required")
  const pollIntervalMs = positive(env.BOX_ERROR_PROBE_POLL_INTERVAL_MS, 1_000)
  const pollTimeoutMs = positive(env.BOX_ERROR_PROBE_POLL_TIMEOUT_MS, 300_000)
  if (pollTimeoutMs < pollIntervalMs) throw new Error("Probe polling bounds are invalid")
  return {
    apiBaseUrl: cleanUrl(env.BOX_API_BASE_URL ?? DEFAULT_BASE_URL), apiKey: env.BOX_API_KEY,
    artifactDirectory: env.BOX_ERROR_PROBE_ARTIFACT_DIRECTORY ?? ".waterbox/probes", pollIntervalMs, pollTimeoutMs,
    requestTimeoutMs: positive(env.BOX_ERROR_PROBE_REQUEST_TIMEOUT_MS, 30_000),
  }
}

export async function runBoxErrorConformanceProbe(config: BoxErrorProbeConfig, dependencies: BoxErrorProbeDependencies): Promise<BoxErrorProbeResult> {
  const run = normalizeRun(dependencies.random()), startedAt = validNow(dependencies.now()).toISOString()
  const nonexistentBox = `bx_${run.slice(0, 8).replace(/[01lo]/g, "2")}`
  const nonexistentDeletion = `bdop_${run.slice(0, 32).padEnd(32, "a").replace(/[^a-f0-9]/g, "a")}`
  const nonexistentSnapshot = `waterbox-error-missing-${run.slice(0, 20)}`
  const snapshotName = `waterbox-error-${run.slice(0, 30)}`
  const trackedBoxes = new Set<string>(), trackedDeletions = new Set<string>(), trackedSnapshots = new Set<string>()
  const artifact: ProbeArtifact = { schemaVersion: 1, run, startedAt, baseline: { visibleIds: [], activeCount: -1 }, cases: [], tracked: { boxIds: [], deletionIds: [], snapshotNames: [] }, cleanup: { complete: false, baselinePreserved: false, trackedBoxesAbsent: false, activeCountRestored: false } }
  const client = new CaptureClient(config, dependencies, artifact.cases)
  let failure: unknown
  let paths: { raw: string; sanitized: string } | undefined

  const syncTracked = () => { artifact.tracked = { boxIds: [...trackedBoxes], deletionIds: [...trackedDeletions], snapshotNames: [...trackedSnapshots] } }
  const capture = async (spec: RequestSpec): Promise<ProbeCase> => {
    const item = await client.capture(spec)
    if (spec.ownershipCreate && item.certainty === "observed" && item.response.status !== undefined && item.response.status >= 200 && item.response.status < 300) {
      const id = successfulCreateIdentity(item)
      trackedBoxes.add(id)
      item.correlation = { ...item.correlation, trackedBoxCreated: true }
    }
    for (const id of deletionIds(item.response.body)) { trackedDeletions.add(id); item.correlation = { ...item.correlation, trackedDeletionCreated: true } }
    if (spec.snapshotName) { trackedSnapshots.add(spec.snapshotName); item.correlation = { ...item.correlation, trackedSnapshotName: true } }
    syncTracked()
    return item
  }
  const create = async (spec: RequestSpec, expectedIdentity?: string): Promise<ProbeCase> => {
    const first = await capture({ ...spec, ownershipCreate: true })
    if (successStatus(first)) {
      const identity = successfulCreateIdentity(first)
      if (expectedIdentity && identity !== expectedIdentity) throw new Error("Box create replay returned a different identity")
      return first
    }
    if (first.certainty !== "transport-uncertain") return first
    const reconciled = await capture({ ...spec, caseId: `${spec.caseId}.reconcile`, operation: `${spec.operation} explicit exact reconciliation`, ownershipCreate: true })
    if (!successStatus(reconciled)) throw new Error("unreconciled ownership blocker: exact Box create replay did not return success")
    const identity = successfulCreateIdentity(reconciled)
    if (expectedIdentity && identity !== expectedIdentity) throw new Error("Box create replay returned a different identity")
    return reconciled
  }
  const mutation = async (spec: RequestSpec, reconcile?: () => Promise<void>): Promise<ProbeCase> => {
    const item = await capture(spec)
    if (item.certainty !== "transport-uncertain") return item
    if (!reconcile) throw new Error(`unreconciled mutation outcome: ${spec.caseId}`)
    await reconcile()
    return item
  }
  const requireMissingBox = async (id: string, caseId: string) => {
    const item = await capture({ caseId, operation: "read-only reconciliation of uncertain Box mutation", method: "GET", path: `/boxes/${id}`, pathTemplate: "/boxes/{boxId}", expectation: "404 absent", mutation: false })
    if (item.certainty !== "observed" || item.response.status !== 404) throw new Error("unreconciled Box mutation outcome")
  }
  const requireMissingSnapshot = async (name: string, caseId: string) => {
    const item = await capture({ caseId, operation: "read-only reconciliation of uncertain snapshot mutation", method: "GET", path: `/named-snapshots/${encodeURIComponent(name)}`, pathTemplate: "/named-snapshots/{name}", expectation: "404 absent", mutation: false })
    if (item.certainty !== "observed" || item.response.status !== 404) throw new Error("unreconciled snapshot mutation outcome")
  }

  try {
    const baselineBoxes = await capture({ caseId: "baseline.boxes", operation: "record baseline visible Boxes", method: "GET", path: "/boxes", pathTemplate: "/boxes", expectation: "200 box.list", mutation: false })
    const baselineLimits = await capture({ caseId: "baseline.limits", operation: "record baseline active count", method: "GET", path: "/limits", pathTemplate: "/limits", expectation: "200 limits.info", mutation: false })
    artifact.baseline.visibleIds = parseBoxList(baselineBoxes)
    artifact.baseline.activeCount = parseActiveCount(baselineLimits)
    const maximum = object(baselineLimits.response.body) && integer(baselineLimits.response.body.maxActiveBoxes) ? Number(baselineLimits.response.body.maxActiveBoxes) : artifact.baseline.activeCount
    if (maximum - artifact.baseline.activeCount < 2 || object(baselineLimits.response.body) && baselineLimits.response.body.canStart === false) throw new Error("baseline has insufficient safe Box capacity")

    await capture({ caseId: "1", operation: "authenticate with invalid key", method: "GET", path: "/boxes", pathTemplate: "/boxes", expectation: "401 unauthorized", mutation: false, apiKey: INVALID_KEY })
    await capture({ caseId: "2", operation: "inspect nonexistent Box", method: "GET", path: `/boxes/${nonexistentBox}`, pathTemplate: "/boxes/{boxId}", expectation: "404 box_not_found", mutation: false })
    for (const [suffix, action, method] of [["stop", "stop", "POST"], ["resume", "resume", "POST"], ["delete", "", "DELETE"]] as const) await mutation({ caseId: `3.${suffix}`, operation: `${suffix} nonexistent Box`, method, path: `/boxes/${nonexistentBox}${action ? `/${action}` : ""}`, pathTemplate: action ? `/boxes/{boxId}/${action}` : "/boxes/{boxId}", expectation: "404 box_not_found", mutation: true, confirmDelete: method === "DELETE" ? nonexistentBox : undefined }, () => requireMissingBox(nonexistentBox, `3.${suffix}.reconcile`))
    await mutation({ caseId: "4", operation: "command on nonexistent Box", method: "POST", path: `/boxes/${nonexistentBox}/commands`, pathTemplate: "/boxes/{boxId}/commands", expectation: "404 box_not_found", mutation: true, body: { command: "true", timeoutSeconds: 1 } })
    await mutation({ caseId: "5", operation: "command with invalid timeout", method: "POST", path: `/boxes/${nonexistentBox}/commands`, pathTemplate: "/boxes/{boxId}/commands", expectation: "400 invalid timeout or Box lookup precedence", mutation: true, body: { command: "true", timeoutSeconds: 0 } })
    await capture({ caseId: "6", operation: "inspect nonexistent named snapshot", method: "GET", path: `/named-snapshots/${nonexistentSnapshot}`, pathTemplate: "/named-snapshots/{name}", expectation: "404 snapshot_not_found", mutation: false })
    await mutation({ caseId: "7", operation: "delete nonexistent named snapshot", method: "DELETE", path: `/named-snapshots/${nonexistentSnapshot}`, pathTemplate: "/named-snapshots/{name}", expectation: "404 snapshot_not_found", mutation: true }, () => requireMissingSnapshot(nonexistentSnapshot, "7.reconcile"))
    trackedSnapshots.add(nonexistentSnapshot); syncTracked()
    await mutation({ caseId: "8", operation: "save snapshot from nonexistent Box", method: "POST", path: "/named-snapshots", pathTemplate: "/named-snapshots", expectation: "404 box_not_found", mutation: true, body: { boxId: nonexistentBox, name: nonexistentSnapshot }, snapshotName: nonexistentSnapshot }, () => requireMissingSnapshot(nonexistentSnapshot, "8.reconcile"))
    await create({ caseId: "9", operation: "create Box from nonexistent named snapshot", method: "POST", path: "/boxes", pathTemplate: "/boxes", expectation: "404 snapshot_not_found", mutation: true, body: { from: nonexistentSnapshot, noEnv: true, ttlSeconds: 300 }, idempotencyKey: `waterbox-error-${run}-missing`, idempotencyKeyLabel: "missing-snapshot" })
    await capture({ caseId: "10", operation: "inspect nonexistent deletion operation", method: "GET", path: `/deletion-operations/${nonexistentDeletion}`, pathTemplate: "/deletion-operations/{deletionId}", expectation: "404 deletion operation not found", mutation: false })

    const createBody = { noEnv: true, ttlSeconds: 300 }, createKey = `waterbox-error-${run}-create`
    const first = await create({ caseId: "11.create", operation: "create Box with idempotency key", method: "POST", path: "/boxes", pathTemplate: "/boxes", expectation: "202 box.created", mutation: true, body: createBody, idempotencyKey: createKey, idempotencyKeyLabel: "primary" })
    const primary = firstTrackedBox(first, trackedBoxes)
    await mutation({ caseId: "13", operation: "command immediately while Box is starting", method: "POST", path: `/boxes/${primary}/commands`, pathTemplate: "/boxes/{boxId}/commands", expectation: "documented state conflict while starting; success also recorded", mutation: true, body: { command: "true", timeoutSeconds: 1 } })
    await create({ caseId: "11.replay", operation: "same-key same-body create replay", method: "POST", path: "/boxes", pathTemplate: "/boxes", expectation: "same Box identity", mutation: true, body: createBody, idempotencyKey: createKey, idempotencyKeyLabel: "primary" }, primary)
    await create({ caseId: "11.conflict", operation: "same-key different-body create conflict", method: "POST", path: "/boxes", pathTemplate: "/boxes", expectation: "409 idempotency conflict", mutation: true, body: { noEnv: true, ttlSeconds: 301 }, idempotencyKey: createKey, idempotencyKeyLabel: "primary" })

    const concurrentSpec: RequestSpec = { caseId: "12.a", operation: "concurrent same-key create A", method: "POST", path: "/boxes", pathTemplate: "/boxes", expectation: "202 replay or best-effort 409 idempotency_in_progress", mutation: true, body: createBody, idempotencyKey: `waterbox-error-${run}-concurrent`, idempotencyKeyLabel: "concurrent" }
    const concurrentResults = await Promise.all([client.capture({ ...concurrentSpec, ownershipCreate: true }), client.capture({ ...concurrentSpec, caseId: "12.b", operation: "concurrent same-key create B", ownershipCreate: true })])
    const successfulConcurrentIds = concurrentResults.filter(successStatus).map(successfulCreateIdentity)
    if (new Set(successfulConcurrentIds).size > 1) throw new Error("concurrent same-key creates returned different Box identities")
    let concurrentIdentity = successfulConcurrentIds[0]
    if (!concurrentIdentity && concurrentResults.some(item => item.certainty === "transport-uncertain")) {
      const replay = await capture({ ...concurrentSpec, caseId: "12.reconcile", operation: "single exact reconciliation for concurrent creates", ownershipCreate: true })
      if (!successStatus(replay)) throw new Error("unreconciled ownership blocker: concurrent Box creates have no successful identity")
      concurrentIdentity = successfulCreateIdentity(replay)
    }
    if (concurrentIdentity) {
      trackedBoxes.add(concurrentIdentity)
      for (const item of concurrentResults) if (successStatus(item) || item.certainty === "transport-uncertain") item.correlation = { ...item.correlation, trackedBoxCreated: true }
    }
    syncTracked()
    // The concurrency observation can consume a short provider request window. Do not let it
    // contaminate later operation-specific lifecycle evidence.
    await client.pause(Math.max(61_000, config.pollIntervalMs))

    await waitForBox(client, primary, new Set(["ready", "idle"]), config, "13.readiness")
    const stopped = await mutation({ caseId: "14.stop", operation: "stop ready Box", method: "POST", path: `/boxes/${primary}/stop`, pathTemplate: "/boxes/{boxId}/stop", expectation: "202 box.stopping", mutation: true }, () => waitForBox(client, primary, new Set(["archived"]), config, "14.stop.reconcile"))
    const repeatedStop = await mutation({ caseId: "14.repeat", operation: "repeat stop", method: "POST", path: `/boxes/${primary}/stop`, pathTemplate: "/boxes/{boxId}/stop", expectation: "202 if stop is already in progress", mutation: true }, () => waitForBox(client, primary, new Set(["archived"]), config, "14.repeat.reconcile"))
    const stopAccepted = successStatus(stopped) || successStatus(repeatedStop) || stopped.certainty === "transport-uncertain" || repeatedStop.certainty === "transport-uncertain"
    if (stopAccepted) await waitForBox(client, primary, new Set(["archived"]), config, "14.archived")
    const resumed = await mutation({ caseId: "15.resume", operation: "resume archived Box", method: "POST", path: `/boxes/${primary}/resume`, pathTemplate: "/boxes/{boxId}/resume", expectation: "202 box.resuming", mutation: true }, () => waitForBox(client, primary, new Set(["ready", "idle"]), config, "15.resume.reconcile"))
    const repeatedResume = await mutation({ caseId: "15.repeat", operation: "repeat resume", method: "POST", path: `/boxes/${primary}/resume`, pathTemplate: "/boxes/{boxId}/resume", expectation: "observed response recorded; retry stability not assumed", mutation: true }, () => waitForBox(client, primary, new Set(["ready", "idle"]), config, "15.repeat.reconcile"))
    const resumeAccepted = successStatus(resumed) || successStatus(repeatedResume) || resumed.certainty === "transport-uncertain" || repeatedResume.certainty === "transport-uncertain"
    if (resumeAccepted) await waitForBox(client, primary, new Set(["ready", "idle"]), config, "15.readiness")

    const snapshotSource = resumeAccepted || !stopAccepted ? primary : [...trackedBoxes].find(id => id !== primary)
    if (!snapshotSource) throw new Error("unreconciled probe-created resources: no ready snapshot source")
    await waitForBox(client, snapshotSource, new Set(["ready", "idle"]), config, "16.source-readiness")

    trackedSnapshots.add(snapshotName); syncTracked()
    await mutation({ caseId: "16.save", operation: "save named snapshot", method: "POST", path: "/named-snapshots", pathTemplate: "/named-snapshots", expectation: "202 snapshot saving", mutation: true, body: { boxId: snapshotSource, name: snapshotName }, snapshotName }, () => waitForSnapshot(client, snapshotName, config, "16.save.reconcile"))
    await mutation({ caseId: "16.duplicate", operation: "duplicate snapshot save while saving", method: "POST", path: "/named-snapshots", pathTemplate: "/named-snapshots", expectation: "409 duplicate or save in progress", mutation: true, body: { boxId: snapshotSource, name: snapshotName } }, () => waitForSnapshot(client, snapshotName, config, "16.duplicate.reconcile"))
    const earlyDelete = await mutation({ caseId: "16.delete-while-saving", operation: "delete snapshot while saving", method: "DELETE", path: `/named-snapshots/${snapshotName}`, pathTemplate: "/named-snapshots/{name}", expectation: "state conflict while saving", mutation: true }, async () => { if (!await waitForSnapshotAbsence(client, snapshotName, config, "16.delete-while-saving.reconcile")) throw new Error("unreconciled snapshot delete outcome") })
    if (successStatus(earlyDelete) || earlyDelete.certainty === "transport-uncertain") {
      trackedSnapshots.delete(snapshotName)
      await capture({ caseId: "16.resave-after-early-delete", operation: "recreate snapshot after accepted early delete", method: "POST", path: "/named-snapshots", pathTemplate: "/named-snapshots", expectation: "202 snapshot saving", mutation: true, body: { boxId: snapshotSource, name: snapshotName }, snapshotName })
    }
    await waitForSnapshot(client, snapshotName, config, "16.inspect")
    const snapshotDelete = await mutation({ caseId: "16.delete", operation: "delete ready named snapshot", method: "DELETE", path: `/named-snapshots/${snapshotName}`, pathTemplate: "/named-snapshots/{name}", expectation: "200 snapshot deleted", mutation: true }, async () => { if (!await waitForSnapshotAbsence(client, snapshotName, config, "16.delete.reconcile")) throw new Error("unreconciled snapshot delete outcome") })
    if (successStatus(snapshotDelete)) trackedSnapshots.delete(snapshotName)
    await mutation({ caseId: "16.repeat-delete", operation: "repeat named snapshot delete", method: "DELETE", path: `/named-snapshots/${snapshotName}`, pathTemplate: "/named-snapshots/{name}", expectation: "404 snapshot_not_found", mutation: true }, () => requireMissingSnapshot(snapshotName, "16.repeat-delete.reconcile"))
    syncTracked()

    const deletion = await mutation({ caseId: "17.delete", operation: "permanently delete Box", method: "DELETE", path: `/boxes/${primary}`, pathTemplate: "/boxes/{boxId}", expectation: "202 box.deleting", mutation: true, confirmDelete: primary }, async () => { if (!await waitForBoxAbsence(client, primary, config, "17.delete.reconcile")) throw new Error("unreconciled Box delete outcome") })
    const operation = deletionIds(deletion.response.body)[0]
    if (operation) await pollDeletion(client, operation, primary, config, "17.operation")
    await mutation({ caseId: "17.repeat-delete", operation: "repeat Box delete", method: "DELETE", path: `/boxes/${primary}`, pathTemplate: "/boxes/{boxId}", expectation: "observed response recorded; retry stability not assumed", mutation: true, confirmDelete: primary }, async () => { if (!await waitForBoxAbsence(client, primary, config, "17.repeat-delete.reconcile")) throw new Error("unreconciled Box delete outcome") })
    await capture({ caseId: "17.target-inspect", operation: "inspect deleted Box", method: "GET", path: `/boxes/${primary}`, pathTemplate: "/boxes/{boxId}", expectation: "404 box_not_found", mutation: false })
    for (const [caseId, operation] of [["D1", "billing failure"], ["D2", "organization suspension"], ["D3", "quota exhaustion"], ["D4", "rate limiting"], ["D5", "provider 5xx induction"]] as const) artifact.cases.push({ caseId, operation, request: { method: "N/A", pathTemplate: "N/A", mutation: false }, response: { bodyKind: "empty" }, expectation: "intentionally not induced", certainty: "documentation-only" })
  } catch (error) { failure = error }
  finally {
    try { await cleanup(client, artifact, trackedBoxes, trackedSnapshots, trackedDeletions, config); syncTracked() }
    catch (error) { failure = new Error(`${failure === undefined ? "" : `${safeError(failure)}; `}Box error probe cleanup blocker: ${safeError(error)}`) }
    try { paths = await dependencies.writeArtifacts(artifact) }
    catch (error) { throw new Error(`capture infrastructure artifact failure: ${safeError(error)}`) }
    dependencies.log(JSON.stringify({ stage: "box-error-probe", cases: artifact.cases.length, cleanup: artifact.cleanup, artifacts: paths }))
  }
  if (failure !== undefined) throw new Error(safeError(failure))
  return { artifact, paths: paths! }
}

interface RequestSpec { caseId: string; operation: string; method: string; path: string; pathTemplate: string; expectation: string; mutation: boolean; body?: unknown; apiKey?: string; idempotencyKey?: string; idempotencyKeyLabel?: string; confirmDelete?: string; ownershipCreate?: boolean; snapshotName?: string }

class CaptureClient {
  constructor(private config: BoxErrorProbeConfig, private deps: BoxErrorProbeDependencies, private cases: ProbeCase[]) {}
  async capture(spec: RequestSpec): Promise<ProbeCase> {
    const request = { method: spec.method, pathTemplate: spec.pathTemplate, mutation: spec.mutation, ...(spec.idempotencyKeyLabel ? { idempotencyKeyLabel: spec.idempotencyKeyLabel } : {}), ...(object(spec.body) ? { bodyShapeKeys: Object.keys(spec.body).sort() } : {}) }
    const item: ProbeCase = { caseId: spec.caseId, operation: spec.operation, request, response: { bodyKind: "transport-error" }, expectation: spec.expectation, certainty: "transport-uncertain" }
    this.cases.push(item)
    const headers: Record<string, string> = { authorization: `Bearer ${spec.apiKey ?? this.config.apiKey}`, accept: "application/json" }
    if (spec.body !== undefined) headers["content-type"] = "application/json"
    if (spec.idempotencyKey) headers["idempotency-key"] = spec.idempotencyKey
    if (spec.confirmDelete) headers["x-ascii-confirm-delete"] = spec.confirmDelete
    const signal = AbortSignal.timeout(this.config.requestTimeoutMs)
    let response: Response
    try { response = await this.deps.fetch(`${this.config.apiBaseUrl}${spec.path}`, { method: spec.method, headers, ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }), signal }) }
    catch { return item }
    try {
      const captured = await captureResponse(response, signal)
      const serialized = captured.body === undefined ? "" : JSON.stringify(captured.body)
      if (serialized.includes(this.config.apiKey) || serialized.includes(this.config.apiBaseUrl) || /"authorization"\s*:/i.test(serialized)) throw new Error("response echoed forbidden request credentials")
      item.response = captured
      item.certainty = "observed"
      return item
    } catch (error) { throw new Error(`capture infrastructure failure: ${safeError(error)}`) }
  }
  now(): number { return validNow(this.deps.now()).getTime() }
  pause(milliseconds: number): Promise<void> { return this.deps.sleep(milliseconds) }
}

async function captureResponse(response: Response, signal: AbortSignal): Promise<ProbeCase["response"]> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  const bytes = await boundedBytes(response.body, signal)
  if (bytes.byteLength === 0) return { status: response.status, ...(contentType ? { contentType } : {}), bodyKind: "empty" }
  if (contentType !== "application/json") return { status: response.status, ...(contentType ? { contentType } : {}), bodyKind: "text" }
  let body: unknown
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
  catch { throw new Error("response JSON is not strict UTF-8 JSON") }
  const outer = object(body) ? body : undefined, inner = outer && object(outer.error) ? outer.error : undefined
  const message = typeof outer?.message === "string" ? outer.message : typeof inner?.message === "string" ? inner.message : undefined
  const outerCode = lexicalCode(outer?.code), innerCode = lexicalCode(inner?.code), innerStatus = integer(inner?.status) ? Number(inner.status) : undefined
  return { status: response.status, ...(contentType ? { contentType } : {}), bodyKind: "json", body,
    ...(outer ? { bodyShapeKeys: Object.keys(outer).sort() } : {}), ...(typeof outer?.ok === "boolean" ? { ok: outer.ok } : {}), ...(typeof outer?.type === "string" ? { type: outer.type } : {}),
    ...(outerCode ? { outerCode } : {}), ...(innerCode ? { innerCode } : {}), ...(innerStatus !== undefined ? { innerStatus } : {}),
    ...(outerCode && innerCode && innerStatus !== undefined ? { innerConsistent: outerCode === innerCode && response.status === innerStatus } : {}),
    ...(message !== undefined ? { messageLength: new TextEncoder().encode(message).byteLength, messageSha256: await sha256(message) } : {}),
    ...(outer && Object.hasOwn(outer, "requestId") ? { requestIdPresent: typeof outer.requestId === "string" && outer.requestId.length > 0 } : {}) }
}

async function cleanup(client: CaptureClient, artifact: ProbeArtifact, boxes: Set<string>, snapshots: Set<string>, deletionSet: Set<string>, config: BoxErrorProbeConfig): Promise<void> {
  for (const name of [...snapshots]) {
    let deleted = await client.capture({ caseId: "cleanup.snapshot", operation: "cleanup tracked snapshot", method: "DELETE", path: `/named-snapshots/${encodeURIComponent(name)}`, pathTemplate: "/named-snapshots/{name}", expectation: "deleted or absent", mutation: true })
    if (deleted.certainty !== "observed") { const inspect = await client.capture({ caseId: "cleanup.snapshot-reconcile", operation: "reconcile uncertain snapshot cleanup", method: "GET", path: `/named-snapshots/${encodeURIComponent(name)}`, pathTemplate: "/named-snapshots/{name}", expectation: "404 absent", mutation: false }); if (inspect.response.status !== 404) throw new Error("snapshot cleanup uncertainty") }
    else if (!successStatus(deleted) && deleted.response.status !== 404) {
      if (deleted.response.status !== 409 || deleted.response.outerCode !== "save_in_progress") throw new Error("snapshot cleanup rejected")
      const deadline = client.now() + config.pollTimeoutMs
      while (true) {
        const inspect = await client.capture({ caseId: "cleanup.snapshot-wait", operation: "wait for tracked snapshot save before cleanup", method: "GET", path: `/named-snapshots/${encodeURIComponent(name)}`, pathTemplate: "/named-snapshots/{name}", expectation: "ready, failed, or absent", mutation: false })
        if (inspect.response.status === 404) break
        const state = object(inspect.response.body) && object(inspect.response.body.snapshot) ? inspect.response.body.snapshot.status : undefined
        if (state === "ready" || state === "failed") { deleted = await client.capture({ caseId: "cleanup.snapshot-after-save", operation: "delete tracked snapshot after save settled", method: "DELETE", path: `/named-snapshots/${encodeURIComponent(name)}`, pathTemplate: "/named-snapshots/{name}", expectation: "deleted or absent", mutation: true }); if (!successStatus(deleted) && deleted.response.status !== 404) throw new Error("snapshot cleanup after save rejected"); break }
        if (client.now() >= deadline) throw new Error("snapshot cleanup save reconciliation timed out")
        await client.pause(config.pollIntervalMs)
      }
    }
    snapshots.delete(name)
  }
  for (const id of [...boxes]) {
    let deleted = await client.capture({ caseId: "cleanup.box", operation: "cleanup tracked Box", method: "DELETE", path: `/boxes/${id}`, pathTemplate: "/boxes/{boxId}", expectation: "deleted or absent", mutation: true, confirmDelete: id })
    if (deleted.certainty !== "observed") {
      if (await waitForBoxAbsence(client, id, config, "cleanup.box-reconcile")) continue
      deleted = await client.capture({ caseId: "cleanup.box-after-present", operation: "cleanup tracked Box proven present after uncertain delete", method: "DELETE", path: `/boxes/${id}`, pathTemplate: "/boxes/{boxId}", expectation: "deleted or absent", mutation: true, confirmDelete: id })
      if (deleted.certainty !== "observed") {
        if (!await waitForBoxAbsence(client, id, config, "cleanup.box-second-reconcile")) throw new Error("Box cleanup uncertainty")
        continue
      }
    }
    if (deleted.response.status === 404) continue
    else if (successStatus(deleted)) { const operation = deletionIds(deleted.response.body)[0]; if (operation) { deletionSet.add(operation); await pollDeletion(client, operation, id, config, "cleanup.deletion") } else if (!await waitForBoxAbsence(client, id, config, "cleanup.box-absence")) throw new Error("Box cleanup deletion did not settle") }
    else throw new Error("Box cleanup rejected")
  }
  const finalBoxes = await client.capture({ caseId: "cleanup.verify-boxes", operation: "verify exact baseline visible Box set", method: "GET", path: "/boxes", pathTemplate: "/boxes", expectation: "exact baseline set restored", mutation: false })
  const visible = new Set(parseBoxList(finalBoxes)), baseline = new Set(artifact.baseline.visibleIds)
  artifact.cleanup.trackedBoxesAbsent = [...boxes].every(id => !visible.has(id))
  artifact.cleanup.baselinePreserved = visible.size === baseline.size && [...visible].every(id => baseline.has(id))
  const limits = await client.capture({ caseId: "cleanup.verify-limits", operation: "verify active count restored", method: "GET", path: "/limits", pathTemplate: "/limits", expectation: "baseline active count", mutation: false })
  artifact.cleanup.activeCountRestored = parseActiveCount(limits) === artifact.baseline.activeCount
  artifact.cleanup.complete = artifact.cleanup.trackedBoxesAbsent && artifact.cleanup.baselinePreserved && artifact.cleanup.activeCountRestored && snapshots.size === 0
  if (!artifact.cleanup.complete) throw new Error("final baseline reconciliation failed")
}

async function waitForBox(client: CaptureClient, id: string, states: Set<string>, config: BoxErrorProbeConfig, caseId: string): Promise<void> {
  const deadline = client.now() + config.pollTimeoutMs
  while (true) { const item = await client.capture({ caseId, operation: "bounded Box state inspection", method: "GET", path: `/boxes/${id}`, pathTemplate: "/boxes/{boxId}", expectation: [...states].join(" or "), mutation: false }); const state = object(item.response.body) && object(item.response.body.box) ? item.response.body.box.state : undefined; if (typeof state === "string" && states.has(state)) return; if (state === "error" || client.now() >= deadline) throw new Error("Box state reconciliation failed"); await client.pause(config.pollIntervalMs) }
}
async function waitForSnapshot(client: CaptureClient, name: string, config: BoxErrorProbeConfig, caseId: string): Promise<void> { const deadline = client.now() + config.pollTimeoutMs; while (true) { const item = await client.capture({ caseId, operation: "inspect snapshot until ready", method: "GET", path: `/named-snapshots/${encodeURIComponent(name)}`, pathTemplate: "/named-snapshots/{name}", expectation: "200 ready", mutation: false }); const status = object(item.response.body) && object(item.response.body.snapshot) ? item.response.body.snapshot.status : undefined; if (status === "ready") return; if (status === "failed" || client.now() >= deadline) throw new Error("snapshot reconciliation failed"); await client.pause(config.pollIntervalMs) } }
async function waitForSnapshotAbsence(client: CaptureClient, name: string, config: BoxErrorProbeConfig, caseId: string): Promise<boolean> { const deadline = client.now() + config.pollTimeoutMs; while (true) { const item = await client.capture({ caseId, operation: "bounded read-only snapshot absence reconciliation", method: "GET", path: `/named-snapshots/${encodeURIComponent(name)}`, pathTemplate: "/named-snapshots/{name}", expectation: "404 absent", mutation: false }); if (item.certainty === "observed" && item.response.status === 404) return true; if (item.certainty === "observed" && item.response.status !== 200) throw new Error("snapshot absence reconciliation was rejected"); if (client.now() >= deadline) return false; await client.pause(config.pollIntervalMs) } }
async function waitForBoxAbsence(client: CaptureClient, id: string, config: BoxErrorProbeConfig, caseId: string): Promise<boolean> { const deadline = client.now() + config.pollTimeoutMs; while (true) { const item = await client.capture({ caseId, operation: "bounded read-only Box absence reconciliation", method: "GET", path: `/boxes/${id}`, pathTemplate: "/boxes/{boxId}", expectation: "404 absent", mutation: false }); if (item.certainty === "observed" && item.response.status === 404) return true; if (item.certainty === "observed" && item.response.status !== 200) throw new Error("Box absence reconciliation was rejected"); if (client.now() >= deadline) return false; await client.pause(config.pollIntervalMs) } }
async function pollDeletion(client: CaptureClient, operation: string, target: string, config: BoxErrorProbeConfig, caseId: string): Promise<void> { const deadline = client.now() + config.pollTimeoutMs; while (true) { const item = await client.capture({ caseId, operation: "inspect deletion operation", method: "GET", path: `/deletion-operations/${operation}`, pathTemplate: "/deletion-operations/{deletionId}", expectation: "completed or target absent", mutation: false }); const status = object(item.response.body) && object(item.response.body.operation) ? item.response.body.operation.status : undefined; if (status === "completed") return; const targetItem = await client.capture({ caseId: `${caseId}.target`, operation: "reconcile deletion target", method: "GET", path: `/boxes/${target}`, pathTemplate: "/boxes/{boxId}", expectation: "404 absent", mutation: false }); if (targetItem.response.status === 404) return; if (client.now() >= deadline) throw new Error("deletion operation reconciliation timed out"); await client.pause(config.pollIntervalMs) } }

export async function writeProbeArtifacts(directory: string, raw: ProbeArtifact): Promise<{ raw: string; sanitized: string }> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stem = `${raw.startedAt.replace(/[:.]/g, "-")}-${raw.run}`, rawPath = join(directory, `${stem}.raw.json`), sanitizedPath = join(directory, `${stem}.sanitized.json`)
  await privateWrite(rawPath, JSON.stringify(raw, null, 2) + "\n")
  await privateWrite(sanitizedPath, JSON.stringify(sanitizeArtifact(raw), null, 2) + "\n")
  return { raw: rawPath, sanitized: sanitizedPath }
}

export function sanitizeArtifact(raw: ProbeArtifact): ProbeArtifact {
  const replacements = new Map<string, string>(); let boxes = 0, deletions = 0, snapshots = 0, requests = 0, timestamps = 0
  const register = (value: string, kind: string) => { if (!value || replacements.has(value)) return; const index = kind === "BOX" ? ++boxes : kind === "DELETION" ? ++deletions : kind === "SNAPSHOT" ? ++snapshots : kind === "REQUEST_ID" ? ++requests : ++timestamps; replacements.set(value, `[${kind}_${index}]`) }
  raw.tracked.boxIds.forEach(value => register(value, "BOX")); raw.baseline.visibleIds.forEach(value => register(value, "BOX")); raw.tracked.deletionIds.forEach(value => register(value, "DELETION")); raw.tracked.snapshotNames.forEach(value => register(value, "SNAPSHOT")); register(raw.startedAt, "TIMESTAMP"); register(raw.run, "SNAPSHOT")
  const discover = (value: unknown, key = "") => { if (typeof value === "string") { if (BOX_ID.test(value)) register(value, "BOX"); else if (DELETION_ID.test(value)) register(value, "DELETION"); else if (/request.?id/i.test(key)) register(value, "REQUEST_ID"); else if (/^(?:\d{4}-\d\d-\d\dT|https?:\/\/)/.test(value)) register(value, "TIMESTAMP"); else if (/snapshot|name/i.test(key) && value.startsWith("waterbox-error-")) register(value, "SNAPSHOT"); return } if (Array.isArray(value)) value.forEach(item => discover(item, key)); else if (object(value)) Object.entries(value).forEach(([child, item]) => discover(item, child)) }
  discover(raw)
  const replace = (value: unknown, key = ""): unknown => { if (typeof value === "string") { let output = value; for (const [source, target] of [...replacements].sort((a, b) => b[0].length - a[0].length)) output = output.split(source).join(target); if (/message/i.test(key) && key !== "messageSha256") return "[MESSAGE_REDACTED]"; if (/token|authorization|api.?key|secret/i.test(key)) return "[TOKEN_REDACTED]"; return output } if (Array.isArray(value)) return value.map(item => replace(item, key)); if (object(value)) return Object.fromEntries(Object.entries(value).map(([child, item]) => [child, replace(item, child)])); return value }
  const safe = replace(structuredClone(raw)) as ProbeArtifact
  for (const item of safe.cases) delete item.response.body
  return safe
}

async function privateWrite(path: string, content: string): Promise<void> { const handle = await open(path, "wx", 0o600); try { await writeFile(handle, content, { encoding: "utf8" }); await handle.chmod(0o600) } finally { await handle.close() } }
async function boundedBytes(stream: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array> { if (!stream) return new Uint8Array(); const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0, done = false; try { while (true) { signal.throwIfAborted(); const item = await reader.read(); if (item.done) { done = true; break } size += item.value.byteLength; if (size > MAX_RESPONSE_BYTES) throw new Error("response exceeds 1 MiB"); chunks.push(item.value) } } finally { if (done) reader.releaseLock(); else try { await reader.cancel() } catch {} } const output = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength } return output }
function parseBoxList(item: ProbeCase): string[] { if (item.certainty !== "observed" || item.response.status !== 200 || !object(item.response.body) || !Array.isArray(item.response.body.boxes)) throw new Error("baseline Box listing is malformed"); return item.response.body.boxes.map(value => { if (!object(value) || typeof value.id !== "string") throw new Error("baseline Box identity is malformed"); return value.id }) }
function parseActiveCount(item: ProbeCase): number { if (item.certainty !== "observed" || item.response.status !== 200 || !object(item.response.body) || !integer(item.response.body.activeBoxes) || Number(item.response.body.activeBoxes) < 0) throw new Error("baseline active count is malformed"); return Number(item.response.body.activeBoxes) }
function firstTrackedBox(item: ProbeCase, tracked: Set<string>): string { const id = boxIds(item.response.body)[0] ?? [...tracked][0]; if (!id) throw new Error("lost ownership tracking"); return id }
function successfulCreateIdentity(item: ProbeCase): string { const ids = boxIds(item.response.body); if (!successStatus(item) || ids.length !== 1) throw new Error("successful Box create must return exactly one valid identity"); return ids[0]! }
function boxIds(value: unknown): string[] { const found = new Set<string>(); walk(value, item => { if (BOX_ID.test(item)) found.add(item) }); return [...found] }
function deletionIds(value: unknown): string[] { const found = new Set<string>(); walk(value, item => { if (DELETION_ID.test(item)) found.add(item) }); return [...found] }
function walk(value: unknown, visit: (value: string) => void): void { if (typeof value === "string") visit(value); else if (Array.isArray(value)) value.forEach(item => walk(item, visit)); else if (object(value)) Object.values(value).forEach(item => walk(item, visit)) }
function successStatus(item: ProbeCase): boolean { return item.certainty === "observed" && item.response.status !== undefined && item.response.status >= 200 && item.response.status < 300 }
function normalizeRun(value: string): string { const run = value.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 32); if (run.length < 16) throw new Error("probe random source is invalid"); return run }
function validNow(value: Date): Date { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("probe time source is invalid"); return value }
function cleanUrl(value: string): string { try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(); return url.href.replace(/\/+$/, "") } catch { throw new Error("BOX_API_BASE_URL must be a credential-free HTTPS URL") } }
function positive(value: string | undefined, fallback: number): number { const parsed = value === undefined ? fallback : Number(value); if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("probe timing must be a positive integer"); return parsed }
function lexicalCode(value: unknown): string | undefined { return typeof value === "string" && /^[a-z][a-z0-9_.-]{0,127}$/i.test(value) ? value : undefined }
async function sha256(value: string): Promise<string> { return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex") }
function safeError(error: unknown): string { return error instanceof Error ? error.message.replace(/https?:\/\/\S+/gi, "[URL_REDACTED]") : "probe failed" }
function object(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) }
function plain(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value === value.trim() }
function testRuntime(): boolean { return process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1" || process.argv.includes("test") }

export async function main(): Promise<void> {
  const config = loadBoxErrorProbeConfig(process.env, process.argv.slice(2))
  const result = await runBoxErrorConformanceProbe(config, { fetch, sleep: milliseconds => Bun.sleep(milliseconds), random: () => crypto.randomUUID(), now: () => new Date(), writeArtifacts: artifact => writeProbeArtifacts(config.artifactDirectory, artifact), log: line => console.log(line) })
  console.log(JSON.stringify({ ok: true, cases: result.artifact.cases.length, cleanup: result.artifact.cleanup, artifacts: result.paths }))
}

if (import.meta.main) main().catch(error => { console.error(safeError(error)); process.exitCode = 1 })
