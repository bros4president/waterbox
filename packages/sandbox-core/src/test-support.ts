import type {
  ProviderCapabilities,
  SandboxId,
  SandboxState,
  SnapshotId,
  SnapshotState,
  ToolName,
} from "@waterbox/contracts"
import {
  BashToolEventSchema, EditToolEventSchema, GlobToolEventSchema, GrepToolEventSchema,
  PatchToolEventSchema, ReadToolEventSchema, WriteToolEventSchema,
} from "@waterbox/contracts"
import type {
  IdempotencyKey,
  IdempotencyRepository,
  ListRepositoryInput,
  RepositoryPage,
  SandboxRepository,
  SnapshotRepository,
} from "./ports.ts"
import type {
  ProviderCreateSandboxInput,
  ProviderCreateSnapshotInput,
  ProviderExecuteInput,
  ProviderOperationInput,
  ProviderSandboxObservation,
  ProviderSnapshotObservation,
  ProviderSnapshotOperationInput,
  SandboxProvider,
  ToolEventByName,
} from "./provider.ts"
import { ProviderError } from "./provider.ts"
import type { IdempotencyRecord, JsonValue, SandboxRecord, SnapshotRecord } from "./records.ts"

function clone<T>(value: T): T {
  return structuredClone(value)
}

function page<T>(records: T[], input: ListRepositoryInput): RepositoryPage<T> {
  const offset = input.cursor === undefined ? 0 : decodeCursor(input.cursor)
  const items = records.slice(offset, offset + input.limit).map(clone)
  const nextOffset = offset + items.length
  return { items, ...(nextOffset < records.length ? { nextCursor: `test-cursor:${nextOffset}` } : {}) }
}

function decodeCursor(cursor: string): number {
  const match = /^test-cursor:(\d+)$/.exec(cursor)
  if (match?.[1] === undefined) throw new Error("Invalid test cursor")
  return Number(match[1])
}

export class InMemorySandboxRepository implements SandboxRepository {
  readonly #records = new Map<string, SandboxRecord>()

