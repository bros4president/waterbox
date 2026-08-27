import { describe, expect, test } from "bun:test"
import type { Identity, SandboxId, SnapshotId } from "@waterbox/contracts"
import { DomainError, SandboxService } from "@waterbox/core"
import type { ListRepositoryInput, RepositoryPage, SandboxRepository } from "@waterbox/core/ports"
import {
  ProviderError,
  type ProviderCreateSandboxInput,
  type ProviderSnapshotOperationInput,
} from "@waterbox/core/provider"
import type { SandboxRecord, SnapshotRecord } from "@waterbox/core/records"
import {
  FakeSandboxProvider,
  FixedClock,
  InMemoryIdempotencyRepository,
  InMemorySandboxRepository,
  InMemorySnapshotRepository,
  SequenceIdGenerator,
} from "@waterbox/core/test-support"

const alice: Identity = { accountId: "acct-alice" }
const bob: Identity = { accountId: "acct-bob" }

function harness(options: {
  sandboxIds?: string[]
  snapshotIds?: string[]
  provider?: FakeSandboxProvider
  idempotency?: InMemoryIdempotencyRepository
} = {}) {
  const sandboxes = new InMemorySandboxRepository()
  const snapshots = new InMemorySnapshotRepository()
  const idempotency = options.idempotency ?? new InMemoryIdempotencyRepository()
  const provider = options.provider ?? new FakeSandboxProvider()
  const service = new SandboxService({
    sandboxes,
    snapshots,
    idempotency,
    providers: new Map([[provider.name, provider]]),
    defaultProvider: provider.name,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(
      options.sandboxIds ?? ["sbx_calm-cactus-a1", "sbx_blue-river-b2", "sbx_soft-cloud-c3"],
      options.snapshotIds ?? ["snap_silver-forest-a1", "snap_warm-meadow-b2"],
    ),
  })
  return { service, sandboxes, snapshots, idempotency, provider }
}

async function expectDomainError(promise: Promise<unknown>, code: DomainError["code"]): Promise<DomainError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe(code)
    return error as DomainError
  }
  throw new Error(`Expected ${code}`)
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const event of events) result.push(event)
  return result
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(0)
  }
  throw new Error("Condition was not reached")
}

describe("account ownership", () => {
  test("two accounts can use the same resource ID without collision", async () => {
    const { service, sandboxes, provider } = harness({
      sandboxIds: ["sbx_same-cactus-a1", "sbx_same-cactus-a1"],
    })

    const first = await service.createSandbox(alice, {})
    const second = await service.createSandbox(bob, {})

    expect(first.sandboxId).toBe(second.sandboxId)
    expect((await sandboxes.get(alice.accountId, first.sandboxId))?.accountId).toBe(alice.accountId)
    expect((await sandboxes.get(bob.accountId, second.sandboxId))?.accountId).toBe(bob.accountId)
    expect(provider.providerIdempotencyKeys[0]).not.toBe(provider.providerIdempotencyKeys[1])
  })

  test("one account cannot access another account's resources", async () => {
    const { service } = harness()
    const sandbox = await service.createSandbox(alice, {})
    const snapshot = await service.createSnapshot(alice, sandbox.sandboxId, {})

    await expectDomainError(service.getSandbox(bob, sandbox.sandboxId), "not_found")
    await expectDomainError(service.getSnapshot(bob, snapshot.snapshotId), "not_found")
    await expectDomainError(service.deleteSandbox(bob, sandbox.sandboxId), "not_found")
  })

  test("list operations stay inside the account partition and retain opaque cursors", async () => {
    const { service } = harness({
      sandboxIds: ["sbx_calm-cactus-a1", "sbx_blue-river-b2", "sbx_soft-cloud-c3"],
    })
    await service.createSandbox(alice, {})
    await service.createSandbox(alice, {})
    await service.createSandbox(bob, {})

    const first = await service.listSandboxes(alice, { limit: 1 })
    const second = await service.listSandboxes(alice, { limit: 1, cursor: first.nextCursor })

    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toStartWith("test-cursor:")
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.sandboxId).not.toBe(first.items[0]?.sandboxId)
  })
})

