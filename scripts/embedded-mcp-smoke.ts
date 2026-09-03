import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SandboxIdSchema, SandboxSchema, SnapshotIdSchema, SnapshotPageSchema, SnapshotSchema, type SandboxId, type SnapshotId } from "../packages/sandbox-contracts/src/index.ts"
import { parseAutomaticStopDuration } from "../packages/control-plane-local/src/index.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const AUTHORIZATION = "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES"
const TOOL_NAMES = "create_sandbox,probe_sandbox,stop_sandbox,delete_sandbox,list_snapshots,create_snapshot,delete_snapshot,send_file_securely,read,write,edit,patch,glob,grep,bash"
const HEALTH = JSON.stringify({ ok: true, protocolVersion: 2, tools: ["read", "write", "edit", "patch", "glob", "grep", "bash"] })
const VERSION = JSON.stringify({ protocolVersion: 2 })
const SNAPSHOT_POLL_ATTEMPTS = 180

export interface BoxBaseline { ids: Set<string>; activeBoxes: number }
export interface BaselineReconciliation { visibleSetRestored: boolean; activeCountRestored: boolean; timedOut: boolean }
export interface ReconciliationOptions {
  pollIntervalMs: number
  pollTimeoutMs: number
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
}
export interface EmbeddedSmokeClient {
  listTools(): Promise<{ tools: Array<{ name: string }> }>
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<any>
}
export interface McpRuntimeLayout {
  workdir: string
  markerPath: string
  runtimeLauncher: string
  staleRuntimeCommand: string
  restoredRuntimeCheck: string
}
export interface ProductFlowOptions {
  localSecretPath: string
  automaticStopMs: number
  automaticStopGraceMs?: number
  automaticStopPollIntervalMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  log?: (line: string) => void
  secrets?: string[]
  runtime?: McpRuntimeLayout
}

const BOX_RUNTIME_LAYOUT: McpRuntimeLayout = {
  workdir: "/home/user/workspace",
  markerPath: "waterbox-embedded-marker",
  runtimeLauncher: "/usr/local/bin/waterbox",
  staleRuntimeCommand: "sudo -n rm -f /usr/local/lib/waterbox-cli.js",
  restoredRuntimeCheck: "test -s /usr/local/lib/waterbox-cli.js && test -f /usr/local/lib/waterbox-bootstrap.json",
}

export function assertEmbeddedSmokeAuthorized(environment: Record<string, string | undefined>): void {
  if (environment.WATERBOX_MCP_EXPERIMENT_AUTHORIZATION !== AUTHORIZATION || environment.WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT !== "YES") throw new Error("The Embedded MCP smoke requires explicit authorization for an isolated Box account")
}

export async function readBoxBaseline(baseUrl: string, apiKey: string, fetch_: typeof fetch = fetch): Promise<BoxBaseline> {
  const [limits, listed] = await Promise.all([boxJson(baseUrl, apiKey, "/limits", fetch_), boxJson(baseUrl, apiKey, "/boxes", fetch_)])
  if (limits?.ok !== true || limits?.type !== "limits.info" || limits.canStart !== true || !Number.isInteger(limits.activeBoxes) || !Number.isInteger(limits.maxActiveBoxes) || limits.activeBoxes + 2 > limits.maxActiveBoxes) throw new Error("Box account has no capacity for the Embedded MCP smoke")
  if (listed?.ok !== true || listed?.type !== "box.list" || !Array.isArray(listed.boxes) || !listed.boxes.every((item: any) => typeof item?.id === "string")) throw new Error("Box preflight returned an invalid response")
  return { ids: new Set(listed.boxes.map((item: any) => item.id)), activeBoxes: limits.activeBoxes }
}

export async function compareBoxBaseline(baseUrl: string, apiKey: string, baseline: BoxBaseline, fetch_: typeof fetch = fetch): Promise<{ exactIds: boolean; activeBoxes: number }> {
  const [limits, listed] = await Promise.all([boxJson(baseUrl, apiKey, "/limits", fetch_), boxJson(baseUrl, apiKey, "/boxes", fetch_)])
  if (!Number.isInteger(limits?.activeBoxes) || listed?.ok !== true || listed?.type !== "box.list" || !Array.isArray(listed.boxes) || !listed.boxes.every((item: any) => typeof item?.id === "string")) throw new Error("Box reconciliation returned an invalid response")
  const ids = new Set<string>(listed.boxes.map((item: any) => item.id))
  return { exactIds: ids.size === baseline.ids.size && [...ids].every((id) => baseline.ids.has(id)), activeBoxes: limits.activeBoxes }
}

