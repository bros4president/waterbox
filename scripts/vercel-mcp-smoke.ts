import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SandboxSchema } from "../packages/sandbox-contracts/src/index.ts"
import { createConfiguredEmbeddedApiBackend, parseLocalProviderConfiguration } from "../packages/control-plane-local/src/index.ts"
import { SystemVercelProviderClock, VercelSandboxInfrastructure, type VercelProviderConfig, type VercelProviderFetch } from "../packages/sandbox-provider-vercel/src/index.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runDirectMcpProductFlow, type DirectSmokeClient, type McpRuntimeLayout } from "./direct-mcp-smoke.ts"

const AUTHORIZATION = "I_UNDERSTAND_THIS_CREATES_AND_DELETES_VERCEL_SANDBOX_RESOURCES"
const MAX_PAGES = 100
const MAX_RESPONSE_BYTES = 1_048_576

type Baseline = { sandboxes: Set<string>; snapshots: Set<string> }
type Environment = Record<string, string | undefined>

const runtime: McpRuntimeLayout = {
  workdir: "/workspace",
  markerPath: "/workspace/vercel-direct-marker",
  runtimeLauncher: "/workspace/.waterbox/waterbox",
  staleRuntimeCommand: "rm -f /workspace/.waterbox/waterbox-cli.js",
  restoredRuntimeCheck: "test -s /workspace/.waterbox/waterbox-cli.js && test -f /workspace/.waterbox/manifest.json",
}

export function assertVercelMcpSmokeAuthorized(environment: Environment): void {
  if (environment.WATERBOX_VERCEL_SMOKE_AUTHORIZATION !== AUTHORIZATION || environment.WATERBOX_VERCEL_SMOKE_ISOLATED_PROJECT !== "YES") throw new Error("The Vercel MCP smoke requires explicit authorization for an isolated project")
}

export async function readVercelBaseline(environment: Environment, fetch_: typeof fetch = fetch): Promise<Baseline> {
  const token = required(environment.VERCEL_TOKEN, "VERCEL_TOKEN")
  const teamId = required(environment.VERCEL_TEAM_ID, "VERCEL_TEAM_ID")
  const projectId = required(environment.VERCEL_PROJECT_ID, "VERCEL_PROJECT_ID")
  const origin = environment.VERCEL_API_ORIGIN ?? "https://api.vercel.com"
  const [sandboxes, snapshots] = await Promise.all([
    pages(origin, token, teamId, projectId, "sandboxes", fetch_),
    pages(origin, token, teamId, projectId, "snapshots", fetch_),
  ])
  return {
    sandboxes: new Set(sandboxes.map(item => item.name).filter((value): value is string => typeof value === "string")),
    snapshots: new Set(snapshots.filter(item => item.status !== "deleted").map(item => item.id).filter((value): value is string => typeof value === "string")),
  }
}

export async function compareVercelBaseline(environment: Environment, baseline: Baseline, fetch_: typeof fetch = fetch): Promise<{ exactSandboxes: boolean; exactActiveSnapshots: boolean }> {
  const current = await readVercelBaseline(environment, fetch_)
  return { exactSandboxes: equal(baseline.sandboxes, current.sandboxes), exactActiveSnapshots: equal(baseline.snapshots, current.snapshots) }
}

export async function reconcileVercelBaseline(environment: Environment, baseline: Baseline, fetch_: typeof fetch = fetch): Promise<{ exactSandboxes: boolean; exactActiveSnapshots: boolean; timedOut: boolean }> {
  const interval = positive(environment.WATERBOX_VERCEL_SMOKE_RECONCILIATION_INTERVAL_MS, 1_000)
  const timeout = positive(environment.WATERBOX_VERCEL_SMOKE_RECONCILIATION_TIMEOUT_MS, 120_000)
  const deadline = Date.now() + timeout
  while (true) {
    const result = await compareVercelBaseline(environment, baseline, fetch_)
    if (result.exactSandboxes && result.exactActiveSnapshots) return { ...result, timedOut: false }
    if (Date.now() >= deadline) return { ...result, timedOut: true }
    await Bun.sleep(interval)
  }
}