describe("durable create idempotency", () => {
  test("same account, key, and normalized body returns the same sandbox", async () => {
    const { service, provider } = harness()

    const first = await service.createSandbox(alice, {}, { idempotencyKey: "request-1" })
    const second = await service.createSandbox(alice, {}, { idempotencyKey: "request-1" })

    expect(second).toEqual(first)
    expect(provider.createCalls).toBe(1)
    expect(provider.providerIdempotencyKeys).toHaveLength(1)
    expect(provider.providerIdempotencyKeys[0]).toMatch(/^waterbox:create:[a-f0-9]{64}$/)
  })

  test("completed replay does not call or consume the sandbox ID generator", async () => {
    const { service } = harness({ sandboxIds: ["sbx_calm-cactus-a1"] })
    const first = await service.createSandbox(alice, {}, { idempotencyKey: "request-1" })

    const replay = await service.createSandbox(alice, {}, { idempotencyKey: "request-1" })

    expect(replay).toEqual(first)
  })

  test("same key with a different normalized body is rejected", async () => {
    const { service, provider } = harness()
    await service.createSandbox(alice, {}, { idempotencyKey: "request-1" })

    await expectDomainError(
      service.createSandbox(alice, { sourceSnapshotId: "snap_other-forest-z9" }, { idempotencyKey: "request-1" }),
      "idempotency_conflict",
    )
    expect(provider.createCalls).toBe(1)
  })

  test("idempotency keys are account scoped", async () => {
    const { service, provider } = harness()
    const first = await service.createSandbox(alice, {}, { idempotencyKey: "shared" })
    const second = await service.createSandbox(bob, {}, { idempotencyKey: "shared" })

    expect(first.sandboxId).not.toBe(second.sandboxId)
    expect(provider.createCalls).toBe(2)
  })

  test("concurrent same-key creation reserves one ID and provisions one provider resource", async () => {
    const gate = deferred()
    const provider = new FakeSandboxProvider()
    provider.createBarrier = gate.promise
    const { service, idempotency } = harness({ provider })

    const first = service.createSandbox(alice, {}, { idempotencyKey: "concurrent" })
    await waitUntil(() => provider.createCalls === 1)
    const second = service.createSandbox(alice, {}, { idempotencyKey: "concurrent" })
    await expectDomainError(second, "idempotency_in_progress")

    const reserved = await idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "concurrent" })
    expect(reserved?.resourceId).toBe("sbx_calm-cactus-a1")
    expect(reserved?.state).toBe("in_progress")
    expect(provider.createCalls).toBe(1)

    gate.resolve()
    const created = await first
    expect(created.sandboxId).toBe("sbx_calm-cactus-a1")
    expect((await idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "concurrent" }))?.state)
      .toBe("completed")
  })

  test("replay heals a failed idempotency completion without reprovisioning", async () => {
    const idempotency = new FailingCompletionIdempotencyRepository()
    const { service, sandboxes, provider } = harness({ idempotency })

    await expectDomainError(
      service.createSandbox(alice, {}, { idempotencyKey: "completion-failure" }),
      "conflict",
    )
    expect((await sandboxes.get(alice.accountId, "sbx_calm-cactus-a1"))?.state).toBe("running")
    expect((await idempotency.get({
      accountId: alice.accountId,
      scope: "sandbox:create",
      key: "completion-failure",
    }))?.state).toBe("in_progress")

    const replay = await service.createSandbox(alice, {}, { idempotencyKey: "completion-failure" })
    expect(replay.state).toBe("running")
    expect(provider.createCalls).toBe(1)
    expect((await idempotency.get({
      accountId: alice.accountId,
      scope: "sandbox:create",
      key: "completion-failure",
    }))?.state).toBe("completed")
  })
})