export async function reconcileBoxBaseline(baseUrl: string, apiKey: string, baseline: BoxBaseline, options: ReconciliationOptions, fetch_: typeof fetch = fetch): Promise<BaselineReconciliation> {
  const deadline = (options.now ?? Date.now)() + options.pollTimeoutMs
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? Bun.sleep
  while (true) {
    const comparison = await compareBoxBaseline(baseUrl, apiKey, baseline, fetch_)
    const result = { visibleSetRestored: comparison.exactIds, activeCountRestored: comparison.activeBoxes === baseline.activeBoxes, timedOut: false }
    if (result.visibleSetRestored && result.activeCountRestored) return result
    if (now() >= deadline) return { ...result, timedOut: true }
    await sleep(options.pollIntervalMs)
  }
}

export function baselineReconciliationError(result: BaselineReconciliation): Error {
  return new Error(`Box baseline reconciliation did not converge: ${[!result.visibleSetRestored && "visible-set restoration", !result.activeCountRestored && "active-count restoration"].filter(Boolean).join(", ")}`)
}

export async function runEmbeddedMcpProductFlow(client: EmbeddedSmokeClient, options: ProductFlowOptions): Promise<void> {
  const sleep = options.sleep ?? Bun.sleep
  const now = options.now ?? Date.now
  const runtime = options.runtime ?? BOX_RUNTIME_LAYOUT
  const report = (stage: string, facts: Record<string, boolean | number>) => options.log?.(redact(JSON.stringify({ stage, ...facts }), options.secrets ?? []))
  let sandboxId: SandboxId | undefined, snapshotId: SnapshotId | undefined, restoredSandboxId: SandboxId | undefined, marker: string | undefined
  let failure: unknown

  try {
    if ((await client.listTools()).tools.map((tool) => tool.name).join(",") !== TOOL_NAMES) throw new Error("Embedded MCP returned an unexpected tool catalog")
    let created
    try {
      const result = await callTool(client, { name: "create_sandbox", arguments: { idempotencyKey: `embedded-smoke-${crypto.randomUUID()}` } }, 180_000)
      if (result.isError) { trackRecoverySandbox(result, (id) => { sandboxId = id }); throw new Error("create failed") }
      created = trackedSandbox(result, (id) => { sandboxId = id })
    } catch {
      if (sandboxId !== undefined) throw new Error("Embedded MCP create failed after returning a tracked recovery sandbox")
      throw new Error("Embedded MCP create outcome is ambiguous; no public sandbox ID was returned and manual review is required")
    }
    sandboxId = created.sandboxId
    if (created.state !== "running" || created.sourceSnapshotId !== undefined) throw new Error("Embedded MCP fresh sandbox was not running")
    const target = { sandboxId }
    if (SandboxSchema.parse(JSON.parse(resultText(await callTool(client, { name: "probe_sandbox", arguments: target })))).state !== "running") throw new Error("Embedded MCP fresh sandbox probe was not running")
    const runtimeHealth = await successfulOutput(client, "bash", { ...target, command: `${runtime.runtimeLauncher} health; ${runtime.runtimeLauncher} version`, workdir: runtime.workdir }, sleep)
    if (!runtimeHealth.includes(HEALTH) || !runtimeHealth.includes(VERSION)) throw new Error("Embedded MCP current runtime verification failed")
    report("created", { running: true, runtimeCurrent: true })

    const explicitlyStopped = trackedSandbox(await callTool(client, { name: "stop_sandbox", arguments: target }, 180_000))
    if (explicitlyStopped.state !== "stopped") throw new Error("Embedded MCP explicit stop was not resumable")
    report("explicit-stop", { stopped: true, resumable: true })
    const explicitResumeOutput = await successfulOutput(client, "bash", { ...target, command: "printf explicit-stop-resumed" }, sleep)
    if (explicitResumeOutput !== "explicit-stop-resumed") throw new Error("Embedded MCP ordinary tool did not resume an explicitly stopped sandbox")
    report("explicit-stop-ordinary-resume", { resumed: true, logicalToolDispatches: 1 })

    await verifySecureTransfer(client, target, options.localSecretPath, runtime, sleep)
    await verifyAsyncBash(client, target, runtime, sleep)
    let foregroundSettled = false
    const foreground = successfulOutput(client, "bash", { ...target, command: "touch /tmp/waterbox-concurrency-ready; sleep 12", description: "Hold one independent command", workdir: runtime.workdir, timeout: 15_000 }, sleep).finally(() => { foregroundSettled = true })
    const concurrent = successfulOutput(client, "bash", { ...target, command: "for attempt in $(seq 1 50); do test -f /tmp/waterbox-concurrency-ready && exit 0; sleep 0.1; done; exit 1", description: "Verify concurrent command dispatch", workdir: runtime.workdir, timeout: 10_000 }, sleep)
    if (await Promise.race([concurrent.then(() => false), sleep(7_000).then(() => true)])) throw new Error("Embedded MCP provider serialized concurrent commands")
    if (foregroundSettled) throw new Error("Embedded MCP foreground command completed before the concurrency assertion")
    await foreground
    report("concurrency", { independent: true })

    await successfulOutput(client, "write", { ...target, filePath: `${runtime.workdir}/embedded-smoke.txt`, content: "Alpha\n" }, sleep)
    if (!(await successfulOutput(client, "read", { ...target, filePath: `${runtime.workdir}/embedded-smoke.txt` }, sleep)).includes("Alpha")) throw new Error("Embedded MCP read assertion failed")
    await successfulOutput(client, "edit", { ...target, filePath: `${runtime.workdir}/embedded-smoke.txt`, oldString: "Alpha", newString: "Beta" }, sleep)
    await successfulOutput(client, "patch", { ...target, patchText: `*** Begin Patch\n*** Add File: ${runtime.workdir}/embedded-patched.txt\n+Patched\n*** End Patch` }, sleep)
    if (!(await successfulOutput(client, "glob", { ...target, pattern: "embedded-*.txt", path: runtime.workdir }, sleep)).includes("embedded-smoke.txt")) throw new Error("Embedded MCP glob assertion failed")
    if (!(await successfulOutput(client, "grep", { ...target, pattern: "Beta", path: runtime.workdir, include: "*.txt" }, sleep)).includes("embedded-smoke.txt")) throw new Error("Embedded MCP grep assertion failed")
    const bash = await successfulOutput(client, "bash", { ...target, command: "pwd; id -u; cat embedded-smoke.txt", workdir: runtime.workdir }, sleep)
    if (!bash.includes(runtime.workdir) || !/\n\d+\n/.test(bash) || !bash.includes("Beta")) throw new Error("Embedded MCP bash assertion failed")
    report("flow", { tools: 7, secureTransfer: true, asyncBash: true })

    marker = `waterbox-embedded-marker-${crypto.randomUUID()}`
    await successfulOutput(client, "write", { ...target, filePath: runtime.markerPath, content: marker }, sleep)
    // This command is already executing through the healthy CLI; removing its installed artifact
    // makes the inherited snapshot incomplete without touching the user marker or user data.
    await successfulOutput(client, "bash", { ...target, command: runtime.staleRuntimeCommand, workdir: runtime.workdir }, sleep)
    let snapshot
    try {
      const result = await callTool(client, { name: "create_snapshot", arguments: { sandboxId } }, 180_000)
      if (result.isError) throw new Error("create failed")
      snapshot = trackedSnapshot(result, (id) => { snapshotId = id })
    } catch {
      throw new Error("Embedded MCP snapshot creation failed")
    }
    snapshotId = snapshot.snapshotId
    await waitForSnapshotReady(client, snapshotId, sleep)
    report("snapshot", { ready: true })

    let restored
    try {
      const result = await callTool(client, { name: "create_sandbox", arguments: { sourceSnapshotId: snapshotId, idempotencyKey: `embedded-smoke-restore-${crypto.randomUUID()}` } }, 180_000)
      if (result.isError) { trackRecoverySandbox(result, (id) => { restoredSandboxId = id }); throw new Error("create failed") }
      restored = trackedSandbox(result, (id) => { restoredSandboxId = id })
    } catch {
      if (restoredSandboxId !== undefined) throw new Error("Embedded MCP restored creation failed after returning a tracked recovery sandbox")
      throw new Error("Embedded MCP restored sandbox creation failed")
    }
    restoredSandboxId = restored.sandboxId
    if (restored.state !== "running" || restored.sourceSnapshotId !== snapshotId) throw new Error("Embedded MCP restored sandbox was not running from its tracked snapshot")
    const restoredTarget = { sandboxId: restoredSandboxId }
    if (SandboxSchema.parse(JSON.parse(resultText(await callTool(client, { name: "probe_sandbox", arguments: restoredTarget })))).state !== "running") throw new Error("Embedded MCP restored sandbox probe was not running")
    report("restored", { running: true })
    if ((await successfulOutput(client, "read", { ...restoredTarget, filePath: runtime.markerPath }, sleep)) !== marker) throw new Error("Embedded MCP restored user data verification failed")
    const relativeMarker = await successfulOutput(client, "bash", { ...restoredTarget, command: `pwd; cat -- ${runtime.markerPath}` }, sleep)
    if (!relativeMarker.includes(`${runtime.workdir}\n`) || !relativeMarker.endsWith(marker)) throw new Error("Embedded MCP restored default workspace verification failed")
    report("restored-user-data", { preserved: true, relativePath: true, defaultCommandWorkspace: true })
    const restoredRuntime = await successfulOutput(client, "bash", { ...restoredTarget, command: `${runtime.runtimeLauncher} health; ${runtime.runtimeLauncher} version; ${runtime.restoredRuntimeCheck}`, workdir: runtime.workdir }, sleep)
    if (!restoredRuntime.includes(HEALTH) || !restoredRuntime.includes(VERSION)) throw new Error("Embedded MCP restored runtime verification failed")
    report("restored-runtime", { reinstalled: true, current: true })

    const beforeAutomaticStop = trackedSandbox(await callTool(client, { name: "probe_sandbox", arguments: restoredTarget }))
    if (beforeAutomaticStop.state === "terminated" || beforeAutomaticStop.state === "failed") throw new Error("Embedded MCP restored sandbox was not resumable before automatic-stop observation")
    const armedOutput = await successfulOutput(client, "bash", { ...restoredTarget, command: "printf automatic-stop-armed" }, sleep)
    if (armedOutput !== "automatic-stop-armed") throw new Error("Embedded MCP could not arm automatic-stop observation from running compute")
    report("automatic-stop-armed", { running: true, logicalToolDispatches: 1 })

    await waitForAutomaticStop(client, restoredTarget, {
      automaticStopMs: options.automaticStopMs,
      graceMs: options.automaticStopGraceMs ?? 120_000,
      pollIntervalMs: options.automaticStopPollIntervalMs ?? 1_000,
      now,
      sleep,
    })
    report("automatic-stop", { stopped: true, resumable: true })
    const automaticResumeOutput = await successfulOutput(client, "bash", { ...restoredTarget, command: "printf automatic-stop-resumed" }, sleep)
    if (automaticResumeOutput !== "automatic-stop-resumed") throw new Error("Embedded MCP ordinary tool did not resume an automatically stopped sandbox")
    report("automatic-stop-ordinary-resume", { resumed: true, logicalToolDispatches: 1 })
  } catch (error) {
    failure = error
  } finally {
    const cleanupFailures: string[] = []
    if (restoredSandboxId) await deleteTrackedSandbox(client, restoredSandboxId, report).catch(() => cleanupFailures.push("restored sandbox"))
    if (snapshotId) await deleteTrackedSnapshot(client, snapshotId, report).catch(() => cleanupFailures.push("snapshot"))
    if (sandboxId) await deleteTrackedSandbox(client, sandboxId, report).catch(() => cleanupFailures.push("source sandbox"))
    if (cleanupFailures.length) failure = failure === undefined ? new Error("Embedded MCP tracked cleanup requires manual review") : new Error(`${failure instanceof Error ? failure.message : "Embedded MCP smoke failed"}; tracked cleanup requires manual review`)
  }
  if (failure !== undefined) throw new Error(redact(failure instanceof Error ? failure.message : "Embedded MCP smoke failed", [...(options.secrets ?? []), sandboxId ?? "", snapshotId ?? "", restoredSandboxId ?? "", marker ?? ""]))
}

