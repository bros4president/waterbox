import { createDevelopmentControlPlane, loadDevelopmentRuntimeArtifact } from "../apps/api-local/src/app.ts"
import { startLocalServer } from "../apps/api-local/src/server.ts"
import type { LocalApiConfig } from "../apps/api-local/src/config.ts"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import process from "node:process"
import { encodeInvocation } from "../packages/sandbox-cli/src/protocol.ts"

const root = resolve(import.meta.dir, "..")
const mcpEntry = resolve(root, "packages/experimental-control-plane-mcp/src/server.ts")
const sandboxTools = ["write", "read", "edit", "patch", "glob", "grep", "bash"] as const
const AUTHORIZATION = "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES"
const createPrompt = `A remote Waterbox environment is available in the Code Mode tool namespace remote.

Use the execute tool to call tools.remote.create_sandbox({}) exactly once. Return the result. Do not call any other tool.`

const toolsPrompt = `The previously selected remote Waterbox sandbox is available in the Code Mode tool namespace remote.

Use the execute tool to call every tool below exactly once, in this order:
1. remote.write: write Alpha followed by a newline to /workspace/mcp-span.txt.
2. remote.read: read /workspace/mcp-span.txt.
3. remote.edit: replace Alpha with Beta in /workspace/mcp-span.txt.
4. remote.patch: add mcp-patched.txt at the sandbox workspace root containing Patched followed by a newline.
5. remote.glob: find mcp-*.txt under /workspace.
6. remote.grep: search for Beta under /workspace, including *.txt files.
7. remote.bash: run pwd and then print /workspace/mcp-span.txt.

Wrap each individual tool call in its own try/catch and continue to the next tool after any failure. Return a summary of every result. Do not merely describe the calls. Do not use local filesystem or shell tools.`

export interface BoxBaseline { ids: Set<string>; activeBoxes: number }
type ExperimentMode = "automated" | "interactive"

export function experimentMode(argv: readonly string[]): ExperimentMode {
  if (argv.includes("--interactive")) return "interactive"
  if (argv.includes("--run")) return "automated"
  throw new Error("Pass --run for the automated smoke or --interactive for a manual OpenCode session")
}

export function assertExperimentAuthorized(env: NodeJS.ProcessEnv): void {
  if (env.WATERBOX_MCP_EXPERIMENT_AUTHORIZATION !== AUTHORIZATION || env.WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT !== "YES") throw new Error("The MCP experiment requires explicit authorization for an isolated Box account")
}

export function openCodeToolNames(output: string): string[] {
  const names: string[] = []
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: string; part?: { tool?: string } }
      if (event.type === "tool_use" && event.part?.tool) names.push(event.part.tool)
    } catch {}
  }
  return names
}

async function executable(path: string): Promise<string | undefined> { return access(path, constants.X_OK).then(() => path, () => undefined) }
async function resolveOpenCode(): Promise<string> {
  if (process.env.OPENCODE2_BIN) {
    const configured = await executable(resolve(process.env.OPENCODE2_BIN))
    if (configured) return configured
    throw new Error("Configured opencode2 executable is unavailable")
  }
  const local = await executable(join(root, "node_modules/.bin/opencode2"))
  if (local) return local
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const found = await executable(join(directory, "opencode2"))
    if (found) return found
  }
  throw new Error("opencode2 is unavailable; run bun install or set OPENCODE2_BIN")
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((value, secret) => secret ? value.replaceAll(secret, "[REDACTED]") : value, text)
}

async function serverUrl(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader(), decoder = new TextDecoder()
  let pending = ""
  while (true) {
    const item = await reader.read()
    if (item.done) throw new Error("OpenCode server exited before reporting readiness")
    pending += decoder.decode(item.value, { stream: true })
    const newline = pending.indexOf("\n")
    if (newline < 0) continue
    const match = /^server listening on (https?:\/\/\S+)$/.exec(pending.slice(0, newline).trim())
    if (!match) throw new Error("OpenCode server returned an invalid readiness message")
    return match[1]!
  }
}

