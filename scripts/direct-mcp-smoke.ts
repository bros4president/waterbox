import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SandboxSchema, SnapshotPageSchema, SnapshotSchema } from "../packages/sandbox-contracts/src/index.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { collectCliDiagnostics, emergencyCleanup, preflight } from "./control-plane-mcp-experiment.ts"

const AUTHORIZATION = "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES"

export function assertDirectSmokeAuthorized(environment: Record<string, string | undefined>): void {
  if (environment.WATERBOX_MCP_EXPERIMENT_AUTHORIZATION !== AUTHORIZATION || environment.WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT !== "YES") {
    throw new Error("The Direct MCP smoke requires explicit authorization for an isolated Box account")
  }
}

export async function runDirectMcpSmoke(environment: Record<string, string | undefined> = process.env) {
  assertDirectSmokeAuthorized(environment)
  const boxApiKey = environment.BOX_API_KEY
  if (!boxApiKey) throw new Error("The Direct MCP smoke requires Box credentials")
  const boxApiBaseUrl = environment.BOX_API_BASE_URL ?? "https://ascii.dev/api/box/v1"
  const templateRef = environment.BOX_SYSTEM_TEMPLATE_REF ?? "waterbox-system-v6"
  const baseline = await preflight(boxApiBaseUrl, boxApiKey, templateRef)
  const directory = await mkdtemp(join(tmpdir(), "waterbox-direct-mcp-"))
  const entry = resolve(import.meta.dir, "../packages/mcp/dist/waterbox-mcp.js")
  const childEnvironment = stringEnvironment({
    ...environment,
    WATERBOX_PROVIDER: "box",
    WATERBOX_SQLITE_PATH: join(directory, "direct.sqlite"),
    BOX_API_BASE_URL: boxApiBaseUrl,
    BOX_API_KEY: boxApiKey,
    BOX_SYSTEM_TEMPLATE_REF: templateRef,
    WATERBOX_MCP_DIAGNOSTICS: "1",
  })
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: childEnvironment, stderr: "inherit" })
  const client = new Client({ name: "waterbox-direct-smoke", version: "1" })
  let failure: unknown
  try {
    await client.connect(transport)
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    if (names.join(",") !== "create_sandbox,probe_sandbox,delete_sandbox,list_snapshots,create_snapshot,delete_snapshot,send_file_securely,read,write,edit,patch,glob,grep,bash") throw new Error("Direct MCP returned an unexpected tool catalog")
    const created = SandboxSchema.parse(JSON.parse(resultText(await callTool(client, { name: "create_sandbox", arguments: { idempotencyKey: `direct-smoke-${crypto.randomUUID()}` } }, 180_000))))
    console.log(JSON.stringify({ stage: "created", sandboxes: 1 }))
    const target = { sandboxId: created.sandboxId }
    const probed = SandboxSchema.parse(JSON.parse(resultText(await callTool(client, { name: "probe_sandbox", arguments: target }))))
    if (probed.state !== "running") throw new Error(`Direct MCP live probe returned ${probed.state}`)
    const localSecretPath = join(directory, "local-secret.bin")
    await Bun.write(localSecretPath, new Uint8Array([0, 1, 2, 3, 255]))
    const transferred = JSON.parse(resultText(await callTool(client, { name: "send_file_securely", arguments: { ...target, sourcePath: localSecretPath, targetPath: "/root/direct-secret.bin" } }))) as { bytes?: unknown }
    if (transferred.bytes !== 5) throw new Error("Direct MCP secure file transfer assertion failed")
    await successfulOutput(client, "bash", { ...target, command: "test -f /root/direct-secret.bin && test \"$(stat -c %a /root/direct-secret.bin)\" = 600 && test \"$(wc -c </root/direct-secret.bin)\" -eq 5", workdir: "/root" })
    await verifyAsyncBash(client, target)
    let foregroundSettled = false
    const foreground = successfulOutput(client, "bash", { ...target, command: "touch /tmp/waterbox-concurrency-ready; sleep 12", description: "Hold one independent command", workdir: "/root", timeout: 15_000 }).finally(() => { foregroundSettled = true })
    const concurrent = successfulOutput(client, "bash", { ...target, command: "for attempt in $(seq 1 50); do test -f /tmp/waterbox-concurrency-ready && exit 0; sleep 0.1; done; exit 1", description: "Verify concurrent command dispatch", workdir: "/root", timeout: 10_000 })
    if (await Promise.race([concurrent.then(() => false), Bun.sleep(7_000).then(() => true)])) throw new Error("Direct MCP provider serialized concurrent commands")
    if (foregroundSettled) throw new Error("Direct MCP foreground command completed before the concurrency assertion")
    await foreground

    await successfulOutput(client, "bash", { ...target, command: "sleep 30 >/tmp/waterbox-detached.log 2>&1 & printf '%s' \"$!\" >/tmp/waterbox-detached.pid", description: "Start detached sandbox process", workdir: "/root" })
    await successfulOutput(client, "bash", { ...target, command: "pid=$(cat /tmp/waterbox-detached.pid); kill \"$pid\"; for attempt in $(seq 1 50); do state=$(ps -o stat= -p \"$pid\" 2>/dev/null || true); case \"$state\" in ''|Z*) exit 0;; esac; sleep 0.1; done; exit 1", description: "Stop detached sandbox process", workdir: "/root", timeout: 10_000 })
    console.log(JSON.stringify({ stage: "concurrency", foreground: "independent", detached: "managed" }))
    await successfulOutput(client, "write", { ...target, filePath: "/root/direct-smoke.txt", content: "Alpha\n" })
    if (!await successfulOutput(client, "read", { ...target, filePath: "/root/direct-smoke.txt" }).then((value) => value.includes("Alpha"))) throw new Error("Direct MCP read assertion failed")
    await successfulOutput(client, "edit", { ...target, filePath: "/root/direct-smoke.txt", oldString: "Alpha", newString: "Beta" })
    await successfulOutput(client, "patch", { ...target, patchText: "*** Begin Patch\n*** Add File: /root/direct-patched.txt\n+Patched\n*** End Patch" })
    if (!await successfulOutput(client, "glob", { ...target, pattern: "direct-*.txt", path: "/root" }).then((value) => value.includes("direct-smoke.txt") && value.includes("direct-patched.txt"))) throw new Error("Direct MCP glob assertion failed")
    if (!await successfulOutput(client, "grep", { ...target, pattern: "Beta", path: "/root", include: "*.txt" }).then((value) => value.includes("direct-smoke.txt"))) throw new Error("Direct MCP grep assertion failed")
    const bash = await successfulOutput(client, "bash", { ...target, command: "pwd; id -u; cat direct-smoke.txt", workdir: "/root" })
    if (!bash.includes("/root") || !bash.includes("\n0\n") || !bash.includes("Beta")) throw new Error("Direct MCP bash assertion failed")
    console.log(JSON.stringify({ stage: "tools", completed: 7 }))
    const createdSnapshot = SnapshotSchema.parse(JSON.parse(resultText(await callTool(client, { name: "create_snapshot", arguments: { ...target, name: `direct-smoke-${crypto.randomUUID()}` } }, 180_000))))
    const readySnapshot = await waitForReadySnapshot(client, createdSnapshot.snapshotId)
    SnapshotSchema.parse(JSON.parse(resultText(await callTool(client, { name: "delete_snapshot", arguments: { snapshotId: readySnapshot.snapshotId } }, 180_000))))
    SandboxSchema.parse(JSON.parse(resultText(await callTool(client, { name: "delete_sandbox", arguments: target }, 180_000))))
    console.log(JSON.stringify({ stage: "lifecycle", snapshots: 1, sandboxes: 1 }))
  } catch (error) {
    failure = error
    console.log(JSON.stringify({ stage: "cli-diagnostics", ...await collectCliDiagnostics(boxApiBaseUrl, boxApiKey, baseline) }))
  } finally {
    await client.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
    const released = await emergencyCleanup(boxApiBaseUrl, boxApiKey, baseline).catch(() => ({ visibleExtras: -1, activeBoxes: -1 }))
    console.log(JSON.stringify({ stage: "cleanup", ...released, baselineActiveBoxes: baseline.activeBoxes }))
    if (released.visibleExtras !== 0 || released.activeBoxes !== baseline.activeBoxes) {
      throw new Error("Direct MCP smoke cleanup did not reconcile the isolated Box account")
    }
  }
  if (failure !== undefined) throw failure
  return { ok: true as const, flow: "direct-mcp-smoke" }
}