export async function runVercelMcpSmoke(environment: Environment = process.env): Promise<{ ok: true; flow: "vercel-mcp-smoke" }> {
  assertVercelMcpSmokeAuthorized(environment)
  required(environment.VERCEL_TOKEN, "VERCEL_TOKEN"); required(environment.VERCEL_TEAM_ID, "VERCEL_TEAM_ID"); required(environment.VERCEL_PROJECT_ID, "VERCEL_PROJECT_ID")
  const baseline = await readVercelBaseline(environment)
  const directory = await mkdtemp(join(tmpdir(), "waterbox-vercel-mcp-"))
  const localSecretPath = join(directory, "local-secret.bin")
  await Bun.write(localSecretPath, new Uint8Array([0, 1, 2, 3, 255]))
  let failure: unknown
  const transport = new StdioClientTransport({
    command: "node",
    args: [resolve(import.meta.dir, "../packages/mcp/dist/waterbox.js")],
    env: stringEnvironment({ ...environment, WATERBOX_PROVIDER: "vercel", WATERBOX_SQLITE_PATH: join(directory, "direct.sqlite"), WATERBOX_MCP_DIAGNOSTICS: "1" }),
    // Diagnostics are already provider-redacted; inheriting stderr prevents a
    // dead child pipe from making the stdio initialization appear successful.
    stderr: "inherit",
  })
  const client = new Client({ name: "waterbox-vercel-smoke", version: "1" })
  try {
    await client.connect(transport)
    await runDirectMcpProductFlow(client as DirectSmokeClient, { localSecretPath, runtime, log: console.log })
  } catch (error) {
    failure = error
  } finally {
    await client.close().catch(() => {})
  }
  try {
    if (failure === undefined) {
      const lifecycleEnvironment = { ...environment, WATERBOX_PROVIDER: "vercel", WATERBOX_SQLITE_PATH: join(directory, "lifecycle.sqlite") }
      await runVercelStopResumeSmoke(lifecycleEnvironment)
      await runVercelNativeLifecycleSmoke(lifecycleEnvironment)
    }
  } catch (error) {
    failure = error
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    try {
      const reconciliation = await reconcileVercelBaseline(environment, baseline)
      console.log(JSON.stringify({ stage: "baseline", exactSandboxes: reconciliation.exactSandboxes, exactActiveSnapshots: reconciliation.exactActiveSnapshots }))
      if (reconciliation.timedOut) failure ??= new Error("Vercel baseline reconciliation did not converge")
    } catch {
      failure ??= new Error("Vercel baseline reconciliation failed")
    }
  }
  if (failure !== undefined) throw new Error("Vercel MCP smoke failed; tracked cleanup or baseline reconciliation requires review")
  return { ok: true, flow: "vercel-mcp-smoke" }
}

/** Runs the optional lifecycle group through the configured embedded API. */
export async function runVercelStopResumeSmoke(environment: Environment): Promise<void> {
  const configured = parseLocalProviderConfiguration(environment)
  const backend = await createConfiguredEmbeddedApiBackend(configured, new URL("../packages/mcp/dist/waterbox-cli.js", import.meta.url))
  let sandboxId: string | undefined
  try {
    const signal = new AbortController().signal
    const created = SandboxSchema.parse(await responseJson(await backend.fetch(new Request(new URL("/v1/sandboxes", backend.origin), { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `vercel-lifecycle-${crypto.randomUUID()}` }, body: "{}", signal })), 201))
    sandboxId = created.sandboxId
    console.log(JSON.stringify({ stage: "stop-resume-created", running: created.state === "running" }))
    const stopped = SandboxSchema.parse(await responseJson(await backend.fetch(new Request(new URL(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/stop`, backend.origin), { method: "POST", signal })), 200))
    if (stopped.state !== "stopped") throw new Error("Vercel stop result was invalid")
    console.log(JSON.stringify({ stage: "stop-resume-stopped", stopped: true }))
    const resumed = SandboxSchema.parse(await responseJson(await backend.fetch(new Request(new URL(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/resume`, backend.origin), { method: "POST", signal })), 200))
    if (resumed.state !== "running") throw new Error("Vercel resume result was invalid")
    console.log(JSON.stringify({ stage: "stop-resume", stopped: true, resumed: true, automaticSnapshotCleanup: true }))
  } finally {
    if (sandboxId !== undefined) {
      try {
        const result = await backend.fetch(new Request(new URL(`/v1/sandboxes/${encodeURIComponent(sandboxId)}`, backend.origin), { method: "DELETE" }))
        if (result.status !== 200) throw new Error("Vercel lifecycle tracked deletion failed")
        console.log(JSON.stringify({ stage: "cleanup", lifecycleSandboxDeleted: true }))
      } catch { throw new Error("Vercel lifecycle tracked cleanup requires review") }
    }
    await backend.close().catch(() => {})
  }
}