async function waitForAutomaticStop(
  client: EmbeddedSmokeClient,
  target: { sandboxId: SandboxId },
  options: { automaticStopMs: number; graceMs: number; pollIntervalMs: number; now: () => number; sleep: (milliseconds: number) => Promise<void> },
): Promise<void> {
  if (!Number.isSafeInteger(options.automaticStopMs) || options.automaticStopMs <= 0 || !Number.isSafeInteger(options.graceMs) || options.graceMs < 0 || !Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) throw new Error("Embedded MCP automatic-stop timing is invalid")
  const deadline = options.now() + options.automaticStopMs + options.graceMs
  while (true) {
    const observed = trackedSandbox(await callTool(client, { name: "probe_sandbox", arguments: target }))
    if (observed.state === "stopped") return
    if (observed.state === "terminated" || observed.state === "failed") throw new Error("Embedded MCP automatic stop did not preserve resumable sandbox state")
    if (options.now() >= deadline) throw new Error("Embedded MCP automatic stop observation timed out")
    await options.sleep(options.pollIntervalMs)
  }
}

function trackedSandbox(result: unknown, track?: (id: SandboxId) => void) {
  const value = JSON.parse(resultText(result))
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = SandboxIdSchema.safeParse((value as { sandboxId?: unknown }).sandboxId)
    if (candidate.success) track?.(candidate.data)
  }
  return SandboxSchema.parse(value)
}