async function waitForReadySnapshot(client: Client, snapshotId: string) {
  const deadline = Date.now() + 180_000
  while (true) {
    const page = SnapshotPageSchema.parse(JSON.parse(resultText(await callTool(client, { name: "list_snapshots", arguments: { limit: 100 } }))))
    const snapshot = page.items.find((item) => item.snapshotId === snapshotId)
    if (!snapshot) throw new Error("Direct MCP snapshot disappeared")
    if (snapshot.state === "ready") return snapshot
    if (snapshot.state === "failed" || snapshot.state === "deleted") throw new Error(`Direct MCP snapshot entered ${snapshot.state}`)
    if (Date.now() >= deadline) throw new Error("Direct MCP snapshot readiness timed out")
    await Bun.sleep(2_000)
  }
}

async function successfulOutput(client: Client, name: string, arguments_: Record<string, unknown>): Promise<string> {
  const payload = await successfulResult(client, name, arguments_)
  if (typeof payload.output !== "string") throw new Error(`Direct MCP ${name} returned an invalid result`)
  await Bun.sleep(500)
  return payload.output
}

async function successfulResult(client: Client, name: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callTool(client, { name, arguments: arguments_ })
  if (result.isError) throw new Error(`Direct MCP ${name} failed: ${resultText(result)}`)
  const payload = JSON.parse(resultText(result))
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`Direct MCP ${name} returned an invalid result`)
  return payload as Record<string, unknown>
}

