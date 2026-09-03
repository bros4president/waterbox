import { describe, expect, test } from "bun:test"
import { assertDirectSmokeAuthorized, baselineReconciliationError, compareBoxBaseline, readBoxBaseline, reconcileBoxBaseline, runDirectMcpProductFlow, runDirectMcpSmoke, type BoxBaseline } from "./direct-mcp-smoke.ts"

const now = "2026-08-31T12:00:00.000Z"
const sandboxId = "sbx_silver-forest-a1"
const restoredSandboxId = "sbx_silver-forest-b2"
const snapshotId = "snap_silver-forest-c3"
const tools = "create_sandbox,probe_sandbox,stop_sandbox,delete_sandbox,list_snapshots,create_snapshot,delete_snapshot,send_file_securely,read,write,edit,patch,glob,grep,bash".split(",").map((name) => ({ name }))

describe("Direct MCP smoke", () => {
  test("requires both destructive-operation gates", () => {
    expect(() => assertDirectSmokeAuthorized({})).toThrow("explicit authorization")
    expect(() => assertDirectSmokeAuthorized({ WATERBOX_MCP_EXPERIMENT_AUTHORIZATION: "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES" })).toThrow("explicit authorization")
    expect(() => assertDirectSmokeAuthorized({ WATERBOX_MCP_EXPERIMENT_AUTHORIZATION: "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES", WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT: "YES" })).not.toThrow()
  })

  test("requires automatic stop before any Box preflight request", async () => {
    await expect(runDirectMcpSmoke({
      WATERBOX_MCP_EXPERIMENT_AUTHORIZATION: "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES",
      WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT: "YES",
      BOX_API_KEY: "test-key",
    })).rejects.toThrow("requires WATERBOX_AUTO_STOP")
  })

  test("runs the snapshot restore flow with distinct create keys and ordered tracked cleanup", async () => {
    const fake = fakeClient()
    const lines: string[] = []
    await runDirectMcpProductFlow(fake.client, { ...productOptions(fake), log: (line) => lines.push(line) })
    const creates = fake.calls.filter((call) => call.name === "create_sandbox")
    expect(creates).toHaveLength(2)
    expect(creates[0]!.arguments).not.toHaveProperty("sourceSnapshotId")
    expect(creates[1]!.arguments).toMatchObject({ sourceSnapshotId: snapshotId })
    expect(creates[0]!.arguments.idempotencyKey).not.toBe(creates[1]!.arguments.idempotencyKey)
    expect(fake.calls).toContainEqual({ name: "create_snapshot", arguments: { sandboxId } })
    expect(fake.calls.filter((call) => call.name === "list_snapshots").length).toBeGreaterThan(1)
    expect(fake.calls).toContainEqual(expect.objectContaining({ name: "bash", arguments: expect.objectContaining({ command: "/usr/local/bin/waterbox health; /usr/local/bin/waterbox version" }) }))
    expect(fake.calls).toContainEqual(expect.objectContaining({ name: "read", arguments: { sandboxId: restoredSandboxId, filePath: "waterbox-direct-marker" } }))
    expect(fake.calls).toContainEqual({ name: "stop_sandbox", arguments: { sandboxId } })
    expect(fake.calls.filter((call) => call.name === "stop_sandbox")).toHaveLength(1)
    expect(fake.calls.filter((call) => call.name === "bash" && call.arguments.command === "printf explicit-stop-resumed")).toHaveLength(1)
    expect(fake.calls.filter((call) => call.name === "bash" && call.arguments.command === "printf automatic-stop-resumed")).toHaveLength(1)
    const markerCommand = fake.calls.find((call) => call.name === "bash" && call.arguments.command === "pwd; cat -- waterbox-direct-marker")
    expect(markerCommand?.arguments).not.toHaveProperty("workdir")
    const indexOf = (predicate: (call: Call) => boolean) => fake.calls.findIndex(predicate)
    const stopAt = indexOf((call) => call.name === "stop_sandbox")
    const explicitResumeAt = indexOf((call) => call.name === "bash" && call.arguments.command === "printf explicit-stop-resumed")
    const markerWriteAt = indexOf((call) => call.name === "write" && call.arguments.filePath === "waterbox-direct-marker")
    const snapshotAt = indexOf((call) => call.name === "create_snapshot")
    const restoredReadAt = indexOf((call) => call.name === "read" && call.arguments.sandboxId === restoredSandboxId && call.arguments.filePath === "waterbox-direct-marker")
    const automaticArmAt = indexOf((call) => call.name === "bash" && call.arguments.command === "printf automatic-stop-armed")
    const automaticResumeAt = indexOf((call) => call.name === "bash" && call.arguments.command === "printf automatic-stop-resumed")
    expect(stopAt).toBeLessThan(explicitResumeAt)
    expect(explicitResumeAt).toBeLessThan(markerWriteAt)
    expect(markerWriteAt).toBeLessThan(snapshotAt)
    expect(snapshotAt).toBeLessThan(restoredReadAt)
    expect(restoredReadAt).toBeLessThan(automaticArmAt)
    expect(automaticArmAt).toBeLessThan(automaticResumeAt)
    expect(fake.calls[automaticArmAt]!.arguments.sandboxId).toBe(restoredSandboxId)
    expect(fake.calls[automaticResumeAt]!.arguments.sandboxId).toBe(restoredSandboxId)
    expect(fake.deletions).toEqual([restoredSandboxId, snapshotId, sandboxId])
    expect(lines.join("\n")).toContain('"ready":true')
    expect(lines.join("\n")).toContain('"preserved":true')
    expect(lines.join("\n")).toContain('"reinstalled":true')
    expect(lines.join("\n")).toContain('"stage":"explicit-stop-ordinary-resume","resumed":true,"logicalToolDispatches":1')
    expect(lines.join("\n")).toContain('"stage":"automatic-stop-ordinary-resume","resumed":true,"logicalToolDispatches":1')
    expect(lines.join("\n")).not.toContain(sandboxId)
    expect(lines.join("\n")).not.toContain(snapshotId)
  })

  test("proves the Vercel relative marker through the provider default command workspace", async () => {
    const runtime = {
      workdir: "/workspace",
      markerPath: "vercel-direct-marker",
      runtimeLauncher: "/workspace/.waterbox/waterbox",
      staleRuntimeCommand: "rm -f /workspace/.waterbox/waterbox-cli.js",
      restoredRuntimeCheck: "test -s /workspace/.waterbox/waterbox-cli.js && test -f /workspace/.waterbox/manifest.json",
    }
    const fake = fakeClient({ workdir: runtime.workdir, markerPath: runtime.markerPath, sourceStaleAfterSnapshot: true })
    await runDirectMcpProductFlow(fake.client, { ...productOptions(fake), runtime })
    expect(fake.calls).toContainEqual({ name: "read", arguments: { sandboxId: restoredSandboxId, filePath: "vercel-direct-marker" } })
    const markerCommand = fake.calls.find((call) => call.name === "bash" && call.arguments.command === "pwd; cat -- vercel-direct-marker")
    expect(markerCommand?.arguments).not.toHaveProperty("workdir")
    expect(fake.calls.filter((call) => call.name === "bash" && call.arguments.command === "printf automatic-stop-armed" && call.arguments.sandboxId === restoredSandboxId)).toHaveLength(1)
    const snapshotAt = fake.calls.findIndex((call) => call.name === "create_snapshot")
    expect(fake.calls.slice(snapshotAt + 1).filter((call) => ["probe_sandbox", "bash"].includes(call.name) && call.arguments.sandboxId === sandboxId)).toHaveLength(0)
    expect(fake.deletions).toEqual([restoredSandboxId, snapshotId, sandboxId])
  })

  test("makes one tracked cleanup attempt after a public ID is returned", async () => {
    const fake = fakeClient({ failRuntime: true })
    await expect(runDirectMcpProductFlow(fake.client, productOptions(fake))).rejects.toThrow("runtime unavailable")
    expect(fake.deletions).toEqual([sandboxId])
  })

  test.each([
    ["snapshot creation", { failSnapshotCreate: true }, [sandboxId]],
    ["snapshot readiness", { failSnapshotReadiness: true }, [snapshotId, sandboxId]],
    ["restored creation", { failRestoredCreate: true }, [snapshotId, sandboxId]],
    ["restored verification", { failRestoredVerification: true }, [restoredSandboxId, snapshotId, sandboxId]],
  ] as const)("attempts all tracked cleanup after %s failure", async (_stage, options, expectedDeletions) => {
    const fake = fakeClient(options)
    await expect(runDirectMcpProductFlow(fake.client, productOptions(fake))).rejects.toThrow()
    expect(fake.deletions).toEqual([...expectedDeletions])
  })

  test("continues tracked cleanup after an earlier cleanup action fails", async () => {
    const fake = fakeClient({ failRestoredCleanup: true })
    await expect(runDirectMcpProductFlow(fake.client, productOptions(fake))).rejects.toThrow("tracked cleanup requires manual review")
    expect(fake.deletions).toEqual([restoredSandboxId, snapshotId, sandboxId])
  })

  test("rejects a terminal Bash result that does not explicitly report a hard timeout", async () => {
    const fake = fakeClient({ hardTimeout: false })
    await expect(runDirectMcpProductFlow(fake.client, productOptions(fake))).rejects.toThrow("hard execution timeout")
    expect(fake.deletions).toEqual([sandboxId])
  })

  test("does not start a snapshot flow before a public ID and redacts create failure output", async () => {
    const secret = "box-secret-value"
    const calls: Call[] = [], lines: string[] = []
    const client = { async listTools() { return { tools } }, async callTool(request: Call) { calls.push(request); throw new Error(secret) } }
    await expect(runDirectMcpProductFlow(client, { localSecretPath: "/local/secret", automaticStopMs: 1, sleep: async () => {}, secrets: [secret], log: (line) => lines.push(line) })).rejects.toThrow("manual review")
    expect(calls.map((call) => call.name)).toEqual(["create_sandbox"])
    expect(lines.join("\n")).not.toContain(secret)
  })

  test.each([
    ["source sandbox", { malformedSourceResponse: true }, [sandboxId]],
    ["snapshot", { malformedSnapshotResponse: true }, [snapshotId, sandboxId]],
    ["restored sandbox", { malformedRestoredResponse: true }, [restoredSandboxId, snapshotId, sandboxId]],
  ] as const)("tracks the %s identifier before response validation can fail", async (_label, options, expectedDeletions) => {
    const fake = fakeClient(options)
    await expect(runDirectMcpProductFlow(fake.client, productOptions(fake))).rejects.toThrow()
    expect(fake.deletions).toEqual([...expectedDeletions])
  })

  test.each([
    ["fresh", { sourceRecoveryError: true }, sandboxId, [sandboxId]],
    ["restored", { restoredRecoveryError: true }, restoredSandboxId, [restoredSandboxId, snapshotId, sandboxId]],
  ] as const)("ledgers and redacts a validated %s create recovery sandbox without replay", async (_label, options, recoveryId, expectedDeletions) => {
    const fake = fakeClient(options)
    let message = ""
    try { await runDirectMcpProductFlow(fake.client, productOptions(fake)) } catch (error) { message = error instanceof Error ? error.message : String(error) }
    expect(message).not.toContain(recoveryId)
    expect(fake.calls.filter((call) => call.name === "create_sandbox")).toHaveLength(recoveryId === restoredSandboxId ? 2 : 1)
    expect(fake.deletions).toEqual([...expectedDeletions])
  })

  test("compares the exact visible Box ID set and active count with read-only requests", async () => {
    const baseline: BoxBaseline = { ids: new Set(["bx_baseline1", "bx_baseline2"]), activeBoxes: 2 }
    const methods: Array<string | undefined> = []
    const fetchFor = (ids: string[], activeBoxes: number) => async (input: string | URL | Request, init?: RequestInit) => { methods.push(init?.method); return Response.json(String(input).endsWith("/limits") ? { ok: true, type: "limits.info", activeBoxes } : { ok: true, type: "box.list", boxes: ids.map((id) => ({ id })) }) }
    expect(await compareBoxBaseline("https://box.invalid", "secret", baseline, fetchFor(["bx_baseline1", "bx_replacement"], 2) as typeof fetch)).toEqual({ exactIds: false, activeBoxes: 2 })
    expect(methods.every((method) => method === undefined)).toBe(true)
  })

  test("requires safe capacity for the two concurrent Boxes in snapshot restore", async () => {
    const response = (maximum: number) => (async (input: string | URL | Request) => Response.json(String(input).endsWith("/limits")
      ? { ok: true, type: "limits.info", canStart: true, activeBoxes: 1, maxActiveBoxes: maximum }
      : { ok: true, type: "box.list", boxes: [{ id: "bx_baseline" }] })) as typeof fetch
    await expect(readBoxBaseline("https://box.invalid", "secret", response(2))).rejects.toThrow("no capacity")
    await expect(readBoxBaseline("https://box.invalid", "secret", response(3))).resolves.toEqual({ ids: new Set(["bx_baseline"]), activeBoxes: 1 })
  })

  test("bounds automatic-stop observation, cleans every tracked resource, and never replays a mutation", async () => {
    const fake = fakeClient({ neverAutoStop: true })
    await expect(runDirectMcpProductFlow(fake.client, productOptions(fake))).rejects.toThrow("automatic stop observation timed out")
    expect(fake.calls.filter((call) => call.name === "stop_sandbox")).toHaveLength(1)
    expect(fake.calls.filter((call) => call.name === "create_snapshot")).toHaveLength(1)
    expect(fake.calls.filter((call) => call.name === "delete_sandbox" && call.arguments.sandboxId === sandboxId)).toHaveLength(1)
    expect(fake.calls.filter((call) => call.name === "delete_sandbox" && call.arguments.sandboxId === restoredSandboxId)).toHaveLength(1)
    expect(fake.calls.filter((call) => call.name === "delete_snapshot")).toHaveLength(1)
    expect(fake.deletions).toEqual([restoredSandboxId, snapshotId, sandboxId])
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

function fakeClient(options: { failRuntime?: boolean; hardTimeout?: boolean; failSnapshotCreate?: boolean; failSnapshotReadiness?: boolean; failRestoredCreate?: boolean; failRestoredVerification?: boolean; failRestoredCleanup?: boolean; neverAutoStop?: boolean; malformedSourceResponse?: boolean; malformedSnapshotResponse?: boolean; malformedRestoredResponse?: boolean; sourceRecoveryError?: boolean; restoredRecoveryError?: boolean; sourceStaleAfterSnapshot?: boolean; workdir?: string; markerPath?: string } = {}) {
  const calls: Call[] = [], deletions: string[] = []
  let marker = "", snapshotLists = 0, clock = 0
  const workdir = options.workdir ?? "/home/user/workspace", markerPath = options.markerPath ?? "waterbox-direct-marker"
  const states = new Map([[sandboxId, "running"], [restoredSandboxId, "running"]])
  const probes = new Map<string, number>()
  const output = (value = "") => text({ output: value, metadata: {} })
  const bash = (value = "", timedOut = false) => ({ content: [{ type: "text", text: value }], structuredContent: { output: value, metadata: { exitCode: timedOut ? null : 0, timedOut } } })
  const client = {
    async listTools() { return { tools } },
    async callTool(request: Call): Promise<any> {
      calls.push(request)
      if (request.name === "create_sandbox") {
        if (request.arguments.sourceSnapshotId && options.restoredRecoveryError) return errorWithRecovery(restoredSandboxId)
        if (!request.arguments.sourceSnapshotId && options.sourceRecoveryError) return errorWithRecovery(sandboxId)
        if (request.arguments.sourceSnapshotId) { if (options.failRestoredCreate) throw new Error("restored create unavailable"); return text(options.malformedRestoredResponse ? { ...resource(restoredSandboxId, "running", snapshotId), provider: 42 } : resource(restoredSandboxId, "running", snapshotId)) }
        return text(options.malformedSourceResponse ? { ...resource(), provider: 42 } : resource())
      }
      if (request.name === "probe_sandbox") {
        const count = (probes.get(request.arguments.sandboxId) ?? 0) + 1
        probes.set(request.arguments.sandboxId, count)
        if (request.arguments.sandboxId === restoredSandboxId && count >= 3 && !options.neverAutoStop) states.set(restoredSandboxId, "stopped")
        return text(resource(request.arguments.sandboxId, states.get(request.arguments.sandboxId) ?? "running"))
      }
      if (request.name === "stop_sandbox") { states.set(request.arguments.sandboxId, "stopped"); return text(resource(request.arguments.sandboxId, "stopped")) }
      if (request.name === "delete_sandbox") { deletions.push(request.arguments.sandboxId); if (options.failRestoredCleanup && request.arguments.sandboxId === restoredSandboxId) throw new Error("cleanup unavailable"); return text(resource(request.arguments.sandboxId, "terminated")) }
      if (request.name === "create_snapshot") { if (options.failSnapshotCreate) throw new Error("snapshot unavailable"); if (options.sourceStaleAfterSnapshot) states.set(sandboxId, "failed"); return text(options.malformedSnapshotResponse ? { ...snapshot(), provider: 42 } : snapshot()) }
      if (request.name === "list_snapshots") { snapshotLists++; return text({ items: [snapshot(options.failSnapshotReadiness ? "failed" : snapshotLists === 1 ? "creating" : "ready")] }) }
      if (request.name === "delete_snapshot") { deletions.push(request.arguments.snapshotId); return text(snapshot("deleted")) }
      if (request.name === "send_file_securely") return text({ bytes: 5 })
      if (request.name === "write" && request.arguments.filePath === markerPath) { marker = request.arguments.content; return output() }
      if (request.name === "read") return output(request.arguments.filePath === markerPath ? marker : "Alpha\n")
      if (request.name === "glob") return output(request.arguments.path === workdir ? `${workdir}/direct-smoke.txt\n${workdir}/direct-patched.txt\n` : "")
      if (request.name === "grep") return output(`${workdir}/direct-smoke.txt:Beta\n`)
      const command = String(request.arguments.command)
      if (command === "printf explicit-stop-resumed" || command === "printf automatic-stop-armed" || command === "printf automatic-stop-resumed") { states.set(request.arguments.sandboxId, "running"); return bash(command.replace("printf ", "")) }
      if (command === `pwd; cat -- ${markerPath}`) return bash(`${workdir}\n${marker}`)
      if (command.includes("waterbox health")) { if (options.failRuntime || (options.failRestoredVerification && request.arguments.sandboxId === restoredSandboxId)) throw new Error("runtime unavailable"); return bash(`${JSON.stringify({ ok: true, protocolVersion: 2, tools: ["read", "write", "edit", "patch", "glob", "grep", "bash"] })}\n${JSON.stringify({ protocolVersion: 2 })}\n`) }
      if (command.includes("touch /tmp")) { await new Promise((resolve) => setTimeout(resolve, 2)); return bash() }
      if (command.includes("pwd; id -u")) return bash(`${workdir}\n1000\nBeta\n`)
      if (command.includes("explicit-completed")) return bash("explicit-completed")
      if (command.includes("omitted-completed")) return bash("omitted-completed")
      if (command.includes("phase-one")) return bash("phase-onephase-two")
      if (command.includes("conservative-completed")) return bash("conservative-completed")
      if (command === "sleep 30") return bash("", options.hardTimeout !== false)
      return bash()
    },
  }
  return { client, calls, deletions, now: () => clock, sleep: async (milliseconds: number) => { if (milliseconds === 7_000) await new Promise(() => {}); clock += milliseconds } }
}

function errorWithRecovery(id: string) {
  return { isError: true, content: [{ type: "text", text: `Sandbox creation failed. Recovery sandbox: ${id}. Retry creation only with the same idempotency key.` }] }
}

function productOptions(fake: ReturnType<typeof fakeClient>) {
  return { localSecretPath: "/local/secret", automaticStopMs: 2, automaticStopGraceMs: 1, automaticStopPollIntervalMs: 1, now: fake.now, sleep: fake.sleep }
}

function reconciliationOptions() { return { pollIntervalMs: 1, pollTimeoutMs: 3, sleep: async () => {} } }
function fetchSnapshots(snapshots: Array<{ ids: string[]; activeBoxes: number }>): typeof fetch {
  let limitsAt = 0, boxesAt = 0
  return (async (input: string | URL | Request) => {
    const snapshot = snapshots[String(input).endsWith("/limits") ? limitsAt++ : boxesAt++] ?? snapshots.at(-1)!
    return Response.json(String(input).endsWith("/limits") ? { ok: true, type: "limits.info", activeBoxes: snapshot.activeBoxes } : { ok: true, type: "box.list", boxes: snapshot.ids.map(id => ({ id })) })
  }) as typeof fetch
}