function trackedSnapshot(result: unknown, track?: (id: SnapshotId) => void) {
  const value = JSON.parse(resultText(result))
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = SnapshotIdSchema.safeParse((value as { snapshotId?: unknown }).snapshotId)
    if (candidate.success) track?.(candidate.data)
  }
  return SnapshotSchema.parse(value)
}

function trackRecoverySandbox(result: unknown, track: (id: SandboxId) => void): void {
  let message: string
  try { message = resultText(result) } catch { return }
  const matches = [...message.matchAll(/(?:^|\s)Recovery sandbox: (sbx_[a-z]+-[a-z]+-[a-z0-9]+)\.(?=\s|$)/g)]
  if (matches.length !== 1) return
  const candidate = SandboxIdSchema.safeParse(matches[0]![1])
  if (candidate.success) track(candidate.data)
}

async function waitForSnapshotReady(client: EmbeddedSmokeClient, snapshotId: string, sleep: (milliseconds: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < SNAPSHOT_POLL_ATTEMPTS; attempt++) {
    const snapshot = await findTrackedSnapshot(client, snapshotId)
    if (snapshot?.state === "ready") return
    if (snapshot?.state === "failed" || snapshot?.state === "deleted") throw new Error("Embedded MCP tracked snapshot entered a terminal state")
    await sleep(1_000)
  }
  throw new Error("Embedded MCP snapshot readiness timed out")
}

