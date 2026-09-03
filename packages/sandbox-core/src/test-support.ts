import type {
  SandboxId,
  SandboxState,
  SnapshotId,
  SnapshotState,
  SecureTransferDelivered,
  SecureTransferInitiated,
  ToolName,
  ToolEventByName,
} from "@waterbox/contracts"
import type {
  IdempotencyKey,
  IdempotencyRepository,
  ListRepositoryInput,
  RepositoryPage,
  SandboxCreationRepository,
  SandboxCreationReservation,
  SandboxRepository,
  SnapshotRepository,
} from "./ports.ts"
import type {
  ProviderCreateSandboxInput,
  ProviderCreateSnapshotInput,
  ProviderExecuteInput,
  ProviderConsumeSecureTransferInput,
  ProviderOperationInput,
  ProviderSandboxObservation,
  ProviderSnapshotObservation,
  ProviderSnapshotOperationInput,
  SandboxProvider,
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
      .filter((record) => input.provider === undefined || (record.provider === input.provider && record.providerConfigurationId === input.providerConfigurationId))
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
      .filter((record) => input.provider === undefined || (record.provider === input.provider && record.providerConfigurationId === input.providerConfigurationId))
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

  async compareAndSwap(record: IdempotencyRecord, expectedVersion: number): Promise<boolean> {
    const key = idempotencyKey(record)
    const current = this.#records.get(key)
    if (current?.version !== expectedVersion || record.version !== expectedVersion + 1) return false
    this.#records.set(key, clone(record))
    return true
  }

}

type InMemorySandboxCreationBoundary = { tail: Promise<void> }

const inMemorySandboxCreationBoundaries = new WeakMap<
  SandboxRepository,
  WeakMap<IdempotencyRepository, InMemorySandboxCreationBoundary>
>()

function sandboxCreationBoundary(
  sandboxes: SandboxRepository,
  idempotency: IdempotencyRepository,
): InMemorySandboxCreationBoundary {
  let byIdempotency = inMemorySandboxCreationBoundaries.get(sandboxes)
  if (byIdempotency === undefined) {
    byIdempotency = new WeakMap()
    inMemorySandboxCreationBoundaries.set(sandboxes, byIdempotency)
  }
  let boundary = byIdempotency.get(idempotency)
  if (boundary === undefined) {
    boundary = { tail: Promise.resolve() }
    byIdempotency.set(idempotency, boundary)
  }
  return boundary
}

/** A repository-pair-scoped serial transaction analogue for core tests. */
export class InMemorySandboxCreationRepository implements SandboxCreationRepository {
  readonly #boundary: InMemorySandboxCreationBoundary

  constructor(
    private readonly sandboxes: SandboxRepository,
    private readonly idempotency: IdempotencyRepository,
  ) {
    this.#boundary = sandboxCreationBoundary(sandboxes, idempotency)
  }