describe("lifecycle and capabilities", () => {
  test("invalid create observations fail both sandbox and idempotency records", async () => {
    const provider = new InvalidCreateObservationProvider()
    const { service, sandboxes, idempotency } = harness({ provider })

    const error = await expectDomainError(
      service.createSandbox(alice, {}, { idempotencyKey: "invalid-observation" }),
      "provider_failure",
    )
    const sandbox = await sandboxes.get(alice.accountId, "sbx_calm-cactus-a1")
    const reservation = await idempotency.get({
      accountId: alice.accountId,
      scope: "sandbox:create",
      key: "invalid-observation",
    })

    expect(error.message).toBe("The provider returned an invalid sandbox state")
    expect(sandbox?.state).toBe("failed")
    expect(sandbox?.providerRef).toEqual({ privateSandboxId: "sbx_calm-cactus-a1" })
    expect(sandbox?.lastError).toEqual({
      code: "provider_failure",
      message: "The provider returned an invalid sandbox state",
    })
    expect(reservation?.state).toBe("failed")
    expect(reservation?.lastError).toEqual(sandbox?.lastError)
  })

  test("unsupported snapshots fail before provider invocation or snapshot persistence", async () => {
    const provider = new FakeSandboxProvider({ capabilities: { snapshots: false } })
    const { service, snapshots } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})

    await expectDomainError(service.createSnapshot(alice, sandbox.sandboxId, {}), "unsupported_capability")
    expect(provider.createSnapshotCalls).toBe(0)
    expect((await snapshots.list({ accountId: alice.accountId, limit: 10 })).items).toHaveLength(0)
  })

  test("suspend, resume, and delete enforce canonical transitions", async () => {
    const { service, provider } = harness()
    const sandbox = await service.createSandbox(alice, {})

    expect((await service.suspendSandbox(alice, sandbox.sandboxId)).state).toBe("suspended")
    await expectDomainError(service.suspendSandbox(alice, sandbox.sandboxId), "invalid_state")
    expect((await service.resumeSandbox(alice, sandbox.sandboxId)).state).toBe("running")
    await expectDomainError(service.resumeSandbox(alice, sandbox.sandboxId), "invalid_state")
    expect((await service.deleteSandbox(alice, sandbox.sandboxId)).state).toBe("terminated")
    await expectDomainError(service.deleteSandbox(alice, sandbox.sandboxId), "invalid_state")
    expect(provider.suspendCalls).toBe(1)
    expect(provider.resumeCalls).toBe(1)
    expect(provider.deleteCalls).toBe(1)
  })

  test("snapshot create and delete enforce immutable lifecycle transitions", async () => {
    const { service, provider } = harness()
    const sandbox = await service.createSandbox(alice, {})
    const snapshot = await service.createSnapshot(alice, sandbox.sandboxId, { name: "checkpoint" })

    expect(snapshot.state).toBe("ready")
    expect((await service.deleteSnapshot(alice, snapshot.snapshotId)).state).toBe("deleted")
    await expectDomainError(service.deleteSnapshot(alice, snapshot.snapshotId), "invalid_state")
    expect(provider.createSnapshotCalls).toBe(1)
    expect(provider.deleteSnapshotCalls).toBe(1)
  })

  test("create-from-snapshot enforces ownership, readiness, relationship, and capability", async () => {
    const { service, provider } = harness({
      sandboxIds: [
        "sbx_calm-cactus-a1",
        "sbx_blue-river-b2",
        "sbx_soft-cloud-c3",
        "sbx_warm-meadow-d4",
      ],
    })
    const source = await service.createSandbox(alice, {})
    const snapshot = await service.createSnapshot(alice, source.sandboxId, {})
    const restored = await service.createSandbox(alice, { sourceSnapshotId: snapshot.snapshotId })

    expect(restored.sourceSnapshotId).toBe(snapshot.snapshotId)
    await expectDomainError(service.createSandbox(bob, { sourceSnapshotId: snapshot.snapshotId }), "not_found")
    provider.capabilities.createFromSnapshot = false
    await expectDomainError(
      service.createSandbox(alice, { sourceSnapshotId: snapshot.snapshotId }),
      "unsupported_capability",
    )
  })

  test("create-from-snapshot reconciliation receives the caller's cancellation signal", async () => {
    const provider = new SnapshotSignalProvider()
    const { service, snapshots } = harness({ provider })
    const sourceSandboxId = "sbx_source-cloud-a1" as SandboxId
    const snapshotId = "snap_async-forest-a1" as SnapshotId
    await snapshots.createIfAbsent(snapshotRecord(alice.accountId, snapshotId, sourceSandboxId, "creating"))
    const controller = new AbortController()
    controller.abort(new Error("cancel reconciliation"))

    await expectDomainError(
      service.createSandbox(alice, { sourceSnapshotId: snapshotId }, { signal: controller.signal }),
      "provider_failure",
    )

    expect(provider.inspectSnapshotSignal).toBe(controller.signal)
    expect(provider.createCalls).toBe(0)
  })
})

