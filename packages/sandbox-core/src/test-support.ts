import type {
  ProviderCapabilities,
  SandboxId,
  SandboxState,
  SnapshotId,
  SnapshotState,
  ToolName,
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
