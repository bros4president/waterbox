import { describe, expect, test } from "bun:test"
import { assertDirectSmokeAuthorized, baselineReconciliationError, compareBoxBaseline, reconcileBoxBaseline, runDirectMcpProductFlow, type BoxBaseline } from "./direct-mcp-smoke.ts"

const now = "2026-08-31T12:00:00.000Z"
const sandboxId = "sbx_silver-forest-a1"
const restoredSandboxId = "sbx_silver-forest-b2"
const snapshotId = "snap_silver-forest-c3"
const tools = "create_sandbox,probe_sandbox,delete_sandbox,list_snapshots,create_snapshot,delete_snapshot,send_file_securely,read,write,edit,patch,glob,grep,bash".split(",").map((name) => ({ name }))

describe("Direct MCP smoke", () => {
  test("requires both destructive-operation gates", () => {
    expect(() => assertDirectSmokeAuthorized({})).toThrow("explicit authorization")
    expect(() => assertDirectSmokeAuthorized({ WATERBOX_MCP_EXPERIMENT_AUTHORIZATION: "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES" })).toThrow("explicit authorization")
    expect(() => assertDirectSmokeAuthorized({ WATERBOX_MCP_EXPERIMENT_AUTHORIZATION: "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES", WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT: "YES" })).not.toThrow()
  })

  test("runs the snapshot restore flow with distinct create keys and ordered tracked cleanup", async () => {
    const fake = fakeClient()
    const lines: string[] = []
    await runDirectMcpProductFlow(fake.client, { localSecretPath: "/local/secret", sleep: fake.sleep, log: (line) => lines.push(line) })
    const creates = fake.calls.filter((call) => call.name === "create_sandbox")
    expect(creates).toHaveLength(2)
    expect(creates[0]!.arguments).not.toHaveProperty("sourceSnapshotId")
    expect(creates[1]!.arguments).toMatchObject({ sourceSnapshotId: snapshotId })
    expect(creates[0]!.arguments.idempotencyKey).not.toBe(creates[1]!.arguments.idempotencyKey)
    expect(fake.calls).toContainEqual({ name: "create_snapshot", arguments: { sandboxId } })
    expect(fake.calls.filter((call) => call.name === "list_snapshots").length).toBeGreaterThan(1)
    expect(fake.calls).toContainEqual(expect.objectContaining({ name: "bash", arguments: expect.objectContaining({ command: "/usr/local/bin/waterbox health; /usr/local/bin/waterbox version" }) }))
    expect(fake.calls).toContainEqual(expect.objectContaining({ name: "read", arguments: { sandboxId: restoredSandboxId, filePath: "/home/user/.waterbox-direct-marker" } }))
    expect(fake.deletions).toEqual([restoredSandboxId, snapshotId, sandboxId])
    expect(lines.join("\n")).toContain('"ready":true')
    expect(lines.join("\n")).toContain('"preserved":true')
    expect(lines.join("\n")).toContain('"reinstalled":true')
    expect(lines.join("\n")).not.toContain(sandboxId)
    expect(lines.join("\n")).not.toContain(snapshotId)
  })

  test("makes one tracked cleanup attempt after a public ID is returned", async () => {
    const fake = fakeClient({ failRuntime: true })
    await expect(runDirectMcpProductFlow(fake.client, { localSecretPath: "/local/secret", sleep: fake.sleep })).rejects.toThrow("runtime unavailable")
    expect(fake.deletions).toEqual([sandboxId])
  })

  test.each([
    ["snapshot creation", { failSnapshotCreate: true }, [sandboxId]],
    ["snapshot readiness", { failSnapshotReadiness: true }, [snapshotId, sandboxId]],
    ["restored creation", { failRestoredCreate: true }, [snapshotId, sandboxId]],
    ["restored verification", { failRestoredVerification: true }, [restoredSandboxId, snapshotId, sandboxId]],
  ] as const)("attempts all tracked cleanup after %s failure", async (_stage, options, expectedDeletions) => {
    const fake = fakeClient(options)
    await expect(runDirectMcpProductFlow(fake.client, { localSecretPath: "/local/secret", sleep: fake.sleep })).rejects.toThrow()
    expect(fake.deletions).toEqual([...expectedDeletions])
  })

  test("continues tracked cleanup after an earlier cleanup action fails", async () => {
    const fake = fakeClient({ failRestoredCleanup: true })
    await expect(runDirectMcpProductFlow(fake.client, { localSecretPath: "/local/secret", sleep: fake.sleep })).rejects.toThrow("tracked cleanup requires manual review")
    expect(fake.deletions).toEqual([restoredSandboxId, snapshotId, sandboxId])
  })

  test("rejects a terminal Bash result that does not explicitly report a hard timeout", async () => {
    const fake = fakeClient({ hardTimeout: false })
    await expect(runDirectMcpProductFlow(fake.client, { localSecretPath: "/local/secret", sleep: fake.sleep })).rejects.toThrow("hard execution timeout")
    expect(fake.deletions).toEqual([sandboxId])
  })

  test("does not start a snapshot flow before a public ID and redacts create failure output", async () => {
    const secret = "box-secret-value"
    const calls: Call[] = [], lines: string[] = []
    const client = { async listTools() { return { tools } }, async callTool(request: Call) { calls.push(request); throw new Error(secret) } }
    await expect(runDirectMcpProductFlow(client, { localSecretPath: "/local/secret", sleep: async () => {}, secrets: [secret], log: (line) => lines.push(line) })).rejects.toThrow("manual review")
    expect(calls.map((call) => call.name)).toEqual(["create_sandbox"])
    expect(lines.join("\n")).not.toContain(secret)
  })

  test("compares the exact visible Box ID set and active count with read-only requests", async () => {
    const baseline: BoxBaseline = { ids: new Set(["bx_baseline1", "bx_baseline2"]), activeBoxes: 2 }
    const methods: Array<string | undefined> = []
    const fetchFor = (ids: string[], activeBoxes: number) => async (input: string | URL | Request, init?: RequestInit) => { methods.push(init?.method); return Response.json(String(input).endsWith("/limits") ? { ok: true, type: "limits.info", activeBoxes } : { ok: true, type: "box.list", boxes: ids.map((id) => ({ id })) }) }
    expect(await compareBoxBaseline("https://box.invalid", "secret", baseline, fetchFor(["bx_baseline1", "bx_replacement"], 2) as typeof fetch)).toEqual({ exactIds: false, activeBoxes: 2 })
    expect(methods.every((method) => method === undefined)).toBe(true)
  })

  test("accepts immediate exact account baseline restoration", async () => {
    const baseline: BoxBaseline = { ids: new Set(["bx_baseline1"]), activeBoxes: 1 }
    await expect(reconcileBoxBaseline("https://box.invalid", "secret", baseline, reconciliationOptions(), fetchSnapshots([{ ids: ["bx_baseline1"], activeBoxes: 1 }]))).resolves.toEqual({ visibleSetRestored: true, activeCountRestored: true, timedOut: false })
  })

  test("waits for delayed visible-set restoration", async () => {
    const baseline: BoxBaseline = { ids: new Set(["bx_baseline1"]), activeBoxes: 1 }
    let now = 0
    const result = await reconcileBoxBaseline("https://box.invalid", "secret", baseline, { ...reconciliationOptions(), now: () => now, sleep: async () => { now++ } }, fetchSnapshots([{ ids: ["bx_probe"], activeBoxes: 1 }, { ids: ["bx_baseline1"], activeBoxes: 1 }]))
    expect(result).toEqual({ visibleSetRestored: true, activeCountRestored: true, timedOut: false })
  })

  test("waits for delayed active-count restoration", async () => {
    const baseline: BoxBaseline = { ids: new Set(["bx_baseline1"]), activeBoxes: 1 }
    let now = 0
    const result = await reconcileBoxBaseline("https://box.invalid", "secret", baseline, { ...reconciliationOptions(), now: () => now, sleep: async () => { now++ } }, fetchSnapshots([{ ids: ["bx_baseline1"], activeBoxes: 2 }, { ids: ["bx_baseline1"], activeBoxes: 1 }]))
    expect(result).toEqual({ visibleSetRestored: true, activeCountRestored: true, timedOut: false })
  })

  test("reports bounded non-convergence without exposing account identities", async () => {
    const secret = "box-secret-value", id = "bx_probe_private"
    let now = 0
    const result = await reconcileBoxBaseline("https://box.invalid", secret, { ids: new Set(["bx_baseline1"]), activeBoxes: 1 }, { ...reconciliationOptions(), pollTimeoutMs: 1, now: () => now, sleep: async () => { now++ } }, fetchSnapshots([{ ids: [id], activeBoxes: 2 }, { ids: [id], activeBoxes: 2 }]))
    expect(result).toEqual({ visibleSetRestored: false, activeCountRestored: false, timedOut: true })
    const error = baselineReconciliationError(result).message
    expect(error).toContain("visible-set restoration")
    expect(error).toContain("active-count restoration")
    expect(error).not.toContain(secret)
    expect(error).not.toContain(id)
  })
})