async function findTrackedSnapshot(client: EmbeddedSmokeClient, snapshotId: string) {
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const result = await callTool(client, { name: "list_snapshots", arguments: { limit: 100, ...(cursor === undefined ? {} : { cursor }) } })
    if (result.isError) throw new Error("Embedded MCP snapshot readiness check failed")
    const page = SnapshotPageSchema.parse(JSON.parse(resultText(result)))
    const snapshot = page.items.find((item) => item.snapshotId === snapshotId)
    if (snapshot) return snapshot
    if (!page.nextCursor) return undefined
    cursor = page.nextCursor
  }
  throw new Error("Embedded MCP snapshot readiness listing exceeded its safety bound")
}

async function deleteTrackedSandbox(client: EmbeddedSmokeClient, sandboxId: string, report: (stage: string, facts: Record<string, boolean | number>) => void): Promise<void> {
  const deleted = SandboxSchema.parse(JSON.parse(resultText(await callTool(client, { name: "delete_sandbox", arguments: { sandboxId } }, 180_000))))
  if (deleted.sandboxId !== sandboxId || deleted.state !== "terminated") throw new Error("uncorrelated delete result")
  report("cleanup", { sandboxDeleted: true })
}

async function deleteTrackedSnapshot(client: EmbeddedSmokeClient, snapshotId: string, report: (stage: string, facts: Record<string, boolean | number>) => void): Promise<void> {
  const deleted = SnapshotSchema.parse(JSON.parse(resultText(await callTool(client, { name: "delete_snapshot", arguments: { snapshotId } }, 180_000))))
  if (deleted.snapshotId !== snapshotId || deleted.state !== "deleted") throw new Error("uncorrelated delete result")
  report("cleanup", { snapshotDeleted: true })
}