/**
 * Exercises two adapter-only contracts which a Bash-worker integration cannot
 * establish: a caller-aborted native command is killed without a replay, and
 * the returned automatic stop snapshot is linked to the exact owned sandbox
 * before targeted cleanup accepts its tombstone.
 */
export async function runVercelNativeLifecycleSmoke(environment: Environment): Promise<void> {
  const configured = parseLocalProviderConfiguration(environment)
  if (configured.provider.kind !== "vercel") throw new Error("Vercel native smoke configuration was invalid")
  let commandPosts = 0, killPosts = 0
  const tracedFetch: VercelProviderFetch = async (input, init) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    if (request.method === "POST" && path.endsWith("/cmd")) commandPosts++
    if (request.method === "POST" && path.endsWith("/kill")) killPosts++
    return fetch(request)
  }
  const infrastructure = new VercelSandboxInfrastructure(configured.provider.config as VercelProviderConfig, { clock: new SystemVercelProviderClock(), fetch: tracedFetch })
  const signal = new AbortController().signal
  let providerRef: any
  let automaticSnapshotId: string | undefined
  const cleanupLedger: VercelNativeCleanupLedger = { deletion: "not_started" }
  try {
    const created = await infrastructure.create({ accountId: "local", sandboxId: "sbx_vercel-native-a1" as never, idempotencyKey: crypto.randomUUID(), signal })
    providerRef = created.providerRef

    const commandBefore = commandPosts
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(new DOMException("caller left", "AbortError")), 1_000)
    let callerAborted = false
    try {
      await infrastructure.runCommand({ accountId: "local", providerRef, script: "sleep 30", timeoutMs: 60_000, signal: abort.signal })
    } catch (error) {
      callerAborted = abort.signal.aborted && typeof error === "object" && error !== null && (error as { kind?: unknown }).kind === "ambiguous_execution"
    } finally { clearTimeout(timer) }
    const oneDispatch = commandPosts - commandBefore === 1
    // A successful small command after the aborted call proves the adapter
    // observed a bounded terminal provider state, without inspecting logs.
    const terminal = await infrastructure.runCommand({ accountId: "local", providerRef, script: "true", timeoutMs: 30_000, signal })
    const terminalAfterCancellation = terminal.exitCode === 0
    const killIssued = killPosts >= 1
    if (!callerAborted || !oneDispatch || !killIssued || !terminalAfterCancellation) throw new Error("Vercel native command cancellation contract was not proven")
    console.log(JSON.stringify({ stage: "native-command-cancellation", callerAborted, oneDispatch, killIssued, terminalAfterCancellation }))

    const stopped = await infrastructure.stopResume!.stop({ accountId: "local", providerRef, signal })
    providerRef = stopped.providerRef
    automaticSnapshotId = automaticSnapshot(providerRef)
    if (automaticSnapshotId === undefined) throw new Error("Vercel stop did not return a tracked automatic snapshot")
    const evidence = await automaticSnapshotEvidence(configured.provider.config as VercelProviderConfig, providerRef, automaticSnapshotId)
    if (!evidence.ownedCurrentLink || !evidence.automaticCreation) throw new Error("Vercel automatic snapshot ownership evidence was invalid")
    console.log(JSON.stringify({ stage: "automatic-stop-snapshot", tracked: true, ownedCurrentLink: evidence.ownedCurrentLink, automaticCreation: evidence.automaticCreation }))

    const resumed = await infrastructure.stopResume!.resume({ accountId: "local", providerRef, signal })
    providerRef = resumed.providerRef
    // Mark the mutation as dispatched before awaiting it. A transport loss
    // here may equally hide automatic-snapshot cleanup, so the finally path
    // must only reconcile exact reads and must never replay either mutation.
    cleanupLedger.deletion = "dispatched"
    const deletedSandbox = await infrastructure.delete({ accountId: "local", providerRef, signal })
    if (deletedSandbox.state !== "terminated") throw new Error("Vercel native sandbox deletion was not terminal")
    cleanupLedger.deletion = "terminal"
    const cleanup = await reconcileTrackedVercelNativeLifecycle(infrastructure, providerRef, automaticSnapshotId, cleanupLedger, signal)
    if (!cleanup.proven) throw new Error("Vercel automatic snapshot cleanup was not terminal")
    console.log(JSON.stringify({ stage: "automatic-snapshot-cleanup", cleanupExecuted: true, automaticCleanupTombstone: cleanup.snapshotTombstone }))
  } finally {
    if (providerRef !== undefined) {
      const cleanup = await reconcileTrackedVercelNativeLifecycle(infrastructure, providerRef, automaticSnapshotId, cleanupLedger, new AbortController().signal)
      if (!cleanup.proven) throw new Error("Vercel tracked cleanup is unresolved; exact manual cleanup is required")
    }
  }
}

