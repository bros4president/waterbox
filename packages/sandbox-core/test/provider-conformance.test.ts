import { describe, expect, test } from "bun:test"
import type { ProviderCapabilities, SandboxId, SnapshotId, ToolName } from "@waterbox/contracts"
import { ProviderError, type ProviderCreateSandboxInput, type ProviderCreateSnapshotInput, type ProviderExecuteInput, type ProviderOperationInput, type ProviderSandboxObservation, type ProviderSnapshotObservation, type ProviderSnapshotOperationInput, type SandboxProvider, type ToolEventByName } from "../src/provider.ts"
import type { JsonValue } from "../src/records.ts"
import { exerciseProviderConformance, type ProviderConformanceInstrumentation, type ProviderConformanceLifecycleRequest, type ProviderConformanceOperation, type ProviderConformanceSnapshotRequest, type ProviderConformanceToolRequest } from "../src/test-support.ts"

type BrokenMode = "none" | "misroute" | "fabricate" | "reuse"
type ContinuityOperation = ProviderConformanceLifecycleRequest["operation"] | ProviderConformanceSnapshotRequest["operation"]
type ContinuityField = "accountId" | "snapshotId" | "resourceIdentity" | "providerRef" | "signal"
interface ContinuityCorruption { operation: ContinuityOperation; field: ContinuityField }