export async function runEmbeddedMcpSmoke(environment: Record<string, string | undefined> = process.env) {
  assertEmbeddedSmokeAuthorized(environment)
  const automaticStopMs = parseAutomaticStopDuration(environment.WATERBOX_AUTO_STOP)
  if (automaticStopMs === undefined) throw new Error("The Embedded MCP smoke requires WATERBOX_AUTO_STOP")
  const boxApiKey = environment.BOX_API_KEY
  if (!boxApiKey) throw new Error("The Embedded MCP smoke requires Box credentials")
  const boxApiBaseUrl = (environment.BOX_API_BASE_URL ?? "https://ascii.dev/api/box/v1").replace(/\/$/, "")
  const reconciliation = {
    pollIntervalMs: positiveInteger(environment.WATERBOX_BOX_SMOKE_RECONCILIATION_INTERVAL_MS ?? "1000", "WATERBOX_BOX_SMOKE_RECONCILIATION_INTERVAL_MS"),
    pollTimeoutMs: positiveInteger(environment.WATERBOX_BOX_SMOKE_RECONCILIATION_TIMEOUT_MS ?? "120000", "WATERBOX_BOX_SMOKE_RECONCILIATION_TIMEOUT_MS"),
  }
  const baseline = await readBoxBaseline(boxApiBaseUrl, boxApiKey)
  const directory = await mkdtemp(join(tmpdir(), "waterbox-embedded-mcp-"))
  const localSecretPath = join(directory, "local-secret.bin")
  await Bun.write(localSecretPath, new Uint8Array([0, 1, 2, 3, 255]))
  const transport = new StdioClientTransport({ command: "node", args: [resolve(import.meta.dir, "../packages/mcp/dist/waterbox.js")], env: stringEnvironment({ ...environment, WATERBOX_PROVIDER: "box", WATERBOX_SQLITE_PATH: join(directory, "embedded.sqlite"), BOX_API_BASE_URL: boxApiBaseUrl, BOX_API_KEY: boxApiKey, WATERBOX_MCP_DIAGNOSTICS: "1" }), stderr: "inherit" })
  const client = new Client({ name: "waterbox-embedded-smoke", version: "1" })
  let failure: unknown
  try {
    await client.connect(transport)
    await runEmbeddedMcpProductFlow(client as EmbeddedSmokeClient, { localSecretPath, automaticStopMs, secrets: [boxApiKey], log: console.log })
  } catch (error) {
    failure = error
  } finally {
    await client.close().catch(() => {})
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    try {
      const result = await reconcileBoxBaseline(boxApiBaseUrl, boxApiKey, baseline, reconciliation)
      console.log(JSON.stringify({ stage: "baseline", visibleSetRestored: result.visibleSetRestored, activeCountRestored: result.activeCountRestored }))
      if (result.timedOut) failure = failure ?? baselineReconciliationError(result)
    } catch {
      failure = failure ?? new Error("Box baseline reconciliation failed")
    }
  }
  if (failure !== undefined) throw new Error(redact(failure instanceof Error ? failure.message : "Embedded MCP smoke failed", [boxApiKey]))
  return { ok: true as const, flow: "embedded-mcp-smoke" }
}

async function verifySecureTransfer(client: EmbeddedSmokeClient, target: { sandboxId: string }, localSecretPath: string, runtime: McpRuntimeLayout, sleep: (milliseconds: number) => Promise<void>): Promise<void> {
  const targetPath = `${runtime.workdir}/embedded-secret.bin`
  if ((JSON.parse(resultText(await callTool(client, { name: "send_file_securely", arguments: { ...target, sourcePath: localSecretPath, targetPath } }))) as { bytes?: unknown }).bytes !== 5) throw new Error("Embedded MCP secure file transfer assertion failed")
  await successfulOutput(client, "bash", { ...target, command: `test -f ${targetPath} && test \"$(stat -c %a ${targetPath})\" = 600 && test \"$(wc -c <${targetPath})\" -eq 5`, workdir: runtime.workdir }, sleep)
}