  async createIfAbsent(record: SandboxRecord): Promise<boolean> {
    const key = sandboxKey(record.accountId, record.sandboxId)
    if (this.#records.has(key)) return false
    this.#records.set(key, clone(record))
    return true
  }

  async get(accountId: string, sandboxId: SandboxId): Promise<SandboxRecord | undefined> {
    const record = this.#records.get(sandboxKey(accountId, sandboxId))
    return record === undefined ? undefined : clone(record)
  }

  async list(input: ListRepositoryInput): Promise<RepositoryPage<SandboxRecord>> {
    const records = [...this.#records.values()]
      .filter((record) => record.accountId === input.accountId)
      .sort((left, right) => left.sandboxId.localeCompare(right.sandboxId))
    return page(records, input)
  }

  async compareAndSwap(record: SandboxRecord, expectedVersion: number): Promise<boolean> {
    const key = sandboxKey(record.accountId, record.sandboxId)
    const current = this.#records.get(key)
    if (current?.version !== expectedVersion || record.version !== expectedVersion + 1) return false
    this.#records.set(key, clone(record))
    return true
  }

  async conditionalDelete(accountId: string, sandboxId: SandboxId, expectedVersion: number): Promise<boolean> {
    const key = sandboxKey(accountId, sandboxId)
    if (this.#records.get(key)?.version !== expectedVersion) return false
    return this.#records.delete(key)
  }
}

export class InMemorySnapshotRepository implements SnapshotRepository {
  readonly #records = new Map<string, SnapshotRecord>()

  async createIfAbsent(record: SnapshotRecord): Promise<boolean> {
    const key = snapshotKey(record.accountId, record.snapshotId)
    if (this.#records.has(key)) return false
    this.#records.set(key, clone(record))
    return true
  }

  async get(accountId: string, snapshotId: SnapshotId): Promise<SnapshotRecord | undefined> {
    const record = this.#records.get(snapshotKey(accountId, snapshotId))
    return record === undefined ? undefined : clone(record)
  }

  async list(input: ListRepositoryInput): Promise<RepositoryPage<SnapshotRecord>> {
    const records = [...this.#records.values()]
      .filter((record) => record.accountId === input.accountId)
      .sort((left, right) => left.snapshotId.localeCompare(right.snapshotId))
    return page(records, input)
  }

  async compareAndSwap(record: SnapshotRecord, expectedVersion: number): Promise<boolean> {
    const key = snapshotKey(record.accountId, record.snapshotId)
    const current = this.#records.get(key)
    if (current?.version !== expectedVersion || record.version !== expectedVersion + 1) return false
    this.#records.set(key, clone(record))
    return true
  }

  async conditionalDelete(accountId: string, snapshotId: SnapshotId, expectedVersion: number): Promise<boolean> {
    const key = snapshotKey(accountId, snapshotId)
    if (this.#records.get(key)?.version !== expectedVersion) return false
    return this.#records.delete(key)
  }
}

export class InMemoryIdempotencyRepository implements IdempotencyRepository {
  readonly #records = new Map<string, IdempotencyRecord>()

  async createIfAbsent(record: IdempotencyRecord): Promise<boolean> {
    const key = idempotencyKey(record)
    if (this.#records.has(key)) return false
    this.#records.set(key, clone(record))
    return true
  }

  async get(input: IdempotencyKey): Promise<IdempotencyRecord | undefined> {
    const record = this.#records.get(idempotencyKey(input))
    return record === undefined ? undefined : clone(record)
  }

  async list(input: ListRepositoryInput): Promise<RepositoryPage<IdempotencyRecord>> {
    const records = [...this.#records.values()]
      .filter((record) => record.accountId === input.accountId)
      .sort((left, right) => `${left.scope}\u0000${left.key}`.localeCompare(`${right.scope}\u0000${right.key}`))
    return page(records, input)
  }

  async compareAndSwap(record: IdempotencyRecord, expectedVersion: number): Promise<boolean> {
    const key = idempotencyKey(record)
    const current = this.#records.get(key)
    if (current?.version !== expectedVersion || record.version !== expectedVersion + 1) return false
    this.#records.set(key, clone(record))
    return true
  }

  async conditionalDelete(input: IdempotencyKey, expectedVersion: number): Promise<boolean> {
    const key = idempotencyKey(input)
    if (this.#records.get(key)?.version !== expectedVersion) return false
    return this.#records.delete(key)
  }
}

export class FixedClock {
  #current: Date

  constructor(value = "2026-01-01T00:00:00.000Z") {
    this.#current = new Date(value)
  }

  now(): Date {
    return new Date(this.#current)
  }

  advance(milliseconds: number): void {
    this.#current = new Date(this.#current.getTime() + milliseconds)
  }
}

export class SequenceIdGenerator {
  readonly #sandboxIds: string[]
  readonly #snapshotIds: string[]

  constructor(sandboxIds: string[] = [], snapshotIds: string[] = []) {
    this.#sandboxIds = [...sandboxIds]
    this.#snapshotIds = [...snapshotIds]
  }

  sandboxId(): string {
    const id = this.#sandboxIds.shift()
    if (id === undefined) throw new Error("No sandbox test ID remains")
    return id
  }

  snapshotId(): string {
    const id = this.#snapshotIds.shift()
    if (id === undefined) throw new Error("No snapshot test ID remains")
    return id
  }
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly name: string
  readonly capabilities: ProviderCapabilities
  createCalls = 0
  inspectSandboxCalls = 0
  suspendCalls = 0
  resumeCalls = 0
  deleteCalls = 0
  createSnapshotCalls = 0
  inspectSnapshotCalls = 0
  deleteSnapshotCalls = 0
  executeCalls = 0
  createBarrier?: Promise<void>
  resumeBarrier?: Promise<void>
  executeError?: unknown
  readonly providerIdempotencyKeys: string[] = []
  readonly sandboxStates = new Map<string, SandboxState>()
  readonly snapshotStates = new Map<string, SnapshotState>()

  constructor(options: { name?: string; capabilities?: Partial<ProviderCapabilities> } = {}) {
    this.name = options.name ?? "fake"
    this.capabilities = {
      suspend: true,
      resume: true,
      snapshots: true,
      createFromSnapshot: true,
      fork: true,
      streaming: true,
      ...options.capabilities,
    }
  }

  async createSandbox(input: ProviderCreateSandboxInput): Promise<ProviderSandboxObservation> {
    this.createCalls++
    this.providerIdempotencyKeys.push(input.idempotencyKey)
    await this.createBarrier
    this.sandboxStates.set(input.sandboxId, "running")
    return { state: "running", providerRef: sandboxRef(input.sandboxId) }
  }

  async inspectSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    this.inspectSandboxCalls++
    const id = refId(input.providerRef)
    return { state: this.sandboxStates.get(id) ?? "provisioning", providerRef: input.providerRef }
  }

  async suspendSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    this.suspendCalls++
    const id = refId(input.providerRef)
    this.sandboxStates.set(id, "suspended")
    return { state: "suspended", providerRef: input.providerRef }
  }

  async resumeSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    this.resumeCalls++
    await this.resumeBarrier
    const id = refId(input.providerRef)
    this.sandboxStates.set(id, "running")
    return { state: "running", providerRef: input.providerRef }
  }

  async deleteSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    this.deleteCalls++
    const id = refId(input.providerRef)
    this.sandboxStates.set(id, "terminated")
    return { state: "terminated", providerRef: input.providerRef }
  }

  async createSnapshot(input: ProviderCreateSnapshotInput): Promise<ProviderSnapshotObservation> {
    this.createSnapshotCalls++
    this.snapshotStates.set(input.snapshotId, "ready")
    return { state: "ready", providerRef: snapshotRef(input.snapshotId) }
  }

  async inspectSnapshot(input: ProviderSnapshotOperationInput): Promise<ProviderSnapshotObservation> {
    this.inspectSnapshotCalls++
    const id = refId(input.providerRef)
    return { state: this.snapshotStates.get(id) ?? "creating", providerRef: input.providerRef }
  }

  async deleteSnapshot(input: ProviderSnapshotOperationInput): Promise<ProviderSnapshotObservation> {
    this.deleteSnapshotCalls++
    const id = refId(input.providerRef)
    this.snapshotStates.set(id, "deleted")
    return { state: "deleted", providerRef: input.providerRef }
  }

  executeTool<N extends ToolName>(input: ProviderExecuteInput<N>): AsyncIterable<ToolEventByName[N]> {
    this.executeCalls++
    const error = this.executeError
    return (async function* () {
      if (error !== undefined) throw error
      yield { type: "result", title: input.toolName, output: "ok", metadata: {} } as ToolEventByName[N]
    })()
  }
}

export interface ProviderConformanceFixture {
  accountId: string
  sandboxId: SandboxId
  snapshotId: SnapshotId
  idempotencyKey: string
  signal?: AbortSignal
  instrumentation: ProviderConformanceInstrumentation
}

export type ProviderConformanceOperation = "createSandbox" | "inspectSandbox" | "suspendSandbox" | "resumeSandbox" | "deleteSandbox" | "createSnapshot" | "inspectSnapshot" | "deleteSnapshot" | "executeTool"
export interface ProviderConformanceInstrumentation {
  count(operation: ProviderConformanceOperation): number
  createRequests(): ReadonlyArray<{ idempotencyKey: string; fingerprint: string }>
  toolRequests(): readonly ProviderConformanceToolRequest[]
  lifecycleRequests(): readonly ProviderConformanceLifecycleRequest[]
  snapshotRequests(): readonly ProviderConformanceSnapshotRequest[]
  sandboxIdentity(reference: JsonValue): string
  snapshotIdentity(reference: JsonValue): string
  arrangeAmbiguousExecution(): void
}
export interface ProviderConformanceLifecycleRequest {
  operation: "inspectSandbox" | "suspendSandbox" | "resumeSandbox" | "deleteSandbox"
  accountId: string
  providerRef: JsonValue
  sandboxIdentity: string
  signal: AbortSignal
}
export interface ProviderConformanceSnapshotRequest {
  operation: "createSnapshot" | "inspectSnapshot" | "deleteSnapshot"
  accountId: string
  snapshotId: SnapshotId
  providerRef: JsonValue
  sandboxIdentity?: string
  snapshotIdentity?: string
  signal: AbortSignal
}
export interface ProviderConformanceToolRequest {
  toolName: ToolName
  arguments: JsonValue
  sandboxIdentity: string
  signal: AbortSignal
  expectedEvents: readonly JsonValue[]
}
export interface ProviderConformanceTrace {
  created: ProviderSandboxObservation
  replayed: ProviderSandboxObservation
  inspected: ProviderSandboxObservation
  suspended?: ProviderSandboxObservation
  resumed?: ProviderSandboxObservation
  snapshotCreated?: ProviderSnapshotObservation
  snapshotInspected?: ProviderSnapshotObservation
  snapshotDeleted?: ProviderSnapshotObservation
  deleted: ProviderSandboxObservation
  toolEvents: { [N in ToolName]: ToolEventByName[N][] }
  cancellationReason: unknown
  invalidReferenceRejected: boolean
  ambiguityObserved: boolean
}

/**
 * Reusable behavioral exercise for provider adapter tests. It intentionally lives
 * in the test-support export and knows nothing about any concrete provider DTO.
 */
export async function exerciseProviderConformance(
  provider: SandboxProvider,
  fixture: ProviderConformanceFixture,
): Promise<ProviderConformanceTrace> {
  const signal = fixture.signal ?? new AbortController().signal
  const observe = fixture.instrumentation
  assertCapabilities(provider.capabilities)
  if (!provider.name) throw new Error("Provider name is invalid")
  const createInput = { accountId: fixture.accountId, sandboxId: fixture.sandboxId, idempotencyKey: fixture.idempotencyKey, signal }
  const createBefore = observe.count("createSandbox")
  const createRequestBefore = observe.createRequests().length
  const created = await provider.createSandbox(createInput)
  assertState(created, "running", "create")
  const sandboxIdentity = observe.sandboxIdentity(created.providerRef)
  assertOpaqueReference(created.providerRef, sandboxIdentity, observe.sandboxIdentity)
  const replayed = await provider.createSandbox(createInput)
  assertState(replayed, "running", "create replay")
  assertOpaqueReference(replayed.providerRef, sandboxIdentity, observe.sandboxIdentity)
  assertDelta(observe, "createSandbox", createBefore, 2)
  const createRequests = observe.createRequests().slice(createRequestBefore)
  if (createRequests.length !== 2 || createRequests.some((request) => request.idempotencyKey !== fixture.idempotencyKey) || createRequests[0]?.fingerprint !== createRequests[1]?.fingerprint) throw new Error("Provider did not preserve stable create idempotency and request continuity")
  const inspectBefore = observe.count("inspectSandbox")
  const inspectRequestBefore = observe.lifecycleRequests().length
  const inspected = await provider.inspectSandbox({ accountId: fixture.accountId, providerRef: created.providerRef, signal })
  assertState(inspected, "running", "inspect")
  assertOpaqueReference(inspected.providerRef, sandboxIdentity, observe.sandboxIdentity)
  assertDelta(observe, "inspectSandbox", inspectBefore, 1)
  assertLifecycleRequest(observe.lifecycleRequests().slice(inspectRequestBefore), "inspectSandbox", fixture.accountId, created.providerRef, sandboxIdentity, signal)
  let active = inspected
  let suspended: ProviderSandboxObservation | undefined
  let resumed: ProviderSandboxObservation | undefined
  if (provider.capabilities.suspend) {
    const before = observe.count("suspendSandbox")
    const requestBefore = observe.lifecycleRequests().length
    suspended = await provider.suspendSandbox({ accountId: fixture.accountId, providerRef: active.providerRef, signal })
    assertState(suspended, "suspended", "suspend"); assertOpaqueReference(suspended.providerRef, sandboxIdentity, observe.sandboxIdentity); assertDelta(observe, "suspendSandbox", before, 1)
    assertLifecycleRequest(observe.lifecycleRequests().slice(requestBefore), "suspendSandbox", fixture.accountId, active.providerRef, sandboxIdentity, signal)
  } else await assertUnsupported(() => provider.suspendSandbox({ accountId: fixture.accountId, providerRef: active.providerRef, signal }), observe, "suspendSandbox")
  if (provider.capabilities.resume && suspended) {
    const before = observe.count("resumeSandbox")
    const requestBefore = observe.lifecycleRequests().length
    resumed = await provider.resumeSandbox({ accountId: fixture.accountId, providerRef: suspended.providerRef, signal })
    assertState(resumed, "running", "resume"); assertOpaqueReference(resumed.providerRef, sandboxIdentity, observe.sandboxIdentity); assertDelta(observe, "resumeSandbox", before, 1); active = resumed
    assertLifecycleRequest(observe.lifecycleRequests().slice(requestBefore), "resumeSandbox", fixture.accountId, suspended.providerRef, sandboxIdentity, signal)
  } else if (!provider.capabilities.resume) await assertUnsupported(() => provider.resumeSandbox({ accountId: fixture.accountId, providerRef: (suspended ?? active).providerRef, signal }), observe, "resumeSandbox")
  let snapshotCreated: ProviderSnapshotObservation | undefined
  let snapshotInspected: ProviderSnapshotObservation | undefined
  let snapshotDeleted: ProviderSnapshotObservation | undefined
  if (provider.capabilities.snapshots) {
    const beforeCreate = observe.count("createSnapshot")
    const createRequestBefore = observe.snapshotRequests().length
    snapshotCreated = await provider.createSnapshot({ accountId: fixture.accountId, snapshotId: fixture.snapshotId, sandboxRef: active.providerRef, signal })
    if (snapshotCreated.state !== "creating" && snapshotCreated.state !== "ready") throw new Error("Provider snapshot create state is invalid")
    const snapshotIdentity = observe.snapshotIdentity(snapshotCreated.providerRef); assertOpaqueReference(snapshotCreated.providerRef, snapshotIdentity, observe.snapshotIdentity); assertDelta(observe, "createSnapshot", beforeCreate, 1)
    assertSnapshotRequest(observe.snapshotRequests().slice(createRequestBefore), "createSnapshot", fixture.accountId, fixture.snapshotId, active.providerRef, sandboxIdentity, signal)
    const beforeInspect = observe.count("inspectSnapshot")
    const inspectSnapshotRequestBefore = observe.snapshotRequests().length
    snapshotInspected = await provider.inspectSnapshot({ accountId: fixture.accountId, snapshotId: fixture.snapshotId, providerRef: snapshotCreated.providerRef, signal })
    assertState(snapshotInspected, "ready", "snapshot inspect"); assertOpaqueReference(snapshotInspected.providerRef, snapshotIdentity, observe.snapshotIdentity); assertDelta(observe, "inspectSnapshot", beforeInspect, 1)
    assertSnapshotRequest(observe.snapshotRequests().slice(inspectSnapshotRequestBefore), "inspectSnapshot", fixture.accountId, fixture.snapshotId, snapshotCreated.providerRef, snapshotIdentity, signal)
    const beforeDelete = observe.count("deleteSnapshot")
    const deleteSnapshotRequestBefore = observe.snapshotRequests().length
    snapshotDeleted = await provider.deleteSnapshot({ accountId: fixture.accountId, snapshotId: fixture.snapshotId, providerRef: snapshotInspected.providerRef, signal })
    assertState(snapshotDeleted, "deleted", "snapshot delete"); assertOpaqueReference(snapshotDeleted.providerRef, snapshotIdentity, observe.snapshotIdentity); assertDelta(observe, "deleteSnapshot", beforeDelete, 1)
    assertSnapshotRequest(observe.snapshotRequests().slice(deleteSnapshotRequestBefore), "deleteSnapshot", fixture.accountId, fixture.snapshotId, snapshotInspected.providerRef, snapshotIdentity, signal)
  } else await assertUnsupported(() => provider.createSnapshot({ accountId: fixture.accountId, snapshotId: fixture.snapshotId, sandboxRef: active.providerRef, signal }), observe, "createSnapshot")
  const toolEvents = {} as { [N in ToolName]: ToolEventByName[N][] }
  const toolBefore = observe.count("executeTool")
  for (const tool of TOOL_FIXTURES) {
    const requestBefore = observe.toolRequests().length
    const values: unknown[] = []
    for await (const event of provider.executeTool({ accountId: fixture.accountId, providerRef: active.providerRef, toolName: tool.name, arguments: tool.arguments as never, signal })) values.push(event)
    validateToolEvents(tool.name, values)
    const requests = observe.toolRequests().slice(requestBefore)
    if (requests.length !== 1) throw new Error(`Provider ${tool.name} dispatch count is invalid`)
    const request = requests[0]!
    if (request.toolName !== tool.name || canonicalJson(request.arguments) !== canonicalJson(tool.arguments) || request.sandboxIdentity !== sandboxIdentity || request.signal !== signal) throw new Error(`Provider ${tool.name} request continuity is invalid`)
    if (canonicalJson(values) !== canonicalJson(request.expectedEvents)) throw new Error(`Provider ${tool.name} events are not tied to their invocation`)
    toolEvents[tool.name] = values as never
  }
  assertDelta(observe, "executeTool", toolBefore, TOOL_FIXTURES.length)
  const cancellation = new AbortController()
  const cancellationReason = new DOMException("Provider conformance cancellation", "AbortError")
  cancellation.abort(cancellationReason)
  let caughtCancellation: unknown
  const cancelBefore = observe.count("executeTool")
  try {
    const iterator = provider.executeTool({ accountId: fixture.accountId, providerRef: active.providerRef, toolName: "read", arguments: { filePath: "/workspace/conformance.txt" }, signal: cancellation.signal })[Symbol.asyncIterator]()
    await iterator.next()
  } catch (error) { caughtCancellation = error }
  if (caughtCancellation !== cancellationReason) throw new Error("Provider did not preserve the exact cancellation reason")
  assertDelta(observe, "executeTool", cancelBefore, 0)
  let invalidReferenceRejected = false
  try { await provider.inspectSandbox({ accountId: fixture.accountId, providerRef: null, signal }) }
  catch (error) { invalidReferenceRejected = error instanceof ProviderError && error.kind === "failure" }
  if (!invalidReferenceRejected) throw new Error("Provider accepted an invalid opaque reference")
  observe.arrangeAmbiguousExecution()
  const ambiguousBefore = observe.count("executeTool")
  let ambiguityObserved = false
  try {
    const iterator = provider.executeTool({ accountId: fixture.accountId, providerRef: active.providerRef, toolName: "write", arguments: { filePath: "/workspace/ambiguous.txt", content: "x" }, signal })[Symbol.asyncIterator]()
    await iterator.next()
  } catch (error) { ambiguityObserved = error instanceof ProviderError && error.kind === "ambiguous_execution" }
  if (!ambiguityObserved) throw new Error("Provider did not propagate ambiguous execution")
  assertDelta(observe, "executeTool", ambiguousBefore, 1)
  if (observe.toolRequests().at(-1)?.toolName !== "write") throw new Error("Provider ambiguous execution lost tool-name continuity")
  const deleteBefore = observe.count("deleteSandbox")
  const deleteRequestBefore = observe.lifecycleRequests().length
  const deleted = await provider.deleteSandbox({ accountId: fixture.accountId, providerRef: active.providerRef, signal })
  assertState(deleted, "terminated", "delete"); assertOpaqueReference(deleted.providerRef, sandboxIdentity, observe.sandboxIdentity); assertDelta(observe, "deleteSandbox", deleteBefore, 1)
  assertLifecycleRequest(observe.lifecycleRequests().slice(deleteRequestBefore), "deleteSandbox", fixture.accountId, active.providerRef, sandboxIdentity, signal)
  return { created, replayed, inspected, ...(suspended ? { suspended } : {}), ...(resumed ? { resumed } : {}), ...(snapshotCreated ? { snapshotCreated } : {}), ...(snapshotInspected ? { snapshotInspected } : {}), ...(snapshotDeleted ? { snapshotDeleted } : {}), deleted, toolEvents, cancellationReason: caughtCancellation, invalidReferenceRejected, ambiguityObserved }
}

function assertOpaqueReference(value: JsonValue, expectedIdentity: string, identity: (reference: JsonValue) => string = () => expectedIdentity): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Provider reference must be opaque JSON")
  structuredClone(value)
  if (!expectedIdentity || identity(value) !== expectedIdentity) throw new Error("Provider reference identity changed")
}

const TOOL_FIXTURES = [
  { name: "read", arguments: { filePath: "/workspace/read-sentinel.txt", offset: 7, limit: 13 } },
  { name: "write", arguments: { filePath: "/workspace/write-sentinel.txt", content: "write-sentinel-content" } },
  { name: "edit", arguments: { filePath: "/workspace/edit-sentinel.txt", oldString: "old-sentinel", newString: "new-sentinel", replaceAll: true } },
  { name: "patch", arguments: { patchText: "*** Begin Patch\n*** Add File: /workspace/patch-sentinel.txt\n+sentinel\n*** End Patch" } },
  { name: "glob", arguments: { pattern: "**/*-glob-sentinel.*", path: "/workspace" } },
  { name: "grep", arguments: { pattern: "grep-sentinel", path: "/workspace", include: "*.sentinel" } },
  { name: "bash", arguments: { command: "printf bash-sentinel", description: "bash sentinel", timeout: 1234, workdir: "/workspace" } },
] as const
const TOOL_EVENT_SCHEMAS = { read: ReadToolEventSchema, write: WriteToolEventSchema, edit: EditToolEventSchema, patch: PatchToolEventSchema, glob: GlobToolEventSchema, grep: GrepToolEventSchema, bash: BashToolEventSchema }
function validateToolEvents(toolName: ToolName, values: unknown[]): void {
  if (values.length === 0) throw new Error(`Provider returned no ${toolName} events`)
  for (const value of values) TOOL_EVENT_SCHEMAS[toolName].parse(value)
  const results = values.filter((value) => typeof value === "object" && value !== null && "type" in value && value.type === "result")
  if (results.length !== 1 || values.at(-1) !== results[0] || (toolName !== "bash" && values.length !== 1)) throw new Error(`Provider returned invalid ${toolName} event ordering`)
}
function assertState(observation: { state: string }, expected: string, operation: string): void { if (observation.state !== expected) throw new Error(`Provider ${operation} state is invalid`) }
function assertDelta(instrumentation: ProviderConformanceInstrumentation, operation: ProviderConformanceOperation, before: number, delta: number): void { if (instrumentation.count(operation) !== before + delta) throw new Error(`Provider ${operation} invocation count is invalid`) }
function canonicalJson(value: unknown): string { return JSON.stringify(value, (_key, item) => item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item) }
function assertCapabilities(value: unknown): asserts value is ProviderCapabilities {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Provider capabilities are invalid")
  const expected = ["suspend", "resume", "snapshots", "createFromSnapshot", "fork", "streaming"]
  const keys = Object.keys(value).sort()
  if (keys.join(",") !== [...expected].sort().join(",") || expected.some((key) => typeof (value as Record<string, unknown>)[key] !== "boolean")) throw new Error("Provider capabilities are invalid")
}
function assertLifecycleRequest(requests: readonly ProviderConformanceLifecycleRequest[], operation: ProviderConformanceLifecycleRequest["operation"], accountId: string, providerRef: JsonValue, sandboxIdentity: string, signal: AbortSignal): void {
  const request = requests[0]
  if (requests.length !== 1 || request?.operation !== operation || request.accountId !== accountId || canonicalJson(request.providerRef) !== canonicalJson(providerRef) || request.sandboxIdentity !== sandboxIdentity || request.signal !== signal) throw new Error(`Provider ${operation} request continuity is invalid`)
}
function assertSnapshotRequest(requests: readonly ProviderConformanceSnapshotRequest[], operation: ProviderConformanceSnapshotRequest["operation"], accountId: string, snapshotId: SnapshotId, providerRef: JsonValue, identity: string, signal: AbortSignal): void {
  const request = requests[0]
  const observedIdentity = operation === "createSnapshot" ? request?.sandboxIdentity : request?.snapshotIdentity
  if (requests.length !== 1 || request?.operation !== operation || request.accountId !== accountId || request.snapshotId !== snapshotId || canonicalJson(request.providerRef) !== canonicalJson(providerRef) || observedIdentity !== identity || request.signal !== signal) throw new Error(`Provider ${operation} request continuity is invalid`)
}
async function assertUnsupported(operation: () => Promise<unknown>, instrumentation: ProviderConformanceInstrumentation, name: ProviderConformanceOperation): Promise<void> {
  const before = instrumentation.count(name)
  let rejected = false
  try { await operation() } catch (error) { rejected = error instanceof ProviderError && error.kind === "failure" }
  if (!rejected || instrumentation.count(name) !== before) throw new Error(`Provider unsupported ${name} behavior is invalid`)
}

function sandboxKey(accountId: string, sandboxId: SandboxId): string {
  return `${accountId}\u0000${sandboxId}`
}

function snapshotKey(accountId: string, snapshotId: SnapshotId): string {
  return `${accountId}\u0000${snapshotId}`
}

function idempotencyKey(input: IdempotencyKey): string {
  return `${input.accountId}\u0000${input.scope}\u0000${input.key}`
}

function sandboxRef(sandboxId: SandboxId): JsonValue {
  return { privateSandboxId: sandboxId }
}

function snapshotRef(snapshotId: SnapshotId): JsonValue {
  return { privateSnapshotId: snapshotId }
}

function refId(reference: JsonValue): string {
  if (reference !== null && !Array.isArray(reference) && typeof reference === "object") {
    const id = reference.privateSandboxId ?? reference.privateSnapshotId
    if (typeof id === "string") return id
  }
  throw new Error("Invalid fake provider reference")
}