class InstrumentedProvider implements SandboxProvider {
  readonly name = "instrumented"
  readonly capabilities: ProviderCapabilities = { suspend: true, resume: true, snapshots: true, createFromSnapshot: true, fork: true, streaming: true }
  readonly counts = new Map<ProviderConformanceOperation, number>()
  readonly creates: Array<{ idempotencyKey: string; fingerprint: string }> = []
  readonly tools: ProviderConformanceToolRequest[] = []
  readonly lifecycle: ProviderConformanceLifecycleRequest[] = []
  readonly snapshots: ProviderConformanceSnapshotRequest[] = []
  ambiguous = false
  constructor(readonly mode: BrokenMode = "none", readonly corruption?: ContinuityCorruption) {}
  #count(name: ProviderConformanceOperation) { this.counts.set(name, (this.counts.get(name) ?? 0) + 1) }
  async createSandbox(input: ProviderCreateSandboxInput): Promise<ProviderSandboxObservation> { this.#count("createSandbox"); this.creates.push({ idempotencyKey: input.idempotencyKey, fingerprint: JSON.stringify({ sandboxId: input.sandboxId }) }); return { state: "running", providerRef: { kind: "test-sandbox", id: input.sandboxId } } }
  async inspectSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> { this.#count("inspectSandbox"); requireRef(input.providerRef, "test-sandbox"); this.recordLifecycle("inspectSandbox", input); return { state: "running", providerRef: input.providerRef } }
  async suspendSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> { this.#count("suspendSandbox"); this.recordLifecycle("suspendSandbox", input); return { state: "suspended", providerRef: input.providerRef } }
  async resumeSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> { this.#count("resumeSandbox"); this.recordLifecycle("resumeSandbox", input); return { state: "running", providerRef: input.providerRef } }
  async deleteSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> { this.#count("deleteSandbox"); this.recordLifecycle("deleteSandbox", input); return { state: "terminated", providerRef: input.providerRef } }
  async createSnapshot(input: ProviderCreateSnapshotInput): Promise<ProviderSnapshotObservation> { this.#count("createSnapshot"); const providerRef = this.corruptRef("createSnapshot", input.sandboxRef); this.snapshots.push({ operation: "createSnapshot", accountId: this.corruptAccount("createSnapshot", input.accountId), snapshotId: this.corruptId("createSnapshot", input.snapshotId), providerRef, sandboxIdentity: this.corruptIdentity("createSnapshot", identity(providerRef)), signal: this.corruptSignal("createSnapshot", input.signal) }); return { state: "creating", providerRef: { kind: "test-snapshot", id: input.snapshotId } } }
  async inspectSnapshot(input: ProviderSnapshotOperationInput): Promise<ProviderSnapshotObservation> { this.#count("inspectSnapshot"); this.recordSnapshot("inspectSnapshot", input); return { state: "ready", providerRef: input.providerRef } }
  async deleteSnapshot(input: ProviderSnapshotOperationInput): Promise<ProviderSnapshotObservation> { this.#count("deleteSnapshot"); this.recordSnapshot("deleteSnapshot", input); return { state: "deleted", providerRef: input.providerRef } }
  recordLifecycle(operation: ProviderConformanceLifecycleRequest["operation"], input: ProviderOperationInput) { const providerRef = this.corruptRef(operation, input.providerRef); this.lifecycle.push({ operation, accountId: this.corruptAccount(operation, input.accountId), providerRef, sandboxIdentity: this.corruptIdentity(operation, identity(providerRef)), signal: this.corruptSignal(operation, input.signal) }) }
  recordSnapshot(operation: "inspectSnapshot" | "deleteSnapshot", input: ProviderSnapshotOperationInput) { const providerRef = this.corruptRef(operation, input.providerRef); this.snapshots.push({ operation, accountId: this.corruptAccount(operation, input.accountId), snapshotId: this.corruptId(operation, input.snapshotId), providerRef, snapshotIdentity: this.corruptIdentity(operation, identity(providerRef)), signal: this.corruptSignal(operation, input.signal) }) }
  corrupts(operation: ContinuityOperation, field: ContinuityField): boolean { return this.corruption?.operation === operation && this.corruption.field === field }
  corruptAccount(operation: ContinuityOperation, accountId: string): string { return this.corrupts(operation, "accountId") ? `${accountId}-misrouted` : accountId }
  corruptId(operation: ContinuityOperation, snapshotId: SnapshotId): SnapshotId { return this.corrupts(operation, "snapshotId") ? "snap_wrong-id-a1" as SnapshotId : snapshotId }
  corruptIdentity(operation: ContinuityOperation, value: string): string { return this.corrupts(operation, "resourceIdentity") ? `${value}-misrouted` : value }
  corruptRef(operation: ContinuityOperation, value: JsonValue): JsonValue { const copy = structuredClone(value); return this.corrupts(operation, "providerRef") && typeof copy === "object" && copy !== null && !Array.isArray(copy) ? { ...copy, continuitySentinel: "misrouted" } : copy }
  corruptSignal(operation: ContinuityOperation, signal: AbortSignal): AbortSignal { return this.corrupts(operation, "signal") ? new AbortController().signal : signal }
  executeTool<N extends ToolName>(input: ProviderExecuteInput<N>): AsyncIterable<ToolEventByName[N]> {
    input.signal.throwIfAborted()
    this.#count("executeTool")
    const expected = eventsFor(input.toolName, input.arguments as Record<string, unknown>)
    const recordedArguments = this.mode === "misroute" && input.toolName === "read" ? { filePath: "/workspace/dropped.txt" } : structuredClone(input.arguments) as JsonValue
    this.tools.push({ toolName: input.toolName, arguments: recordedArguments, sandboxIdentity: identity(input.providerRef), signal: input.signal, expectedEvents: expected })
    const ambiguous = this.ambiguous
    this.ambiguous = false
    const mode = this.mode
    return (async function* () {
      if (ambiguous) throw new ProviderError("ambiguous_execution", "ambiguous")
      let actual = expected
      if (mode === "fabricate" && input.toolName === "read") actual = [{ ...(expected[0] as Record<string, JsonValue>), output: "fabricated" }]
      if (mode === "reuse" && input.toolName === "write") actual = eventsFor("read", { filePath: "/workspace/reused.txt" })
      for (const event of actual) yield event as ToolEventByName[N]
    })()
  }
}

function instrumentation(provider: InstrumentedProvider): ProviderConformanceInstrumentation {
  return {
    count: (operation) => provider.counts.get(operation) ?? 0,
    createRequests: () => provider.creates,
    toolRequests: () => provider.tools,
    lifecycleRequests: () => provider.lifecycle,
    snapshotRequests: () => provider.snapshots,
    sandboxIdentity: identity,
    snapshotIdentity: identity,
    arrangeAmbiguousExecution: () => { provider.ambiguous = true },
  }
}
function fixture(provider: InstrumentedProvider) {
  return { accountId: "acct-conformance", sandboxId: "sbx_calm-cactus-7k3m" as SandboxId, snapshotId: "snap_silver-forest-2p9x" as SnapshotId, idempotencyKey: "conformance-key", instrumentation: instrumentation(provider) }
}
function identity(value: JsonValue): string { if (typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.id === "string") return value.id; return "" }
function requireRef(value: JsonValue, kind: string): void { if (typeof value !== "object" || value === null || Array.isArray(value) || value.kind !== kind) throw new ProviderError("failure", "invalid ref") }

function eventsFor(tool: ToolName, args: Record<string, unknown>): JsonValue[] {
  if (tool === "read") return [{ type: "result", title: "Read sentinel", output: `read:${args.filePath}`, metadata: { filePath: String(args.filePath), offset: Number(args.offset ?? 1) } }]
  if (tool === "write") return [{ type: "result", title: "Write sentinel", output: `write:${args.content}`, metadata: { filePath: String(args.filePath), bytes: String(args.content).length } }]
  if (tool === "edit") return [{ type: "result", title: "Edit sentinel", output: `edit:${args.newString}`, metadata: { filePath: String(args.filePath), replacements: 1, bytes: String(args.newString).length } }]
  if (tool === "patch") return [{ type: "result", title: "Patch sentinel", output: String(args.patchText), metadata: { added: ["patch-sentinel.txt"], updated: [], deleted: [], moved: [] } }]
  if (tool === "glob") return [{ type: "result", title: "Glob sentinel", output: String(args.pattern), metadata: { pattern: String(args.pattern), path: String(args.path), count: 1, truncated: false } }]
  if (tool === "grep") return [{ type: "result", title: "Grep sentinel", output: String(args.pattern), metadata: { pattern: String(args.pattern), path: String(args.path), include: String(args.include), matches: 1, truncated: false } }]
  return [
    { type: "stdout", data: `stdout:${args.command}` },
    { type: "stderr", data: `stderr:${args.description}` },
    { type: "result", title: "Bash sentinel", output: String(args.command), metadata: { command: String(args.command), description: String(args.description), workdir: String(args.workdir), exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } },
  ]
}

describe("provider conformance harness self-tests", () => {
  test("accepts a fully instrumented conforming provider", async () => {
    const provider = new InstrumentedProvider()
    await expect(exerciseProviderConformance(provider, fixture(provider))).resolves.toMatchObject({ ambiguityObserved: true })
  })
  test("rejects missing, extra, and nonboolean capability shapes before exercising paths", async () => {
    for (const capabilities of [
      { suspend: true },
      { suspend: true, resume: true, snapshots: true, createFromSnapshot: true, fork: true, streaming: true, extra: true },
      { suspend: true, resume: true, snapshots: true, createFromSnapshot: true, fork: true, streaming: "yes" },
    ]) {
      const provider = new InstrumentedProvider()
      Object.defineProperty(provider, "capabilities", { value: capabilities })
      await expect(exerciseProviderConformance(provider, fixture(provider))).rejects.toThrow("Provider capabilities are invalid")
      expect(provider.counts.size).toBe(0)
    }
  })
  test("requires exact false capabilities to reject unsupported lifecycle and snapshot calls without dispatch", async () => {
    const provider = new InstrumentedProvider()
    Object.defineProperty(provider, "capabilities", { value: { suspend: false, resume: false, snapshots: false, createFromSnapshot: false, fork: false, streaming: true } })
    provider.suspendSandbox = async () => { throw new ProviderError("failure", "unsupported") }
    provider.resumeSandbox = async () => { throw new ProviderError("failure", "unsupported") }
    provider.createSnapshot = async () => { throw new ProviderError("failure", "unsupported") }
    const trace = await exerciseProviderConformance(provider, fixture(provider))
    expect(trace.suspended).toBeUndefined()
    expect(trace.snapshotCreated).toBeUndefined()
    expect(provider.counts.get("suspendSandbox") ?? 0).toBe(0)
    expect(provider.counts.get("resumeSandbox") ?? 0).toBe(0)
    expect(provider.counts.get("createSnapshot") ?? 0).toBe(0)
  })
  test("rejects dropped or misrouted distinctive arguments", async () => {
    const provider = new InstrumentedProvider("misroute")
    await expect(exerciseProviderConformance(provider, fixture(provider))).rejects.toThrow("Provider read request continuity is invalid")
  })
  test("rejects every independently corrupted lifecycle and snapshot continuity field", async () => {
    const cases: ContinuityCorruption[] = [
      ...(["inspectSandbox", "suspendSandbox", "resumeSandbox", "deleteSandbox"] as const).flatMap((operation) =>
        (["accountId", "resourceIdentity", "providerRef", "signal"] as const).map((field) => ({ operation, field })),
      ),
      ...(["createSnapshot", "inspectSnapshot", "deleteSnapshot"] as const).flatMap((operation) =>
        (["accountId", "snapshotId", "resourceIdentity", "providerRef", "signal"] as const).map((field) => ({ operation, field })),
      ),
    ]
    for (const corruption of cases) {
      const provider = new InstrumentedProvider("none", corruption)
      try {
        await exerciseProviderConformance(provider, fixture(provider))
        throw new Error(`Expected ${corruption.operation}.${corruption.field} corruption to be rejected`)
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe(`Provider ${corruption.operation} request continuity is invalid`)
        expect(provider.counts.get(corruption.operation)).toBe(1)
      }
    }
  })
  test("rejects fabricated and reused events even when they remain structurally valid", async () => {
    const fabricated = new InstrumentedProvider("fabricate")
    await expect(exerciseProviderConformance(fabricated, fixture(fabricated))).rejects.toThrow("Provider read events are not tied to their invocation")
    const reused = new InstrumentedProvider("reuse")
    await expect(exerciseProviderConformance(reused, fixture(reused))).rejects.toThrow()
  })
})
