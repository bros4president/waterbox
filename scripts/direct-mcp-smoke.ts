import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SandboxSchema } from "../packages/sandbox-contracts/src/index.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const AUTHORIZATION = "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES"
const TOOL_NAMES = "create_sandbox,probe_sandbox,delete_sandbox,list_snapshots,create_snapshot,delete_snapshot,send_file_securely,read,write,edit,patch,glob,grep,bash"
const HEALTH = JSON.stringify({ ok: true, protocolVersion: 2, tools: ["read", "write", "edit", "patch", "glob", "grep", "bash"] })
const VERSION = JSON.stringify({ protocolVersion: 2 })

export interface BoxBaseline { ids: Set<string>; activeBoxes: number }
export interface BaselineReconciliation { visibleSetRestored: boolean; activeCountRestored: boolean; timedOut: boolean }
export interface ReconciliationOptions {
  pollIntervalMs: number
  pollTimeoutMs: number
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
}
interface DirectSmokeClient {
  listTools(): Promise<{ tools: Array<{ name: string }> }>
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<any>
}
interface ProductFlowOptions {
  localSecretPath: string
  sleep?: (milliseconds: number) => Promise<void>
  log?: (line: string) => void
  secrets?: string[]
}

export function assertDirectSmokeAuthorized(environment: Record<string, string | undefined>): void {
  if (environment.WATERBOX_MCP_EXPERIMENT_AUTHORIZATION !== AUTHORIZATION || environment.WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT !== "YES") throw new Error("The Direct MCP smoke requires explicit authorization for an isolated Box account")
}