describe("execution and reconciliation", () => {
  test("concurrent execution resumes a suspended sandbox exactly once", async () => {
    const provider = new FakeSandboxProvider()
    const { service } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    await service.suspendSandbox(alice, sandbox.sandboxId)
    const gate = deferred()
    provider.resumeBarrier = gate.promise

    const first = service.executeTool(alice, sandbox.sandboxId, "read", { filePath: "/workspace/a" })
    await waitUntil(() => provider.resumeCalls === 1)
    const second = service.executeTool(alice, sandbox.sandboxId, "read", { filePath: "/workspace/b" })
    await Bun.sleep(0)
    expect(provider.resumeCalls).toBe(1)

    gate.resolve()
    const [firstEvents, secondEvents] = await Promise.all([
      first.then(collect),
      second.then(collect),
    ])
    expect(firstEvents).toHaveLength(1)
    expect(secondEvents).toHaveLength(1)
    expect(provider.resumeCalls).toBe(1)
    expect(provider.executeCalls).toBe(2)
  })

  test("ambiguous tool failure remains typed and execution is never retried", async () => {
    const provider = new FakeSandboxProvider()
    provider.executeError = new ProviderError("ambiguous_execution", "Execution outcome is unknown")
    const { service } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    const events = await service.executeTool(alice, sandbox.sandboxId, "bash", { command: "touch /workspace/a" })

    await expectDomainError(collect(events), "ambiguous_execution")
    expect(provider.executeCalls).toBe(1)
  })

  test("get reconciles transitional sandbox and snapshot provider states", async () => {
    const { service, sandboxes, snapshots, provider } = harness()
    const sandboxId = "sbx_async-cloud-a1" as SandboxId
    const snapshotId = "snap_async-forest-a1" as SnapshotId
    await sandboxes.createIfAbsent(sandboxRecord(alice.accountId, sandboxId, "provisioning"))
    await snapshots.createIfAbsent(snapshotRecord(alice.accountId, snapshotId, sandboxId, "creating"))
    provider.sandboxStates.set(sandboxId, "running")
    provider.snapshotStates.set(snapshotId, "ready")

    expect((await service.getSandbox(alice, sandboxId)).state).toBe("running")
    expect((await service.getSnapshot(alice, snapshotId)).state).toBe("ready")
    expect(provider.inspectSandboxCalls).toBe(1)
    expect(provider.inspectSnapshotCalls).toBe(1)
  })

  test("readiness reconciliation is bounded for asynchronous provider states", async () => {
    const provider = new AsyncCreateProvider()
    const { service } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    expect(sandbox.state).toBe("provisioning")

    await expectDomainError(
      service.executeTool(alice, sandbox.sandboxId, "read", { filePath: "/workspace/a" }),
      "conflict",
    )
    expect(provider.inspectSandboxCalls).toBe(8)
    expect(provider.executeCalls).toBe(0)
  })
})