async function waitForMcp(url: string, password: string, directory: string): Promise<void> {
  const deadline = Date.now() + 30_000
  const endpoint = `${url}/api/mcp?location[directory]=${encodeURIComponent(directory)}`
  const authorization = `Basic ${btoa(`opencode:${password}`)}`
  while (Date.now() < deadline) {
    const response = await fetch(endpoint, { headers: { authorization } }).catch(() => undefined)
    if (response?.ok) {
      const payload = await response.json() as { data?: Array<{ name?: string; status?: { status?: string } }> }
      if (payload.data?.some(server => server.name === "remote" && server.status?.status === "connected")) return
    } else await response?.body?.cancel().catch(() => {})
    await Bun.sleep(250)
  }
  throw new Error("OpenCode did not connect the experimental MCP server")
}

async function reconnectMcp(url: string, password: string, directory: string): Promise<void> {
  const authorization = `Basic ${btoa(`opencode:${password}`)}`
  const query = `location[directory]=${encodeURIComponent(directory)}`
  for (const action of ["disconnect", "connect"] as const) {
    const response = await fetch(`${url}/api/mcp/remote/${action}?${query}`, { method: "POST", headers: { authorization } })
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`OpenCode MCP ${action} failed (${response.status})`) }
    await response.body?.cancel().catch(() => {})
  }
  await waitForMcp(url, password, directory)
}

