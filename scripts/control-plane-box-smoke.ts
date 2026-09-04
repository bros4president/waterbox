import { BashToolResultSchema, EditToolResultSchema, GlobToolResultSchema, GrepToolResultSchema, MAX_TOOL_RESULT_BYTES, PatchToolResultSchema, ReadToolResultSchema, SandboxPageSchema, SandboxSchema, SnapshotPageSchema, SnapshotSchema, WriteToolResultSchema, type Sandbox, type Snapshot, type ToolName } from "../packages/sandbox-contracts/src/index.ts"

const SANDBOX_TERMINAL = new Set(["terminated", "failed"])
const SNAPSHOT_TERMINAL = new Set(["deleted", "failed"])
const MAX_LIST_PAGES = 100
const MAX_LIST_ITEMS = 10_000
export interface SmokeConfig { baseUrl: string; apiKey: string; runId: string; pollIntervalMs: number; pollTimeoutMs: number }
export type SmokeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export interface SmokeDependencies { fetch: SmokeFetch; sleep(ms: number): Promise<void>; now(): number; randomId(): string }

export function parseSmokeConfig(env: Record<string, string | undefined>, randomId: () => string = () => crypto.randomUUID()): SmokeConfig {
  if (env.WATERBOX_BOX_SMOKE_AUTHORIZED !== "YES" || env.WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT !== "YES") throw new Error("Box smoke requires explicit authorization for an isolated development account")
  if (!env.WATERBOX_API_URL || !env.WATERBOX_DEV_API_KEY || !env.BOX_API_KEY) throw new Error("Box smoke requires all configured credentials")
  let baseUrl: string
  try { baseUrl = new URL(env.WATERBOX_API_URL).toString().replace(/\/$/, "") } catch { throw new Error("Box smoke configuration is invalid") }
  const pollIntervalMs = positive(env.WATERBOX_SMOKE_POLL_INTERVAL_MS, 1_000), pollTimeoutMs = positive(env.WATERBOX_SMOKE_POLL_TIMEOUT_MS, 180_000)
  if (pollTimeoutMs < pollIntervalMs) throw new Error("Box smoke configuration is invalid")
  return { baseUrl, apiKey: env.WATERBOX_DEV_API_KEY, runId: `smoke-${randomId()}`, pollIntervalMs, pollTimeoutMs }
}