export type VercelNativeCleanupLedger = { deletion: "not_started" | "dispatched" | "terminal" }
type VercelNativeCleanupAdapter = Pick<VercelSandboxInfrastructure, "delete" | "inspect" | "snapshots">

/**
 * Performs at most one tracked delete. Once it has been dispatched, including
 * when its automatic-snapshot substep may have been dispatched, this function
 * uses exact GET observations only. It deliberately has no snapshot DELETE.
 */
export async function reconcileTrackedVercelNativeLifecycle(
  infrastructure: VercelNativeCleanupAdapter,
  providerRef: any,
  automaticSnapshotId: string | undefined,
  ledger: VercelNativeCleanupLedger,
  signal: AbortSignal,
): Promise<{ proven: boolean; sandboxTombstone: boolean; snapshotTombstone: boolean; manualCleanupRequired: boolean }> {
  if (ledger.deletion === "not_started") {
    ledger.deletion = "dispatched"
    try {
      const deleted = await infrastructure.delete({ accountId: "local", providerRef, signal })
      if (deleted.state === "terminated") ledger.deletion = "terminal"
    } catch {
      // The request may have reached Vercel. Do not replay; exact reads below
      // are the only permitted reconciliation after this point.
    }
  }
  let sandboxTombstone = false, snapshotTombstone = automaticSnapshotId === undefined
  try { sandboxTombstone = (await infrastructure.inspect({ accountId: "local", providerRef, signal })).state === "terminated" } catch {}
  if (automaticSnapshotId !== undefined) {
    try { snapshotTombstone = (await infrastructure.snapshots!.inspect({ accountId: "local", snapshotId: "snap_vercel-auto-a1" as never, providerRef: automaticSnapshotRef(providerRef, automaticSnapshotId), signal })).state === "deleted" } catch {}
  }
  const proven = sandboxTombstone && snapshotTombstone
  if (proven) ledger.deletion = "terminal"
  return { proven, sandboxTombstone, snapshotTombstone, manualCleanupRequired: !proven }
}