describe("records and compare-and-swap", () => {
  test("secret-bearing provider errors are stable in thrown, persisted, and public forms", async () => {
    const secret = "box-token-super-secret"
    const provider = new CreateErrorProvider(new ProviderError("failure", `upstream rejected ${secret}`))
    const { service, sandboxes, idempotency } = harness({ provider })

    const thrown = await expectDomainError(
      service.createSandbox(alice, {}, { idempotencyKey: "secret-failure" }),
      "provider_failure",
    )
    expect(thrown.message).toBe("The provider operation failed")
    expect(thrown.message).not.toContain(secret)
    expect(serializeError(thrown)).not.toContain(secret)
    expect(thrown.cause).toBeUndefined()

    const persisted = await sandboxes.get(alice.accountId, "sbx_calm-cactus-a1")
    const reservation = await idempotency.get({
      accountId: alice.accountId,
      scope: "sandbox:create",
      key: "secret-failure",
    })
    const publicSandbox = await service.getSandbox(alice, "sbx_calm-cactus-a1")
    expect(JSON.stringify(persisted?.lastError)).not.toContain(secret)
    expect(JSON.stringify(reservation?.lastError)).not.toContain(secret)
    expect(JSON.stringify(publicSandbox)).not.toContain(secret)
    expect(publicSandbox.lastError).toEqual({ code: "provider_failure", message: "The provider operation failed" })
  })

  test("provider-thrown domain errors are sanitized without a reachable cause", async () => {
    const secret = "provider-domain-secret"
    const provider = new CreateErrorProvider(new DomainError("conflict", `provider leaked ${secret}`, {
      cause: new Error(`nested ${secret}`),
    }))
    const { service } = harness({ provider })

    const thrown = await expectDomainError(service.createSandbox(alice, {}), "provider_failure")
    expect(thrown.message).toBe("The provider operation failed")
    expect(thrown.cause).toBeUndefined()
    expect(serializeError(thrown)).not.toContain(secret)
    const publicSandbox = await service.getSandbox(alice, "sbx_calm-cactus-a1")
    expect(JSON.stringify(publicSandbox)).not.toContain(secret)
  })

  test("public DTOs never expose account IDs or opaque provider references", async () => {
    const { service } = harness()
    const sandbox = await service.createSandbox(alice, {})
    const snapshot = await service.createSnapshot(alice, sandbox.sandboxId, {})
    const serialized = JSON.stringify({ sandbox, snapshot })

    expect(serialized).not.toContain("accountId")
    expect(serialized).not.toContain("acct-alice")
    expect(serialized).not.toContain("providerRef")
    expect(serialized).not.toContain("privateSandboxId")
    expect(serialized).not.toContain("privateSnapshotId")
  })

  test("stale sandbox and snapshot CAS writes cannot overwrite newer records", async () => {
    const { sandboxes, snapshots } = harness()
    const sandboxId = "sbx_calm-cactus-a1" as SandboxId
    const snapshotId = "snap_silver-forest-a1" as SnapshotId
    const initialSandbox = sandboxRecord(alice.accountId, sandboxId, "running")
    const initialSnapshot = snapshotRecord(alice.accountId, snapshotId, sandboxId, "ready")
    await sandboxes.createIfAbsent(initialSandbox)
    await snapshots.createIfAbsent(initialSnapshot)

    expect(await sandboxes.compareAndSwap({ ...initialSandbox, state: "suspending", version: 2 }, 1)).toBe(true)
    expect(await sandboxes.compareAndSwap({ ...initialSandbox, state: "terminating", version: 2 }, 1)).toBe(false)
    expect((await sandboxes.get(alice.accountId, sandboxId))?.state).toBe("suspending")
    expect(await snapshots.compareAndSwap({ ...initialSnapshot, state: "deleting", version: 2 }, 1)).toBe(true)
    expect(await snapshots.compareAndSwap({ ...initialSnapshot, state: "failed", version: 2 }, 1)).toBe(false)
    expect((await snapshots.get(alice.accountId, snapshotId))?.state).toBe("deleting")
  })

  test("a service transition losing CAS does not invoke the provider or overwrite the winner", async () => {
    const base = new InMemorySandboxRepository()
    const racing = new RacingSandboxRepository(base)
    const provider = new FakeSandboxProvider()
    const service = new SandboxService({
      sandboxes: racing,
      snapshots: new InMemorySnapshotRepository(),
      idempotency: new InMemoryIdempotencyRepository(),
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(),
    })
    const sandboxId = "sbx_calm-cactus-a1" as SandboxId
    await base.createIfAbsent(sandboxRecord(alice.accountId, sandboxId, "running"))

    await expectDomainError(service.suspendSandbox(alice, sandboxId), "invalid_state")
    expect((await base.get(alice.accountId, sandboxId))?.state).toBe("terminated")
    expect(provider.suspendCalls).toBe(0)
  })
})