  async reserve(input: { sandbox: SandboxRecord; idempotency?: IdempotencyRecord }): Promise<SandboxCreationReservation> {
    let release!: () => void
    const previous = this.#boundary.tail
    this.#boundary.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      if (input.idempotency !== undefined) {
        const existing = await this.idempotency.get({
          accountId: input.idempotency.accountId,
          scope: input.idempotency.scope,
          key: input.idempotency.key,
        })
        if (existing !== undefined) return existing.requestHash === input.idempotency.requestHash
          ? { outcome: "existing_match", reservation: existing }
          : { outcome: "request_mismatch", reservation: existing }
      }
      if (!await this.sandboxes.createIfAbsent(input.sandbox)) return { outcome: "candidate_collision" }
      if (input.idempotency !== undefined) {
        // No awaitable work separates these mutations beyond the in-memory map
        // operations; the lock makes the pair one observable reservation.
        if (!await this.idempotency.createIfAbsent(input.idempotency)) throw new Error("In-memory reservation changed unexpectedly")
      }
      return { outcome: "new", ...(input.idempotency === undefined ? {} : { reservation: input.idempotency }) }
    } finally {
      release()
    }
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
  readonly stopResume?: NonNullable<SandboxProvider["stopResume"]>
  readonly snapshots?: NonNullable<SandboxProvider["snapshots"]>
  readonly secureFileTransfer?: NonNullable<SandboxProvider["secureFileTransfer"]>
  createCalls = 0
  prepareCalls = 0
  inspectSandboxCalls = 0
  stopCalls = 0
  resumeCalls = 0
  deleteCalls = 0
  createSnapshotCalls = 0
  inspectSnapshotCalls = 0
  deleteSnapshotCalls = 0
  executeCalls = 0
  createBarrier?: Promise<void>
  createError?: unknown
  prepareBarrier?: Promise<void>
  prepareError?: unknown
  inspectSandboxError?: unknown
  stopBarrier?: Promise<void>
  stopError?: unknown
  resumeBarrier?: Promise<void>
  resumeError?: unknown
  deleteError?: unknown
  createSnapshotError?: unknown
  inspectSnapshotError?: unknown
  createSnapshotObservation?: ProviderSnapshotObservation
  createStarted?: () => void
  prepareStarted?: () => void
  stopStarted?: () => void
  resumeStarted?: () => void
  executeError?: unknown
  readonly providerIdempotencyKeys: string[] = []
  readonly createInputs: ProviderCreateSandboxInput[] = []
  readonly prepareInputs: ProviderOperationInput[] = []
  readonly lifecycleInputs: Array<{ operation: "inspect" | "stop" | "resume" | "delete"; input: ProviderOperationInput }> = []
  readonly snapshotInputs: Array<{ operation: "create" | "inspect" | "delete"; input: ProviderCreateSnapshotInput | ProviderSnapshotOperationInput }> = []
  readonly toolInputs: ProviderExecuteInput[] = []
  readonly secureTransferInputs: Array<ProviderOperationInput | ProviderConsumeSecureTransferInput> = []
  readonly sandboxStates = new Map<string, SandboxState>()
  readonly snapshotStates = new Map<string, SnapshotState>()

  constructor(options: { name?: string; stopResume?: boolean; snapshots?: boolean; secureFileTransfer?: boolean } = {}) {
    this.name = options.name ?? "fake"
    if (options.stopResume !== false) {
      this.stopResume = {
        stop: (input) => this.stop(input),
        resume: (input) => this.resume(input),
      }
    }
    if (options.snapshots !== false) {
      this.snapshots = {
        create: (input) => this.createSnapshot(input),
        inspect: (input) => this.inspectSnapshot(input),
        delete: (input) => this.deleteSnapshot(input),
      }
    }
    if (options.secureFileTransfer !== false) {
      this.secureFileTransfer = {
        initiate: (input) => this.initiateSecureTransfer(input),
        consume: (input) => this.consumeSecureTransfer(input),
      }
    }
  }

  async createSandbox(input: ProviderCreateSandboxInput): Promise<ProviderSandboxObservation> {
    this.createCalls++
    this.createStarted?.()
    this.createInputs.push(input)
    this.providerIdempotencyKeys.push(input.idempotencyKey)
    await this.createBarrier
    if (this.createError !== undefined) throw this.createError
    this.sandboxStates.set(input.sandboxId, "running")
    return { state: "running", providerRef: sandboxRef(input.sandboxId) }
  }

  async prepareSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    this.prepareCalls++
    this.prepareStarted?.()
    this.prepareInputs.push(input)
    await this.prepareBarrier
    input.signal.throwIfAborted()
    if (this.prepareError !== undefined) throw this.prepareError
    return { state: "running", providerRef: input.providerRef }
  }

  async inspectSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    this.inspectSandboxCalls++
    this.lifecycleInputs.push({ operation: "inspect", input })
    if (this.inspectSandboxError !== undefined) throw this.inspectSandboxError
    const id = refId(input.providerRef)
    return { state: this.sandboxStates.get(id) ?? "provisioning", providerRef: input.providerRef }
  }

  protected async stop(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    this.stopCalls++
    this.stopStarted?.()
    this.lifecycleInputs.push({ operation: "stop", input })
    await this.stopBarrier
    if (this.stopError !== undefined) throw this.stopError
    const id = refId(input.providerRef)
    this.sandboxStates.set(id, "stopped")
    return { state: "stopped", providerRef: input.providerRef }
  }

  protected async resume(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    this.resumeCalls++
    this.resumeStarted?.()
    this.lifecycleInputs.push({ operation: "resume", input })
    await this.resumeBarrier
    if (this.resumeError !== undefined) throw this.resumeError
    const id = refId(input.providerRef)
    this.sandboxStates.set(id, "running")
    return { state: "running", providerRef: input.providerRef }
  }

  async deleteSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    this.deleteCalls++
    this.lifecycleInputs.push({ operation: "delete", input })
    if (this.deleteError !== undefined) throw this.deleteError
    const id = refId(input.providerRef)
    this.sandboxStates.set(id, "terminated")
    return { state: "terminated", providerRef: input.providerRef }
  }

  protected async createSnapshot(input: ProviderCreateSnapshotInput): Promise<ProviderSnapshotObservation> {
    this.createSnapshotCalls++
    this.snapshotInputs.push({ operation: "create", input })
    if (this.createSnapshotError !== undefined) throw this.createSnapshotError
    this.snapshotStates.set(input.snapshotId, "ready")
    return this.createSnapshotObservation ?? { state: "ready", providerRef: snapshotRef(input.snapshotId) }
  }

  protected async inspectSnapshot(input: ProviderSnapshotOperationInput): Promise<ProviderSnapshotObservation> {
    this.inspectSnapshotCalls++
    this.snapshotInputs.push({ operation: "inspect", input })
    if (this.inspectSnapshotError !== undefined) throw this.inspectSnapshotError
    const id = refId(input.providerRef)
    return { state: this.snapshotStates.get(id) ?? "creating", providerRef: input.providerRef }
  }

  protected async deleteSnapshot(input: ProviderSnapshotOperationInput): Promise<ProviderSnapshotObservation> {
    this.deleteSnapshotCalls++
    this.snapshotInputs.push({ operation: "delete", input })
    const id = refId(input.providerRef)
    this.snapshotStates.set(id, "deleted")
    return { state: "deleted", providerRef: input.providerRef }
  }

  executeTool<N extends ToolName>(input: ProviderExecuteInput<N>): AsyncIterable<ToolEventByName[N]> {
    this.executeCalls++
    this.toolInputs.push(input)
    const error = this.executeError
    return (async function* () {
      input.signal.throwIfAborted()
      if (error !== undefined) throw error
      yield { type: "result", title: input.toolName, output: "ok", metadata: {} } as ToolEventByName[N]
    })()
  }

  protected async initiateSecureTransfer(input: ProviderOperationInput): Promise<SecureTransferInitiated> {
    this.secureTransferInputs.push(input)
    return {
      transferId: "123e4567-e89b-42d3-a456-426614174000",
      publicKey: `age1${"q".repeat(58)}`,
      algorithm: "age-x25519",
      expiresAt: "2026-01-01T00:10:00.000Z",
    }
  }

  protected async consumeSecureTransfer(input: ProviderConsumeSecureTransferInput): Promise<SecureTransferDelivered> {
    this.secureTransferInputs.push(input)
    return { transferId: input.transferId, targetPath: input.targetPath, bytes: 1 }
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