async function automaticSnapshotEvidence(config: VercelProviderConfig, providerRef: any, snapshotId: string): Promise<{ ownedCurrentLink: boolean; automaticCreation: boolean }> {
  const sandbox = await exactVercelJson(config, `/v2/sandboxes/${encodeURIComponent(providerRef.name)}`, { projectId: config.projectId, teamId: config.teamId, resume: "false" })
  const snapshot = await exactVercelJson(config, `/v2/sandboxes/snapshots/${encodeURIComponent(snapshotId)}`, { teamId: config.teamId })
  const nativeSandbox = record(sandbox) && record(sandbox.sandbox) ? sandbox.sandbox : undefined
  const nativeSnapshot = record(snapshot) && record(snapshot.snapshot) ? snapshot.snapshot : snapshot
  return {
    ownedCurrentLink: record(nativeSandbox) && record(nativeSandbox.tags) && nativeSandbox.tags["waterbox-owner"] === providerRef.owner && nativeSandbox.tags["waterbox-account"] === providerRef.account && nativeSandbox.currentSnapshotId === snapshotId,
    automaticCreation: record(nativeSnapshot) && nativeSnapshot.creationMethod === "automatic",
  }
}

async function exactVercelJson(config: VercelProviderConfig, path: string, query: Record<string, string>): Promise<unknown> {
  const url = new URL(path, config.apiOrigin)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await fetch(url, { headers: { authorization: `Bearer ${config.token}`, accept: "application/json" }, signal: AbortSignal.timeout(config.polling.requestTimeoutMs) })
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("Vercel exact ownership read failed") }
  return boundedJson(response)
}

function automaticSnapshot(providerRef: any): string | undefined {
  return record(providerRef) && typeof providerRef.automaticSnapshotId === "string" ? providerRef.automaticSnapshotId : undefined
}
function automaticSnapshotRef(providerRef: any, id: string): Record<string, string> {
  if (!record(providerRef) || typeof providerRef.owner !== "string" || typeof providerRef.name !== "string") throw new Error("Vercel automatic snapshot reference was invalid")
  return { kind: "vercel-snapshot-v1", id, owner: providerRef.owner, sourceName: providerRef.name }
}

async function pages(origin: string, token: string, teamId: string, projectId: string, kind: "sandboxes" | "snapshots", fetch_: typeof fetch): Promise<Array<Record<string, unknown>>> {
  const path = kind === "sandboxes" ? "/v2/sandboxes" : "/v2/sandboxes/snapshots"
  const items: Array<Record<string, unknown>> = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(path, origin)
    url.searchParams.set("teamId", teamId); url.searchParams.set("project", projectId); url.searchParams.set("limit", "50")
    if (cursor !== undefined) url.searchParams.set("cursor", cursor)
    const response = await fetch_(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("Vercel baseline inventory failed") }
    const value = await boundedJson(response)
    if (!record(value) || !Array.isArray(value[kind]) || !record(value.pagination) || !Number.isSafeInteger(value.pagination.count) || (value.pagination.next !== null && typeof value.pagination.next !== "string")) throw new Error("Vercel baseline inventory was invalid")
    for (const item of value[kind]) if (record(item)) items.push(item)
    const next = value.pagination.next
    if (next === null) return items
    if (next === cursor) throw new Error("Vercel baseline pagination cycled")
    cursor = next
  }
  throw new Error("Vercel baseline pagination exceeded its bound")
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Vercel baseline response was empty")
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0, done = false
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) { done = true; break }
      size += item.value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error("Vercel baseline response exceeded its bound")
      chunks.push(item.value)
    }
  } finally { if (!done) await reader.cancel().catch(() => {}); reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
}

async function responseJson(response: Response, status: number): Promise<unknown> {
  if (response.status !== status) { const actual = response.status; await response.body?.cancel().catch(() => {}); throw new Error(`Embedded lifecycle request failed (${actual})`) }
  return boundedJson(response)
}
function equal(left: Set<string>, right: Set<string>): boolean { return left.size === right.size && [...left].every(value => right.has(value)) }
function required(value: string | undefined, key: string): string { if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required`); return value }
function positive(value: string | undefined, fallback: number): number { if (value === undefined) return fallback; const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error("Vercel smoke reconciliation configuration is invalid"); return number }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function stringEnvironment(environment: Environment): Record<string, string> { return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)) }

if (import.meta.main) runVercelMcpSmoke().then(result => console.log(JSON.stringify(result)), () => { console.error("Vercel MCP smoke failed; inspect sanitized local evidence and reconcile tracked resources"); process.exitCode = 1 })