function startOpenCodeServer(openCode: string, directory: string, environment: Record<string, string | undefined>) {
  return Bun.spawn([openCode, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: directory,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function runOpenCode(openCode: string, openCodeUrl: string, model: string, message: string, directory: string, environment: Record<string, string | undefined>, secrets: string[]): Promise<string[]> {
  const diagnosticFlags = process.env.WATERBOX_EXPERIMENT_DEBUG === "1" ? ["--print-logs", "--log-level", "debug"] : []
  const child = Bun.spawn([openCode, "run", "--server", openCodeUrl, "--auto", "--format", "json", "--model", model, ...diagnosticFlags, message], { cwd: directory, env: environment, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (stderr) process.stderr.write(redact(stderr, secrets))
  process.stdout.write(stdout)
  if (exitCode !== 0) throw new Error(`OpenCode exited with status ${exitCode}`)
  return openCodeToolNames(stdout)
}

async function boxJson(baseUrl: string, apiKey: string, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", ...init.headers }, signal: init.signal ?? AbortSignal.timeout(30_000) })
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`Box preflight request failed (${response.status})`) }
  return response.json()
}

export async function preflight(baseUrl: string, apiKey: string): Promise<BoxBaseline> {
  const [limits, listed] = await Promise.all([
    boxJson(baseUrl, apiKey, "/limits"),
    boxJson(baseUrl, apiKey, "/boxes"),
  ])
  if (limits?.ok !== true || limits?.type !== "limits.info" || limits.canStart !== true || !Number.isInteger(limits.activeBoxes) || !Number.isInteger(limits.maxActiveBoxes) || limits.activeBoxes >= limits.maxActiveBoxes) throw new Error("Box account has no capacity for the experiment")
  if (listed?.ok !== true || listed?.type !== "box.list" || !Array.isArray(listed.boxes) || !listed.boxes.every((item: any) => typeof item?.id === "string")) throw new Error("Box preflight returned an invalid Box list")
  return { ids: new Set(listed.boxes.map((item: any) => item.id)), activeBoxes: limits.activeBoxes }
}

async function apiRequest(apiUrl: string, apiKey: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${apiUrl}${path}`, { ...init, headers: { authorization: `Bearer ${apiKey}`, ...init.headers } })
}

export async function emergencyCleanup(baseUrl: string, apiKey: string, baseline: BoxBaseline): Promise<{ visibleExtras: number; activeBoxes: number }> {
  const listed = await boxJson(baseUrl, apiKey, "/boxes")
  const extras = Array.isArray(listed?.boxes) ? listed.boxes.filter((item: any) => typeof item?.id === "string" && !baseline.ids.has(item.id)) : []
  for (const item of extras) {
    const response = await fetch(`${baseUrl}/boxes/${encodeURIComponent(item.id)}`, { method: "DELETE", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", "x-ascii-confirm-delete": item.id }, signal: AbortSignal.timeout(30_000) })
    await response.body?.cancel().catch(() => {})
  }
  const deadline = Date.now() + 180_000
  while (true) {
    const [afterList, limits] = await Promise.all([boxJson(baseUrl, apiKey, "/boxes"), boxJson(baseUrl, apiKey, "/limits")])
    const visibleExtras = Array.isArray(afterList?.boxes) ? afterList.boxes.filter((item: any) => typeof item?.id === "string" && !baseline.ids.has(item.id)).length : -1
    const activeBoxes = Number(limits?.activeBoxes)
    if (visibleExtras === 0 && activeBoxes === baseline.activeBoxes || Date.now() >= deadline) return { visibleExtras, activeBoxes }
    await Bun.sleep(2_000)
  }
}

export async function collectCliDiagnostics(baseUrl: string, apiKey: string, baseline: BoxBaseline): Promise<Record<string, unknown>> {
  const listed = await boxJson(baseUrl, apiKey, "/boxes")
  const extras = Array.isArray(listed?.boxes) ? listed.boxes.filter((item: any) => typeof item?.id === "string" && !baseline.ids.has(item.id)) : []
  if (extras.length !== 1) return { available: false, reason: `expected_one_box_found_${extras.length}` }
  const payloads = {
    write: encodeInvocation("write", { filePath: "/workspace/.waterbox-diagnostic", content: "diagnostic\n" }),
    read: encodeInvocation("read", { filePath: "/workspace/.waterbox-diagnostic" }),
    edit: encodeInvocation("edit", { filePath: "/workspace/.waterbox-diagnostic", oldString: "diagnostic", newString: "diagnosed" }),
    smokeRead: encodeInvocation("read", { filePath: "/root/direct-smoke.txt" }),
    smokeEdit: encodeInvocation("edit", { filePath: "/root/direct-smoke.txt", oldString: "Alpha", newString: "Diagnosed" }),
  }
  const probes = [
    ["health", "/usr/local/bin/waterbox health"],
    ["version", "/usr/local/bin/waterbox version"],
    ["workspace", "id; stat -c '%U:%G %a' /workspace; touch /workspace/.waterbox-shell-diagnostic; rm -f /workspace/.waterbox-shell-diagnostic"],
    ["write", `/usr/local/bin/waterbox run ${payloads.write}`],
    ["read", `/usr/local/bin/waterbox run ${payloads.read}`],
    ["edit", `/usr/local/bin/waterbox run ${payloads.edit}`],
    ["smoke-read", `/usr/local/bin/waterbox run ${payloads.smokeRead}`],
    ["smoke-edit", `/usr/local/bin/waterbox run ${payloads.smokeEdit}`],
  ] as const
  const results: Record<string, unknown> = {}
  for (const [name, command] of probes) {
    try {
      const value = await boxJson(baseUrl, apiKey, `/boxes/${encodeURIComponent(extras[0].id)}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, timeoutSeconds: 30 }) })
      const clean = (text: unknown) => typeof text === "string" ? Object.values(payloads).reduce((result, payload) => result.replaceAll(payload, "<invocation>"), text).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 1_000) : ""
      results[name] = { success: value?.success, exitCode: value?.exitCode, timedOut: value?.timedOut, stdoutTruncated: value?.stdoutTruncated, stderrTruncated: value?.stderrTruncated, stdout: clean(value?.stdout), stderr: clean(value?.stderr) }
    } catch (error) { results[name] = { unavailable: error instanceof Error ? error.message : "diagnostic failed" } }
  }
  return { available: true, probes: results }
}