interface AsyncReceipt { jobId: string; outputPath: string; statusPath: string }

async function verifyAsyncBash(client: Client, target: { sandboxId: string }): Promise<void> {
  const explicit = await successfulResult(client, "bash", { ...target, command: "printf explicit-completed", workdir: "/root", timeout: 120_000 })
  if (!completedBash(explicit)) throw new Error("Direct MCP quick Bash with an execution timeout did not complete")
  const omitted = await successfulResult(client, "bash", { ...target, command: "printf omitted-completed", workdir: "/root" })
  if (!completedBash(omitted)) throw new Error("Direct MCP quick Bash with an omitted timeout did not complete")
  const jobsAfterFastCalls = await successfulOutput(client, "glob", { ...target, pattern: "job_*", path: "/run/waterbox/bash-jobs" })
  if (/job_[a-f0-9]{32}/.test(jobsAfterFastCalls)) throw new Error("Direct MCP completed Bash leaked a job directory")

  const omittedSlow = receipt(await successfulResult(client, "bash", {
    ...target,
    command: "printf phase-one; sleep 20; printf phase-two",
    description: "Verify omitted-deadline yield and output growth",
    workdir: "/root",
  }))
  const firstOutput = await waitForOutput(client, target, omittedSlow.outputPath, value => value.includes("phase-one") && !value.includes("phase-two"), 5_000)
  const omittedStatus = await waitForTerminalStatus(client, target, omittedSlow.statusPath, 30_000)
  const finalOutput = await remoteRead(client, target, omittedSlow.outputPath)
  if (!firstOutput.includes("phase-one") || !finalOutput.includes("phase-two") || omittedStatus.state !== "completed" || omittedStatus.timedOut !== false) throw new Error("Direct MCP omitted-timeout yielded Bash assertion failed")

  const conservative = receipt(await successfulResult(client, "bash", { ...target, command: "sleep 20; printf conservative-completed", description: "Verify conservative execution timeout yield", workdir: "/root", timeout: 120_000 }))
  const conservativeStatus = await waitForTerminalStatus(client, target, conservative.statusPath, 30_000)
  if (conservativeStatus.state !== "completed" || conservativeStatus.timedOut !== false || !(await remoteRead(client, target, conservative.outputPath)).includes("conservative-completed")) throw new Error("Direct MCP conservative-timeout yielded Bash assertion failed")

  const timed = await resultPayload(client, "bash", { ...target, command: "sleep 30", description: "Verify hard execution timeout", workdir: "/root", timeout: 2_000 })
  if (!completedBash(timed) || (timed.metadata as Record<string, unknown>).timedOut !== true) throw new Error("Direct MCP hard execution timeout did not settle as timed out")

  console.log(JSON.stringify({ stage: "async-bash", completedCases: 2, completedFilesCleaned: true, yieldedCases: 2, omittedTimeoutYield: true, conservativeTimeoutYield: true, outputGrowth: true, terminalCompletion: true, hardTimeout: true, mcpReadPolling: true, receiptGuidance: true }))
}