export async function readBoxBaseline(baseUrl: string, apiKey: string, fetch_: typeof fetch = fetch): Promise<BoxBaseline> {
  const [limits, listed] = await Promise.all([boxJson(baseUrl, apiKey, "/limits", fetch_), boxJson(baseUrl, apiKey, "/boxes", fetch_)])
  if (limits?.ok !== true || limits?.type !== "limits.info" || limits.canStart !== true || !Number.isInteger(limits.activeBoxes) || !Number.isInteger(limits.maxActiveBoxes) || limits.activeBoxes + 1 > limits.maxActiveBoxes) throw new Error("Box account has no capacity for the Direct MCP smoke")
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

export async function runDirectMcpProductFlow(client: DirectSmokeClient, options: ProductFlowOptions): Promise<void> {
  const sleep = options.sleep ?? Bun.sleep
  const report = (stage: string, facts: Record<string, boolean | number>) => options.log?.(redact(JSON.stringify({ stage, ...facts }), options.secrets ?? []))
  let sandboxId: string | undefined
  let failure: unknown

  try {
    if ((await client.listTools()).tools.map((tool) => tool.name).join(",") !== TOOL_NAMES) throw new Error("Direct MCP returned an unexpected tool catalog")
    let created
    try {
      const result = await callTool(client, { name: "create_sandbox", arguments: { idempotencyKey: `direct-smoke-${crypto.randomUUID()}` } }, 180_000)
      if (result.isError) throw new Error("create failed")
      created = SandboxSchema.parse(JSON.parse(resultText(result)))
    } catch {
      throw new Error("Direct MCP create outcome is ambiguous; no public sandbox ID was returned and manual review is required")
    }
    sandboxId = created.sandboxId
    if (created.state !== "running" || created.sourceSnapshotId !== undefined) throw new Error("Direct MCP fresh sandbox was not running")
    const target = { sandboxId }
    if (SandboxSchema.parse(JSON.parse(resultText(await callTool(client, { name: "probe_sandbox", arguments: target })))).state !== "running") throw new Error("Direct MCP fresh sandbox probe was not running")
    const runtime = await successfulOutput(client, "bash", { ...target, command: "/usr/local/bin/waterbox health; /usr/local/bin/waterbox version", workdir: "/root" }, sleep)
    if (!runtime.includes(HEALTH) || !runtime.includes(VERSION)) throw new Error("Direct MCP current runtime verification failed")
    report("created", { running: true, runtimeCurrent: true })

    await verifySecureTransfer(client, target, options.localSecretPath, sleep)
    await verifyAsyncBash(client, target, sleep)
    let foregroundSettled = false
    const foreground = successfulOutput(client, "bash", { ...target, command: "touch /tmp/waterbox-concurrency-ready; sleep 12", description: "Hold one independent command", workdir: "/root", timeout: 15_000 }, sleep).finally(() => { foregroundSettled = true })
    const concurrent = successfulOutput(client, "bash", { ...target, command: "for attempt in $(seq 1 50); do test -f /tmp/waterbox-concurrency-ready && exit 0; sleep 0.1; done; exit 1", description: "Verify concurrent command dispatch", workdir: "/root", timeout: 10_000 }, sleep)
    if (await Promise.race([concurrent.then(() => false), sleep(7_000).then(() => true)])) throw new Error("Direct MCP provider serialized concurrent commands")
    if (foregroundSettled) throw new Error("Direct MCP foreground command completed before the concurrency assertion")
    await foreground
    report("concurrency", { independent: true })

    await successfulOutput(client, "write", { ...target, filePath: "/root/direct-smoke.txt", content: "Alpha\n" }, sleep)
    if (!(await successfulOutput(client, "read", { ...target, filePath: "/root/direct-smoke.txt" }, sleep)).includes("Alpha")) throw new Error("Direct MCP read assertion failed")
    await successfulOutput(client, "edit", { ...target, filePath: "/root/direct-smoke.txt", oldString: "Alpha", newString: "Beta" }, sleep)
    await successfulOutput(client, "patch", { ...target, patchText: "*** Begin Patch\n*** Add File: /root/direct-patched.txt\n+Patched\n*** End Patch" }, sleep)
    if (!(await successfulOutput(client, "glob", { ...target, pattern: "direct-*.txt", path: "/root" }, sleep)).includes("direct-smoke.txt")) throw new Error("Direct MCP glob assertion failed")
    if (!(await successfulOutput(client, "grep", { ...target, pattern: "Beta", path: "/root", include: "*.txt" }, sleep)).includes("direct-smoke.txt")) throw new Error("Direct MCP grep assertion failed")
    const bash = await successfulOutput(client, "bash", { ...target, command: "pwd; id -u; cat direct-smoke.txt", workdir: "/root" }, sleep)
    if (!bash.includes("/root") || !bash.includes("\n0\n") || !bash.includes("Beta")) throw new Error("Direct MCP bash assertion failed")
    report("flow", { tools: 7, secureTransfer: true, asyncBash: true })
  } catch (error) {
    failure = error
  } finally {
    if (sandboxId) {
      try {
        const deleted = SandboxSchema.parse(JSON.parse(resultText(await callTool(client, { name: "delete_sandbox", arguments: { sandboxId } }, 180_000))))
        if (deleted.sandboxId !== sandboxId || deleted.state !== "terminated") throw new Error("uncorrelated delete result")
        report("cleanup", { deleted: true })
      } catch {
        failure = failure ?? new Error("Direct MCP tracked cleanup requires manual review")
      }
    }
  }
  if (failure !== undefined) throw new Error(redact(failure instanceof Error ? failure.message : "Direct MCP smoke failed", options.secrets ?? []))
}

export async function runDirectMcpSmoke(environment: Record<string, string | undefined> = process.env) {
  assertDirectSmokeAuthorized(environment)
  const boxApiKey = environment.BOX_API_KEY
  if (!boxApiKey) throw new Error("The Direct MCP smoke requires Box credentials")
  const boxApiBaseUrl = (environment.BOX_API_BASE_URL ?? "https://ascii.dev/api/box/v1").replace(/\/$/, "")
  const reconciliation = {
    pollIntervalMs: positiveInteger(environment.WATERBOX_BOX_SMOKE_RECONCILIATION_INTERVAL_MS ?? "1000", "WATERBOX_BOX_SMOKE_RECONCILIATION_INTERVAL_MS"),
    pollTimeoutMs: positiveInteger(environment.WATERBOX_BOX_SMOKE_RECONCILIATION_TIMEOUT_MS ?? "120000", "WATERBOX_BOX_SMOKE_RECONCILIATION_TIMEOUT_MS"),
  }
  const baseline = await readBoxBaseline(boxApiBaseUrl, boxApiKey)
  const directory = await mkdtemp(join(tmpdir(), "waterbox-direct-mcp-"))
  const localSecretPath = join(directory, "local-secret.bin")
  await Bun.write(localSecretPath, new Uint8Array([0, 1, 2, 3, 255]))
  const transport = new StdioClientTransport({ command: "node", args: [resolve(import.meta.dir, "../packages/mcp/dist/waterbox.js")], env: stringEnvironment({ ...environment, WATERBOX_PROVIDER: "box", WATERBOX_SQLITE_PATH: join(directory, "direct.sqlite"), BOX_API_BASE_URL: boxApiBaseUrl, BOX_API_KEY: boxApiKey, WATERBOX_MCP_DIAGNOSTICS: "1" }), stderr: "inherit" })
  const client = new Client({ name: "waterbox-direct-smoke", version: "1" })
  let failure: unknown
  try {
    await client.connect(transport)
    await runDirectMcpProductFlow(client as DirectSmokeClient, { localSecretPath, secrets: [boxApiKey], log: console.log })
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
  if (failure !== undefined) throw new Error(redact(failure instanceof Error ? failure.message : "Direct MCP smoke failed", [boxApiKey]))
  return { ok: true as const, flow: "direct-mcp-smoke" }
}

async function verifySecureTransfer(client: DirectSmokeClient, target: { sandboxId: string }, localSecretPath: string, sleep: (milliseconds: number) => Promise<void>): Promise<void> {
  if ((JSON.parse(resultText(await callTool(client, { name: "send_file_securely", arguments: { ...target, sourcePath: localSecretPath, targetPath: "/root/direct-secret.bin" } }))) as { bytes?: unknown }).bytes !== 5) throw new Error("Direct MCP secure file transfer assertion failed")
  await successfulOutput(client, "bash", { ...target, command: "test -f /root/direct-secret.bin && test \"$(stat -c %a /root/direct-secret.bin)\" = 600 && test \"$(wc -c </root/direct-secret.bin)\" -eq 5", workdir: "/root" }, sleep)
}

async function verifyAsyncBash(client: DirectSmokeClient, target: { sandboxId: string }, sleep: (milliseconds: number) => Promise<void>): Promise<void> {
  const explicit = await successfulResult(client, "bash", { ...target, command: "printf explicit-completed", workdir: "/root", timeout: 120_000 })
  if (!completedBash(explicit) || explicit.output !== "explicit-completed") throw new Error("Direct MCP quick Bash with an execution timeout did not complete")

  const omitted = await successfulResult(client, "bash", { ...target, command: "printf omitted-completed", workdir: "/root" })
  if (!completedBash(omitted) || omitted.output !== "omitted-completed") throw new Error("Direct MCP quick Bash with an omitted timeout did not complete")

  const omittedSlow = await successfulResult(client, "bash", { ...target, command: "printf phase-one; sleep 20; printf phase-two", workdir: "/root" })
  if (!completedBash(omittedSlow) || !String(omittedSlow.output).includes("phase-one") || !String(omittedSlow.output).includes("phase-two")) throw new Error("Direct MCP omitted-timeout absorbed Bash assertion failed")

  const conservative = await successfulResult(client, "bash", { ...target, command: "sleep 20; printf conservative-completed", workdir: "/root", timeout: 120_000 })
  if (!completedBash(conservative) || !String(conservative.output).includes("conservative-completed")) throw new Error("Direct MCP conservative-timeout absorbed Bash assertion failed")

  const timed = await resultPayload(client, "bash", { ...target, command: "sleep 30", workdir: "/root", timeout: 2_000 })
  if (!completedBash(timed) || (timed.metadata as Record<string, unknown>).timedOut !== true) throw new Error("Direct MCP hard execution timeout did not settle as timed out")
  if (/job_[a-f0-9]{32}/.test(await successfulOutput(client, "glob", { ...target, pattern: "job_*", path: "/run/waterbox/bash-jobs" }, sleep))) throw new Error("Direct MCP completed Bash leaked a job directory")
}

function completedBash(value: Record<string, unknown>): boolean {
  const metadata = value.metadata
  return !!metadata && typeof metadata === "object" && !Array.isArray(metadata) && !("jobId" in metadata) && (typeof (metadata as Record<string, unknown>).exitCode === "number" || (metadata as Record<string, unknown>).exitCode === null)
}
async function successfulOutput(client: DirectSmokeClient, name: string, arguments_: Record<string, unknown>, sleep: (milliseconds: number) => Promise<void>): Promise<string> {
  const payload = await successfulResult(client, name, arguments_)
  if (typeof payload.output !== "string") throw new Error(`Direct MCP ${name} returned an invalid result`)
  await sleep(500)
  return payload.output
}

async function successfulResult(client: DirectSmokeClient, name: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callTool(client, { name, arguments: arguments_ })
  if (result.isError) throw new Error(`Direct MCP ${name} failed`)
  return resultPayloadFrom(result, name)
}

async function resultPayload(client: DirectSmokeClient, name: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
  return resultPayloadFrom(await callTool(client, { name, arguments: arguments_ }), name)
}

function resultPayloadFrom(result: any, name: string): Record<string, unknown> {
  const payload = result.structuredContent ?? JSON.parse(resultText(result))
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`Direct MCP ${name} returned an invalid result`)
  return payload as Record<string, unknown>
}

async function callTool(client: DirectSmokeClient, request: { name: string; arguments?: Record<string, unknown> }, timeoutMs = 60_000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      client.callTool(request),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Direct MCP ${request.name} timed out`)), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) throw new Error("Direct MCP returned invalid content")
  const content = (result as { content: unknown[] }).content
  const item = content.length === 1 ? content[0] : undefined
  if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "text" || typeof (item as { text?: unknown }).text !== "string") throw new Error("Direct MCP returned invalid text content")
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

if (import.meta.main) runDirectMcpSmoke().then((result) => console.log(JSON.stringify(result)), (error) => { console.error(redact(error instanceof Error ? error.message : "Direct MCP smoke failed", [process.env.BOX_API_KEY ?? ""])); process.exitCode = 1 })