export async function runBoxSmoke(config: SmokeConfig, deps: SmokeDependencies = { fetch, sleep: (ms) => Bun.sleep(ms), now: Date.now, randomId: () => crypto.randomUUID() }) {
  const api = new SmokeApi(config, deps), baseline = new Set((await api.listSandboxes()).map((item) => item.sandboxId))
  const sandboxes = new Set<string>(), snapshots = new Set<string>(), marker = `${config.runId}-snapshot`.slice(0, 128)
  let failure: unknown
  try {
    const first = await api.createSandbox({}, `${config.runId}-first`); sandboxes.add(first.sandboxId); await api.waitSandbox(first.sandboxId, "running")
    await api.tool(first.sandboxId, "write", { filePath: "/home/user/workspace/smoke.txt", content: "alpha\n" })
    await api.tool(first.sandboxId, "read", { filePath: "/home/user/workspace/smoke.txt" })
    await api.tool(first.sandboxId, "edit", { filePath: "/home/user/workspace/smoke.txt", oldString: "alpha", newString: "beta" })
    await api.tool(first.sandboxId, "patch", { patchText: "*** Begin Patch\n*** Add File: /home/user/workspace/patched.txt\n+patched\n*** End Patch" })
    await api.tool(first.sandboxId, "glob", { pattern: "*.txt", path: "/home/user/workspace" }); await api.tool(first.sandboxId, "grep", { pattern: "beta", path: "/home/user/workspace" })
    await api.tool(first.sandboxId, "bash", { command: "printf first; sleep 1; printf second" })
    await api.post(`/v1/sandboxes/${first.sandboxId}/stop`); await api.waitSandbox(first.sandboxId, "stopped")
    await api.tool(first.sandboxId, "read", { filePath: "/home/user/workspace/smoke.txt" }); await api.waitSandbox(first.sandboxId, "running")
    const snapshot = await api.createSnapshot(first.sandboxId, marker); snapshots.add(snapshot.snapshotId); await api.waitSnapshot(snapshot.snapshotId, "ready")
    const second = await api.createSandbox({ sourceSnapshotId: snapshot.snapshotId }, `${config.runId}-second`); sandboxes.add(second.sandboxId); await api.waitSandbox(second.sandboxId, "running")
    await api.tool(second.sandboxId, "grep", { pattern: "beta", path: "/home/user/workspace/smoke.txt" })
  } catch (error) { failure = error }
  finally {
    const cleanup: string[] = []
    try { for (const item of await api.listSnapshots()) if (item.name === marker) snapshots.add(item.snapshotId) }
    catch { cleanup.push("snapshot discovery") }
    // Sandbox DTOs expose no ownership marker. The separately authorized smoke therefore
    // requires an isolated account and treats only post-baseline additions as run-owned.
    try { for (const item of await api.listSandboxes()) if (!baseline.has(item.sandboxId)) sandboxes.add(item.sandboxId) }
    catch { cleanup.push("sandbox discovery") }
    for (const id of [...sandboxes].reverse()) try { await api.deleteSandboxAndWait(id) } catch { cleanup.push("sandbox cleanup") }
    for (const id of [...snapshots].reverse()) try { await api.deleteSnapshotAndWait(id) } catch { cleanup.push("snapshot cleanup") }
    try { if ((await api.listSandboxes()).some((item) => sandboxes.has(item.sandboxId) && !SANDBOX_TERMINAL.has(item.state))) cleanup.push("running resource verification") }
    catch { cleanup.push("running resource verification") }
    if (cleanup.length) throw new Error(`Box smoke cleanup incomplete: ${cleanup.join(", ")}`)
  }
  if (failure !== undefined) throw failure
  return { ok: true as const, flow: "control-plane-box-smoke" }
}