interface Call { name: string; arguments: Record<string, any> }
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] })
const resource = (id = sandboxId, state = "running", sourceSnapshotId?: string) => ({ sandboxId: id, provider: "box", state, ...(sourceSnapshotId ? { sourceSnapshotId } : {}), version: 1, createdAt: now, updatedAt: now })
const snapshot = (state = "creating") => ({ snapshotId, provider: "box", sourceSandboxId: sandboxId, state, version: 1, createdAt: now, updatedAt: now })

function fakeClient(options: { failRuntime?: boolean; hardTimeout?: boolean; failSnapshotCreate?: boolean; failSnapshotReadiness?: boolean; failRestoredCreate?: boolean; failRestoredVerification?: boolean; failRestoredCleanup?: boolean } = {}) {
  const calls: Call[] = [], deletions: string[] = []
  let marker = "", snapshotLists = 0
  const output = (value = "") => text({ output: value, metadata: {} })
  const bash = (value = "", timedOut = false) => ({ content: [{ type: "text", text: value }], structuredContent: { output: value, metadata: { exitCode: timedOut ? null : 0, timedOut } } })
  const client = {
    async listTools() { return { tools } },
    async callTool(request: Call): Promise<any> {
      calls.push(request)
      if (request.name === "create_sandbox") {
        if (request.arguments.sourceSnapshotId) { if (options.failRestoredCreate) throw new Error("restored create unavailable"); return text(resource(restoredSandboxId, "running", snapshotId)) }
        return text(resource())
      }
      if (request.name === "probe_sandbox") return text(resource(request.arguments.sandboxId))
      if (request.name === "delete_sandbox") { deletions.push(request.arguments.sandboxId); if (options.failRestoredCleanup && request.arguments.sandboxId === restoredSandboxId) throw new Error("cleanup unavailable"); return text(resource(request.arguments.sandboxId, "terminated")) }
      if (request.name === "create_snapshot") { if (options.failSnapshotCreate) throw new Error("snapshot unavailable"); return text(snapshot()) }
      if (request.name === "list_snapshots") { snapshotLists++; return text({ items: [snapshot(options.failSnapshotReadiness ? "failed" : snapshotLists === 1 ? "creating" : "ready")] }) }
      if (request.name === "delete_snapshot") { deletions.push(request.arguments.snapshotId); return text(snapshot("deleted")) }
      if (request.name === "send_file_securely") return text({ bytes: 5 })
      if (request.name === "write" && request.arguments.filePath === "/home/user/.waterbox-direct-marker") { marker = request.arguments.content; return output() }
      if (request.name === "read") return output(request.arguments.filePath === "/home/user/.waterbox-direct-marker" ? marker : "Alpha\n")
      if (request.name === "glob") return output(request.arguments.path === "/root" ? "/root/direct-smoke.txt\n/root/direct-patched.txt\n" : "")
      if (request.name === "grep") return output("/root/direct-smoke.txt:Beta\n")
      const command = String(request.arguments.command)
      if (command.includes("waterbox health")) { if (options.failRuntime || (options.failRestoredVerification && request.arguments.sandboxId === restoredSandboxId)) throw new Error("runtime unavailable"); return bash(`${JSON.stringify({ ok: true, protocolVersion: 2, tools: ["read", "write", "edit", "patch", "glob", "grep", "bash"] })}\n${JSON.stringify({ protocolVersion: 2 })}\n`) }
      if (command.includes("touch /tmp")) { await new Promise((resolve) => setTimeout(resolve, 2)); return bash() }
      if (command.includes("pwd; id -u")) return bash("/root\n0\nBeta\n")
      if (command.includes("explicit-completed")) return bash("explicit-completed")
      if (command.includes("omitted-completed")) return bash("omitted-completed")
      if (command.includes("phase-one")) return bash("phase-onephase-two")
      if (command.includes("conservative-completed")) return bash("conservative-completed")
      if (command === "sleep 30") return bash("", options.hardTimeout !== false)
      return bash()
    },
  }
  return { client, calls, deletions, sleep: async (milliseconds: number) => { if (milliseconds === 7_000) await new Promise(() => {}) } }
}

function reconciliationOptions() { return { pollIntervalMs: 1, pollTimeoutMs: 3, sleep: async () => {} } }
function fetchSnapshots(snapshots: Array<{ ids: string[]; activeBoxes: number }>): typeof fetch {
  let limitsAt = 0, boxesAt = 0
  return (async (input: string | URL | Request) => {
    const snapshot = snapshots[String(input).endsWith("/limits") ? limitsAt++ : boxesAt++] ?? snapshots.at(-1)!
    return Response.json(String(input).endsWith("/limits") ? { ok: true, type: "limits.info", activeBoxes: snapshot.activeBoxes } : { ok: true, type: "box.list", boxes: snapshot.ids.map(id => ({ id })) })
  }) as typeof fetch
}