class AsyncCreateProvider extends FakeSandboxProvider {
  override async createSandbox(input: ProviderCreateSandboxInput) {
    this.createCalls++
    this.providerIdempotencyKeys.push(input.idempotencyKey)
    this.sandboxStates.set(input.sandboxId, "provisioning")
    return { state: "provisioning" as const, providerRef: { privateSandboxId: input.sandboxId } }
  }
}

class InvalidCreateObservationProvider extends FakeSandboxProvider {
  override async createSandbox(input: ProviderCreateSandboxInput) {
    this.createCalls++
    return { state: "suspended" as const, providerRef: { privateSandboxId: input.sandboxId } }
  }
}

class CreateErrorProvider extends FakeSandboxProvider {
  constructor(readonly createError: unknown) {
    super()
  }

  override async createSandbox(_input: ProviderCreateSandboxInput): Promise<never> {
    this.createCalls++
    throw this.createError
  }
}

class SnapshotSignalProvider extends FakeSandboxProvider {
  inspectSnapshotSignal?: AbortSignal

  override async inspectSnapshot(input: ProviderSnapshotOperationInput) {
    this.inspectSnapshotCalls++
    this.inspectSnapshotSignal = input.signal
    input.signal.throwIfAborted()
    return super.inspectSnapshot(input)
  }
}

class FailingCompletionIdempotencyRepository extends InMemoryIdempotencyRepository {
  #failCompletion = true

  override async compareAndSwap(record: import("@waterbox/core/records").IdempotencyRecord, expectedVersion: number) {
    if (this.#failCompletion && record.state === "completed") {
      this.#failCompletion = false
      throw new Error("injected idempotency completion failure")
    }
    return super.compareAndSwap(record, expectedVersion)
  }
}

class RacingSandboxRepository implements SandboxRepository {
  #race = true

  constructor(readonly base: InMemorySandboxRepository) {}

  createIfAbsent(record: SandboxRecord): Promise<boolean> {
    return this.base.createIfAbsent(record)
  }

  get(accountId: string, sandboxId: SandboxId): Promise<SandboxRecord | undefined> {
    return this.base.get(accountId, sandboxId)
  }

  list(input: ListRepositoryInput): Promise<RepositoryPage<SandboxRecord>> {
    return this.base.list(input)
  }

  async compareAndSwap(record: SandboxRecord, expectedVersion: number): Promise<boolean> {
    if (this.#race) {
      this.#race = false
      await this.base.compareAndSwap({ ...record, state: "terminated" }, expectedVersion)
      return false
    }
    return this.base.compareAndSwap(record, expectedVersion)
  }

  conditionalDelete(accountId: string, sandboxId: SandboxId, expectedVersion: number): Promise<boolean> {
    return this.base.conditionalDelete(accountId, sandboxId, expectedVersion)
  }
}

function sandboxRecord(accountId: string, sandboxId: SandboxId, state: SandboxRecord["state"]): SandboxRecord {
  return {
    accountId,
    sandboxId,
    provider: "fake",
    providerRef: { privateSandboxId: sandboxId },
    state,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function snapshotRecord(
  accountId: string,
  snapshotId: SnapshotId,
  sourceSandboxId: SandboxId,
  state: SnapshotRecord["state"],
): SnapshotRecord {
  return {
    accountId,
    snapshotId,
    provider: "fake",
    providerRef: { privateSnapshotId: snapshotId },
    sourceSandboxId,
    state,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function serializeError(error: unknown): string {
  return JSON.stringify(error, (_key, value) => {
    if (value instanceof Error) {
      return Object.fromEntries(Object.getOwnPropertyNames(value).map((name) => [name, value[name as keyof Error]]))
    }
    return value
  })
}