export class SmokeApi {
  constructor(private config: SmokeConfig, private deps: SmokeDependencies) {}
  async request(path: string, init: RequestInit = {}, replay = false) {
    const execute = () => this.deps.fetch(`${this.config.baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${this.config.apiKey}`, ...init.headers } })
    let response: Response
    try { response = await execute() } catch { if (!replay) throw safeFailure(); try { response = await execute() } catch { throw safeFailure() } }
    if (response.status >= 500 && replay) { try { await response.body?.cancel(); response = await execute() } catch { throw safeFailure() } }
    if (!response.ok) { try { await response.body?.cancel() } catch {}; throw safeFailure(response.status) }
    return response
  }
  async json(path: string, init: RequestInit = {}, replay = false) {
    const response = await this.request(path, init, replay)
    try { return await response.json() }
    catch {
      if (!replay) throw safeFailure()
      const recovered = await this.request(path, init, false)
      try { return await recovered.json() } catch { throw safeFailure() }
    }
  }
  async post(path: string, body?: unknown, headers: Record<string, string> = {}, replay = false) { return this.json(path, { method: "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, replay) }
  async createSandbox(body: unknown, key: string) { return SandboxSchema.parse(await this.post("/v1/sandboxes", body, { "idempotency-key": key }, true)) }
  async createSnapshot(id: string, marker: string) { try { return SnapshotSchema.parse(await this.post(`/v1/sandboxes/${id}/snapshots`, { name: marker })) } catch (error) { const found = (await this.listSnapshots()).find((item) => item.name === marker); if (found) return found; throw error } }
  async allPages<T>(path: string, schema: { parse(value: unknown): { items: T[]; nextCursor?: string } }) {
    const items: T[] = [], seen = new Set<string>(); let cursor: string | undefined
    for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber++) {
      const page = schema.parse(await this.json(`${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`))
      items.push(...page.items)
      if (items.length > MAX_LIST_ITEMS) throw new Error("Control-plane smoke listing exceeded its safety bound")
      if (!page.nextCursor) return items
      if (seen.has(page.nextCursor)) throw new Error("Control-plane smoke listing cursor did not advance")
      seen.add(page.nextCursor); cursor = page.nextCursor
    }
    throw new Error("Control-plane smoke listing exceeded its safety bound")
  }
  listSandboxes(): Promise<Sandbox[]> { return this.allPages("/v1/sandboxes", SandboxPageSchema) }
  listSnapshots(): Promise<Snapshot[]> { return this.allPages("/v1/snapshots", SnapshotPageSchema) }
  async getSandbox(id: string) { return SandboxSchema.parse(await this.json(`/v1/sandboxes/${id}`)) }
  async getSnapshot(id: string) { return SnapshotSchema.parse(await this.json(`/v1/snapshots/${id}`)) }
  waitSandbox(id: string, state: Sandbox["state"]) { return this.wait(() => this.getSandbox(id), state, SANDBOX_TERMINAL) }
  waitSnapshot(id: string, state: Snapshot["state"]) { return this.wait(() => this.getSnapshot(id), state, SNAPSHOT_TERMINAL) }
  async wait<T extends { state: string }>(read: () => Promise<T>, expected: string, terminal: ReadonlySet<string>) { const deadline = this.deps.now() + this.config.pollTimeoutMs; while (this.deps.now() <= deadline) { const item = await read(); if (item.state === expected) return item; if (terminal.has(item.state)) throw new Error("Control-plane smoke resource entered an unexpected terminal state"); await this.deps.sleep(this.config.pollIntervalMs) } throw new Error("Control-plane smoke reconciliation timed out") }
  async deleteSandboxAndWait(id: string) { if ((await this.getSandbox(id)).state !== "terminated") await this.request(`/v1/sandboxes/${id}`, { method: "DELETE" }); return this.waitSandbox(id, "terminated") }
  async deleteSnapshotAndWait(id: string) { if ((await this.getSnapshot(id)).state !== "deleted") await this.request(`/v1/snapshots/${id}`, { method: "DELETE" }); return this.waitSnapshot(id, "deleted") }
  async tool(id: string, name: ToolName, body: unknown) {
    const response = await this.request(`/v1/sandboxes/${id}/tools/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") { await response.body?.cancel().catch(() => undefined); throw safeFailure() }
    return toolResultSchemas[name].parse(await boundedJson(response, MAX_TOOL_RESULT_BYTES))
  }
}
const toolResultSchemas = { read: ReadToolResultSchema, write: WriteToolResultSchema, edit: EditToolResultSchema, patch: PatchToolResultSchema, glob: GlobToolResultSchema, grep: GrepToolResultSchema, bash: BashToolResultSchema } as const
async function boundedJson(response: Response, maximum: number): Promise<unknown> { if (!response.body) throw safeFailure(); const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0, done = false; try { while (true) { const item = await reader.read(); if (item.done) { done = true; break }; length += item.value.byteLength; if (length > maximum) throw safeFailure(); chunks.push(item.value) } const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength } return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } finally { if (!done) await reader.cancel().catch(() => undefined); reader.releaseLock() } }
function positive(value: string | undefined, fallback: number) { if (value === undefined) return fallback; const number = Number(value); if (!Number.isInteger(number) || number <= 0) throw new Error("Box smoke configuration is invalid"); return number }
function safeFailure(status?: number) { return new Error(status === undefined ? "Control-plane smoke transport failed" : `Control-plane smoke request failed (${status})`) }
if (import.meta.main) console.log(JSON.stringify(await runBoxSmoke(parseSmokeConfig(process.env))))