async function main(): Promise<void> {
  const mode = experimentMode(process.argv.slice(2))
  assertExperimentAuthorized(process.env)
  const boxApiKey = process.env.BOX_API_KEY
  if (!boxApiKey) throw new Error("BOX_API_KEY is required")
  const baseUrl = (process.env.BOX_API_BASE_URL ?? "https://ascii.dev/api/box/v1").replace(/\/$/, "")
  const openCode = await resolveOpenCode()
  const baseline = await preflight(baseUrl, boxApiKey)
  console.log(JSON.stringify({ stage: "preflight", activeBoxes: baseline.activeBoxes }))

  const directory = await mkdtemp(join(tmpdir(), "waterbox-mcp-experiment-"))
  const sqlitePath = join(directory, "control-plane.sqlite"), statePath = join(directory, "mcp-state.json"), configPath = join(directory, "opencode.json")
  const developmentApiKey = crypto.randomUUID(), accountId = `experiment-${crypto.randomUUID()}`, idempotencyKey = `experiment-${crypto.randomUUID()}`
  const config: LocalApiConfig = {
    host: "127.0.0.1", port: 1, sqlitePath, developmentApiKey, accountId,
    box: { apiBaseUrl: baseUrl, apiKey: boxApiKey, polling: { intervalMs: 1_000, timeoutMs: 30_000 }, automaticStopMs: 2_400_000 },
  }
  const runtimeArtifact = await loadDevelopmentRuntimeArtifact()
  const local = await startLocalServer(await createDevelopmentControlPlane(config, runtimeArtifact), { host: "127.0.0.1", port: 0, idleTimeoutSeconds: 60 })
  const apiUrl = `http://127.0.0.1:${local.server.port}`
  const openCodePassword = crypto.randomUUID()
  let sandboxId: string | undefined, primaryFailure: unknown, cleanupBlocker: string | undefined
  let cleanupReconciled = false
  let openCodeServer: ReturnType<typeof startOpenCodeServer> | undefined, openCodeServerStderr: Promise<string> | undefined
  try {
    const model = process.env.WATERBOX_EXPERIMENT_MODEL ?? "openai/gpt-5.6-sol"
    await writeFile(configPath, JSON.stringify({
      model,
      permissions: [
        ...["shell", "read", "write", "edit", "patch", "glob", "grep", "subagent"].map(action => ({ action, resource: "*", effect: "deny" })),
        { action: "execute", resource: "*", effect: "allow" },
        { action: "remote_*", resource: "*", effect: "allow" },
      ],
      mcp: { servers: { remote: { type: "local", command: ["bun", "run", mcpEntry], environment: { WATERBOX_API_URL: apiUrl, WATERBOX_API_KEY: developmentApiKey, WATERBOX_MCP_IDEMPOTENCY_KEY: idempotencyKey, WATERBOX_MCP_STATE_PATH: statePath }, timeout: { startup: 30_000, catalog: 30_000, execution: 300_000 } } } },
    }), { mode: 0o600 })
    const openCodeEnv = { ...process.env, PWD: directory, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_PROJECT_DISABLE: "true", OPENCODE_SERVER_PASSWORD: openCodePassword }
    openCodeServer = startOpenCodeServer(openCode, directory, openCodeEnv)
    openCodeServerStderr = new Response(openCodeServer.stderr).text()
    const openCodeUrl = await Promise.race([
      serverUrl(openCodeServer.stdout),
      Bun.sleep(30_000).then(() => { throw new Error("OpenCode server readiness timed out") }),
    ])
    await waitForMcp(openCodeUrl, openCodePassword, directory)
    await reconnectMcp(openCodeUrl, openCodePassword, directory)
    await Bun.sleep(1_000)
    const secrets = [developmentApiKey, idempotencyKey, boxApiKey, openCodePassword]
    if (mode === "interactive") {
      console.error("Interactive Waterbox MCP session ready. Ask OpenCode to create a sandbox; exit the TUI to clean up.")
      const child = Bun.spawn([openCode, "--server", openCodeUrl, "--auto"], { cwd: directory, env: openCodeEnv, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
      const interrupt = () => child.kill("SIGINT")
      const terminate = () => child.kill("SIGTERM")
      process.once("SIGINT", interrupt)
      process.once("SIGTERM", terminate)
      const exitCode = await child.exited
      const selected = await readFile(statePath, "utf8").then(value => JSON.parse(value) as { sandboxId?: string }, (): { sandboxId?: string } => ({}))
      sandboxId = selected.sandboxId
      if (exitCode !== 0 && exitCode !== 130 && exitCode !== 143) throw new Error(`Interactive OpenCode exited with status ${exitCode}`)
    } else {
    const createNames: string[] = []
    let createdState: { sandboxId?: string } = {}
    for (let attempt = 0; attempt < 3 && !createdState.sandboxId; attempt += 1) {
      createNames.push(...await runOpenCode(openCode, openCodeUrl, model, createPrompt, directory, openCodeEnv, secrets))
      createdState = await readFile(statePath, "utf8").then(value => JSON.parse(value), () => ({}))
      if (!createdState.sandboxId) { await reconnectMcp(openCodeUrl, openCodePassword, directory); await Bun.sleep(1_000) }
    }
    console.log(JSON.stringify({ stage: "opencode-create", mcpRecognized: createNames.includes("execute"), tools: [...new Set(createNames)] }))
    if (!createNames.includes("execute")) throw new Error("OpenCode did not invoke Code Mode to create the experimental sandbox")
    if (!createdState.sandboxId) throw new Error("OpenCode did not create a sandbox through MCP")
    sandboxId = createdState.sandboxId
    const toolNames: string[] = []
    let state: { sandboxId?: string; calls?: Partial<Record<(typeof sandboxTools)[number], { attempted: number; completed: number }>> } = createdState
    for (let attempt = 0; attempt < 3; attempt += 1) {
      toolNames.push(...await runOpenCode(openCode, openCodeUrl, model, toolsPrompt, directory, openCodeEnv, secrets))
      state = JSON.parse(await readFile(statePath, "utf8"))
      if (sandboxTools.some(tool => state.calls?.[tool]?.attempted)) break
      await reconnectMcp(openCodeUrl, openCodePassword, directory)
      await Bun.sleep(1_000)
    }
    console.log(JSON.stringify({ stage: "opencode-tools", mcpRecognized: toolNames.includes("execute"), tools: [...new Set(toolNames)] }))
    if (!toolNames.includes("execute")) throw new Error("OpenCode did not invoke Code Mode for the experimental MCP tools")
    const span = Object.fromEntries(sandboxTools.map(tool => [tool, state.calls?.[tool] ?? { attempted: 0, completed: 0 }])) as Record<(typeof sandboxTools)[number], { attempted: number; completed: number }>
    console.log(JSON.stringify({ stage: "tool-span", tools: span }))
    const notAttempted = sandboxTools.filter(tool => !span[tool].attempted)
    if (notAttempted.length) throw new Error(`OpenCode did not attempt every MCP tool: ${notAttempted.join(", ")}`)
    const incomplete = sandboxTools.filter(tool => !span[tool].completed)
    if (incomplete.length) {
      console.log(JSON.stringify({ stage: "cli-diagnostics", ...await collectCliDiagnostics(baseUrl, boxApiKey, baseline) }))
      throw new Error(`MCP tools did not complete: ${incomplete.join(", ")}`)
    }
    }
  } catch (error) { primaryFailure = error }
  finally {
    if (openCodeServer) {
      openCodeServer.kill()
      await openCodeServer.exited
      const serverError = await openCodeServerStderr
      if (serverError) process.stderr.write(redact(serverError, [developmentApiKey, idempotencyKey, boxApiKey, openCodePassword]))
    }
    if (sandboxId) {
      try {
        const response = await apiRequest(apiUrl, developmentApiKey, `/v1/sandboxes/${encodeURIComponent(sandboxId)}`, { method: "DELETE", signal: AbortSignal.timeout(35_000) })
        if (!response.ok) cleanupBlocker = `API cleanup returned ${response.status}`
        await response.body?.cancel().catch(() => {})
      } catch { cleanupBlocker = "API cleanup did not complete" }
    }
    const released = await emergencyCleanup(baseUrl, boxApiKey, baseline).catch(() => ({ visibleExtras: -1, activeBoxes: -1 }))
    cleanupReconciled = released.visibleExtras === 0 && released.activeBoxes === baseline.activeBoxes
    console.log(JSON.stringify({ stage: "cleanup", apiBlocker: cleanupBlocker ?? false, visibleExtras: released.visibleExtras, activeBoxes: released.activeBoxes, baselineActiveBoxes: baseline.activeBoxes }))
    await local.close()
    await rm(directory, { recursive: true, force: true })
  }
  if (primaryFailure) throw primaryFailure
  if (cleanupBlocker && !cleanupReconciled) throw new Error(`Experiment succeeded but cleanup is blocked: ${cleanupBlocker}`)
}

if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : "Control-plane MCP experiment failed"); process.exitCode = 1 })