async function verifyAsyncBash(client: EmbeddedSmokeClient, target: { sandboxId: string }, runtime: McpRuntimeLayout, sleep: (milliseconds: number) => Promise<void>): Promise<void> {
  const explicit = await successfulResult(client, "bash", { ...target, command: "printf explicit-completed", workdir: runtime.workdir, timeout: 120_000 })
  if (!completedBash(explicit) || explicit.output !== "explicit-completed") throw new Error("Embedded MCP quick Bash with an execution timeout did not complete")

  const omitted = await successfulResult(client, "bash", { ...target, command: "printf omitted-completed", workdir: runtime.workdir })
  if (!completedBash(omitted) || omitted.output !== "omitted-completed") throw new Error("Embedded MCP quick Bash with an omitted timeout did not complete")

  const omittedSlow = await successfulResult(client, "bash", { ...target, command: "printf phase-one; sleep 20; printf phase-two", workdir: runtime.workdir })
  if (!completedBash(omittedSlow) || !String(omittedSlow.output).includes("phase-one") || !String(omittedSlow.output).includes("phase-two")) throw new Error("Embedded MCP omitted-timeout absorbed Bash assertion failed")

  const conservative = await successfulResult(client, "bash", { ...target, command: "sleep 20; printf conservative-completed", workdir: runtime.workdir, timeout: 120_000 })
  if (!completedBash(conservative) || !String(conservative.output).includes("conservative-completed")) throw new Error("Embedded MCP conservative-timeout absorbed Bash assertion failed")

  const timed = await resultPayload(client, "bash", { ...target, command: "sleep 30", workdir: runtime.workdir, timeout: 2_000 })
  if (!completedBash(timed) || (timed.metadata as Record<string, unknown>).timedOut !== true) throw new Error("Embedded MCP hard execution timeout did not settle as timed out")
  if (/job_[a-f0-9]{32}/.test(await successfulOutput(client, "glob", { ...target, pattern: "job_*", path: "/run/waterbox/bash-jobs" }, sleep))) throw new Error("Embedded MCP completed Bash leaked a job directory")
}

function completedBash(value: Record<string, unknown>): boolean {
  const metadata = value.metadata
  return !!metadata && typeof metadata === "object" && !Array.isArray(metadata) && !("jobId" in metadata) && (typeof (metadata as Record<string, unknown>).exitCode === "number" || (metadata as Record<string, unknown>).exitCode === null)
}
async function successfulOutput(client: EmbeddedSmokeClient, name: string, arguments_: Record<string, unknown>, sleep: (milliseconds: number) => Promise<void>): Promise<string> {
  const payload = await successfulResult(client, name, arguments_)
  if (typeof payload.output !== "string") throw new Error(`Embedded MCP ${name} returned an invalid result`)
  await sleep(500)
  return payload.output
}

async function successfulResult(client: EmbeddedSmokeClient, name: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callTool(client, { name, arguments: arguments_ })
  if (result.isError) throw new Error(`Embedded MCP ${name} failed`)
  return resultPayloadFrom(result, name)
}

async function resultPayload(client: EmbeddedSmokeClient, name: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
  return resultPayloadFrom(await callTool(client, { name, arguments: arguments_ }), name)
}

function resultPayloadFrom(result: any, name: string): Record<string, unknown> {
  const payload = result.structuredContent ?? JSON.parse(resultText(result))
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`Embedded MCP ${name} returned an invalid result`)
  return payload as Record<string, unknown>
}

async function callTool(client: EmbeddedSmokeClient, request: { name: string; arguments?: Record<string, unknown> }, timeoutMs = 60_000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      client.callTool(request),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Embedded MCP ${request.name} timed out`)), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) throw new Error("Embedded MCP returned invalid content")
  const content = (result as { content: unknown[] }).content
  const item = content.length === 1 ? content[0] : undefined
  if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "text" || typeof (item as { text?: unknown }).text !== "string") throw new Error("Embedded MCP returned invalid text content")
  return (item as { text: string }).text
}

async function boxJson(baseUrl: string, apiKey: string, path: string, fetch_: typeof fetch): Promise<any> {
  const response = await fetch_(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error("Box read-only request failed")
  }
  return response.json()
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((value, secret) => secret ? value.replaceAll(secret, "[REDACTED]") : value, text)
}

function stringEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`)
  return number
}

if (import.meta.main) runEmbeddedMcpSmoke().then((result) => console.log(JSON.stringify(result)), (error) => { console.error(redact(error instanceof Error ? error.message : "Embedded MCP smoke failed", [process.env.BOX_API_KEY ?? ""])); process.exitCode = 1 })