function receipt(value: Record<string, unknown>): AsyncReceipt {
  const guidance = value.output
  if (typeof guidance !== "string" || !guidance.includes("statusPath reports execution state") || !guidance.includes("outputPath receives output continuously") || !guidance.includes("duplicate tokens and pollute context") || /15[,.]?000|threshold|poll (?:or read )?both files/i.test(guidance)) throw new Error("Direct MCP async Bash returned invalid receipt guidance")
  const metadata = value.metadata
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Direct MCP async Bash did not return a receipt")
  const { jobId, outputPath, statusPath } = metadata as Record<string, unknown>
  if (typeof jobId !== "string" || typeof outputPath !== "string" || typeof statusPath !== "string") throw new Error("Direct MCP async Bash returned an invalid receipt")
  return { jobId, outputPath, statusPath }
}

function completedBash(value: Record<string, unknown>): boolean {
  const metadata = value.metadata
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || "jobId" in metadata) return false
  const exitCode = (metadata as Record<string, unknown>).exitCode
  return typeof exitCode === "number" || exitCode === null
}

async function resultPayload(client: Client, name: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = JSON.parse(resultText(await callTool(client, { name, arguments: arguments_ })))
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`Direct MCP ${name} returned an invalid result`)
  return payload as Record<string, unknown>
}

async function remoteRead(client: Client, target: { sandboxId: string }, filePath: string): Promise<string> {
  return successfulOutput(client, "read", { ...target, filePath })
}

async function waitForOutput(client: Client, target: { sandboxId: string }, filePath: string, accept: (value: string) => boolean, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const output = await remoteRead(client, target, filePath)
    if (accept(output)) return output
    if (Date.now() >= deadline) throw new Error("Direct MCP async Bash output growth timed out")
    await Bun.sleep(250)
  }
}

async function waitForTerminalStatus(client: Client, target: { sandboxId: string }, statusPath: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const status = JSON.parse(await remoteRead(client, target, statusPath)) as Record<string, unknown>
    if (status.state === "completed" || status.state === "failed") return status
    if (Date.now() >= deadline) throw new Error("Direct MCP async Bash status polling timed out")
    await Bun.sleep(500)
  }
}

async function callTool(client: Client, request: Parameters<Client["callTool"]>[0], timeoutMs = 60_000) {
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
  if (content.length !== 1) throw new Error("Direct MCP returned invalid content")
  const item = content[0]
  if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "text" || typeof (item as { text?: unknown }).text !== "string") {
    throw new Error("Direct MCP returned invalid text content")
  }
  return (item as { text: string }).text
}

function stringEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

if (import.meta.main) {
  runDirectMcpSmoke().then(
    (result) => console.log(JSON.stringify(result)),
    (error) => { console.error(error instanceof Error ? error.message : "Direct MCP smoke failed"); process.exitCode = 1 },
  )
}
