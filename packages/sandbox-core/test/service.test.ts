import { describe, expect, test } from "bun:test"
import type { Identity, SandboxId, SnapshotId } from "@waterbox/contracts"
import { DomainError, SandboxRecoveryError, SandboxService, type SandboxServiceConfig, type SandboxServiceDependencies } from "@waterbox/core"
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
  InMemorySandboxCreationRepository,
  InMemoryIdempotencyRepository,
  InMemorySandboxRepository,
  InMemorySnapshotRepository,
  SequenceIdGenerator,
} from "@waterbox/core/test-support"

const alice: Identity = { accountId: "acct-alice" }
const bob: Identity = { accountId: "acct-bob" }
const binding = "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

function inMemorySandboxService(
  dependencies: Omit<SandboxServiceDependencies, "sandboxCreations"> | SandboxServiceDependencies,
  config: SandboxServiceConfig = {},
): SandboxService {
  const sandboxCreations = "sandboxCreations" in dependencies
    ? dependencies.sandboxCreations
    : new InMemorySandboxCreationRepository(dependencies.sandboxes, dependencies.idempotency)
  return new SandboxService({ ...dependencies, sandboxCreations }, config)
}

function harness(options: {
  sandboxIds?: string[]
  snapshotIds?: string[]
  provider?: FakeSandboxProvider
  idempotency?: InMemoryIdempotencyRepository
  providerConfigurationId?: string
  serviceConfig?: { allocationAttempts?: number }
} = {}) {
  const sandboxes = new InMemorySandboxRepository()
  const snapshots = new InMemorySnapshotRepository()
  const idempotency = options.idempotency ?? new InMemoryIdempotencyRepository()
  const sandboxCreations = new InMemorySandboxCreationRepository(sandboxes, idempotency)
  const provider = options.provider ?? new FakeSandboxProvider()
  const service = inMemorySandboxService({
    sandboxes,
    snapshots,
    idempotency,
    sandboxCreations,
    providers: new Map([[provider.name, provider]]),
    defaultProvider: provider.name,
    providerConfigurationId: options.providerConfigurationId ?? binding,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(
      options.sandboxIds ?? ["sbx_calm-cactus-a1", "sbx_blue-river-b2", "sbx_soft-cloud-c3"],
      options.snapshotIds ?? ["snap_silver-forest-a1", "snap_warm-meadow-b2"],
    ),
  }, options.serviceConfig)
  return { service, sandboxes, snapshots, idempotency, sandboxCreations, provider }
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
    const { service, provider } = harness()
    const sandbox = await service.createSandbox(alice, {})
    const snapshot = await service.createSnapshot(alice, sandbox.sandboxId, {})

    await expectDomainError(service.getSandbox(bob, sandbox.sandboxId), "not_found")
    await expectDomainError(service.probeSandbox(bob, sandbox.sandboxId), "not_found")
    await expectDomainError(service.getSnapshot(bob, snapshot.snapshotId), "not_found")
    await expectDomainError(service.deleteSandbox(bob, sandbox.sandboxId), "not_found")
    expect(provider.inspectSandboxCalls).toBe(1)
  })

  test("live probe always inspects the provider and persists out-of-band state", async () => {
    const { service, provider, sandboxes } = harness()
    const sandbox = await service.createSandbox(alice, {})
    provider.sandboxStates.set(sandbox.sandboxId, "stopped")

    expect((await service.probeSandbox(alice, sandbox.sandboxId)).state).toBe("stopped")
    expect((await sandboxes.get(alice.accountId, sandbox.sandboxId))?.state).toBe("stopped")
    provider.sandboxStates.set(sandbox.sandboxId, "terminated")
    expect((await service.probeSandbox(alice, sandbox.sandboxId)).state).toBe("terminated")
    expect(provider.inspectSandboxCalls).toBe(2)
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

describe("provider configuration binding", () => {
  test("persists the active binding and lets the same binding operate registered resources", async () => {
    const { service, sandboxes, snapshots } = harness()
    const sandbox = await service.createSandbox(alice, {})
    const snapshot = await service.createSnapshot(alice, sandbox.sandboxId, {})

    expect((await sandboxes.get(alice.accountId, sandbox.sandboxId))?.providerConfigurationId).toBe(binding)
    expect((await snapshots.get(alice.accountId, snapshot.snapshotId))?.providerConfigurationId).toBe(binding)
    expect((await service.getSandbox(alice, sandbox.sandboxId)).sandboxId).toBe(sandbox.sandboxId)
    expect((await service.getSnapshot(alice, snapshot.snapshotId)).snapshotId).toBe(snapshot.snapshotId)
  })

  test("different provider and stale binding reject direct access before provider I/O", async () => {
    const { service, sandboxes, provider } = harness()
    const sandbox = await service.createSandbox(alice, {})
    const persisted = await sandboxes.get(alice.accountId, sandbox.sandboxId)
    await sandboxes.compareAndSwap({ ...persisted!, providerConfigurationId: "pcfg_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", version: persisted!.version + 1 }, persisted!.version)

    await expectDomainError(service.probeSandbox(alice, sandbox.sandboxId), "provider_configuration_mismatch")
    expect(provider.inspectSandboxCalls).toBe(0)

    const otherProvider = new FakeSandboxProvider({ name: "other" })
    const alternate = inMemorySandboxService({
      sandboxes,
      snapshots: new InMemorySnapshotRepository(),
      idempotency: new InMemoryIdempotencyRepository(),
      providers: new Map([[otherProvider.name, otherProvider]]),
      defaultProvider: otherProvider.name,
      providerConfigurationId: binding,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(),
    })
    await expectDomainError(alternate.getSandbox(alice, sandbox.sandboxId), "provider_configuration_mismatch")
    expect(otherProvider.inspectSandboxCalls).toBe(0)
  })

  test("switching back to the exact binding restores access", async () => {
    const { service, sandboxes, snapshots, idempotency, provider } = harness()
    const sandbox = await service.createSandbox(alice, {})
    const switched = inMemorySandboxService({
      sandboxes,
      snapshots,
      idempotency,
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      providerConfigurationId: "pcfg_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(),
    })
    await expectDomainError(switched.getSandbox(alice, sandbox.sandboxId), "provider_configuration_mismatch")
    expect((await service.getSandbox(alice, sandbox.sandboxId)).sandboxId).toBe(sandbox.sandboxId)
  })

  test("failed idempotency replay rejects an inactive registered sandbox before surfacing its prior failure", async () => {
    const provider = new FakeSandboxProvider()
    provider.prepareError = new ProviderError("failure", "private initial failure")
    const { service, sandboxes } = harness({ provider })
    await expectDomainError(service.createSandbox(alice, {}, { idempotencyKey: "failed-inactive" }), "provider_failure")
    const sandbox = await sandboxes.get(alice.accountId, "sbx_calm-cactus-a1" as SandboxId)
    await sandboxes.compareAndSwap({ ...sandbox!, providerConfigurationId: "pcfg_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", version: sandbox!.version + 1 }, sandbox!.version)
    const prepares = provider.prepareCalls

    await expectDomainError(service.createSandbox(alice, {}, { idempotencyKey: "failed-inactive" }), "provider_configuration_mismatch")
    expect(provider.prepareCalls).toBe(prepares)
  })
})

describe("secure file transfer", () => {
  test("preserves account, provider reference, signal, and ciphertext without persistence", async () => {
    const { service, provider, sandboxes } = harness()
    const sandbox = await service.createSandbox(alice, {})
    const controller = new AbortController()
    const initiated = await service.initiateSecureFileTransfer(alice, sandbox.sandboxId, controller.signal)
    const request = { targetPath: "/root/.aws/credentials", ciphertext: Buffer.from("ciphertext-only").toString("base64") }
    const delivered = await service.consumeSecureFileTransfer(alice, sandbox.sandboxId, initiated.transferId, request, controller.signal)

    expect(delivered).toMatchObject({ transferId: initiated.transferId, targetPath: request.targetPath })
    expect(provider.secureTransferInputs).toHaveLength(2)
    expect(provider.secureTransferInputs[1]).toMatchObject({ accountId: alice.accountId, transferId: initiated.transferId, ...request, signal: controller.signal })
    expect(JSON.stringify(await sandboxes.get(alice.accountId, sandbox.sandboxId))).not.toContain("ciphertext-only")
  })

  test("enforces ownership and capability before dispatch and resumes stopped sandboxes", async () => {
    const { service, provider } = harness()
    const sandbox = await service.createSandbox(alice, {})
    await service.stopSandbox(alice, sandbox.sandboxId)
    await service.initiateSecureFileTransfer(alice, sandbox.sandboxId)
    expect(provider.resumeCalls).toBe(1)

    await expectDomainError(service.initiateSecureFileTransfer(bob, sandbox.sandboxId), "not_found")
    const unsupported = harness({ provider: new FakeSandboxProvider({ secureFileTransfer: false }) })
    const unsupportedSandbox = await unsupported.service.createSandbox(alice, {})
    await expectDomainError(unsupported.service.initiateSecureFileTransfer(alice, unsupportedSandbox.sandboxId), "unsupported_capability")
  })

  test("maps transfer expiry and consumption to typed domain outcomes", async () => {
    for (const [kind, code] of [["expired", "transfer_expired"], ["consumed", "transfer_consumed"]] as const) {
      const provider = new FakeSandboxProvider()
      provider.secureFileTransfer!.consume = async () => { throw new ProviderError(kind, "private provider details") }
      const { service } = harness({ provider })
      const sandbox = await service.createSandbox(alice, {})
      await expectDomainError(service.consumeSecureFileTransfer(alice, sandbox.sandboxId, "123e4567-e89b-42d3-a456-426614174000", { targetPath: "x", ciphertext: "YQ==" }), code)
    }
  })

  test("preserves ambiguous consumption when cancellation races with dispatch", async () => {
    const provider = new FakeSandboxProvider()
    const controller = new AbortController()
    provider.secureFileTransfer!.consume = async () => {
      controller.abort(new DOMException("caller left", "AbortError"))
      throw new ProviderError("ambiguous_execution", "response lost")
    }
    const { service } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    await expectDomainError(service.consumeSecureFileTransfer(alice, sandbox.sandboxId, "123e4567-e89b-42d3-a456-426614174000", { targetPath: "x", ciphertext: "YQ==" }, controller.signal), "ambiguous_execution")
  })
})

describe("durable create idempotency", () => {
  test("regenerates a colliding sandbox ID before exactly one provider dispatch", async () => {
    const { service, sandboxes, provider, idempotency } = harness({ sandboxIds: ["sbx_taken-cactus-a1", "sbx_fresh-river-b2"] })
    await sandboxes.createIfAbsent({
      accountId: alice.accountId,
      sandboxId: "sbx_taken-cactus-a1",
      provider: provider.name,
      providerConfigurationId: binding,
      providerRef: null,
      state: "provisioning",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })

    const created = await service.createSandbox(alice, {}, { idempotencyKey: "collision-key" })
    expect(created.sandboxId).toBe("sbx_fresh-river-b2")
    expect(provider.createCalls).toBe(1)
    expect((await idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "collision-key" }))?.resourceId).toBe(created.sandboxId)
  })

  test("allocation exhaustion performs no provider mutation", async () => {
    const { service, sandboxes, provider } = harness({
      sandboxIds: ["sbx_taken-cactus-a1", "sbx_taken-river-b2"],
      serviceConfig: { allocationAttempts: 2 },
    })
    for (const sandboxId of ["sbx_taken-cactus-a1", "sbx_taken-river-b2"] as SandboxId[]) {
      await sandboxes.createIfAbsent({ accountId: alice.accountId, sandboxId, provider: provider.name, providerConfigurationId: binding, providerRef: null, state: "provisioning", version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" })
    }
    await expectDomainError(service.createSandbox(alice, {}), "internal_error")
    expect(provider.createCalls).toBe(0)
  })

  test("regenerates a colliding snapshot ID before snapshot dispatch", async () => {
    const { service, snapshots, provider } = harness({
      sandboxIds: ["sbx_source-cactus-a1"],
      snapshotIds: ["snap_taken-forest-a1", "snap_fresh-meadow-b2"],
    })
    const source = await service.createSandbox(alice, {})
    await snapshots.createIfAbsent({
      accountId: alice.accountId,
      snapshotId: "snap_taken-forest-a1",
      provider: provider.name,
      providerConfigurationId: binding,
      providerRef: null,
      sourceSandboxId: source.sandboxId,
      state: "creating",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    const created = await service.createSnapshot(alice, source.sandboxId, {})
    expect(created.snapshotId).toBe("snap_fresh-meadow-b2")
    expect(provider.createSnapshotCalls).toBe(1)
    expect((await snapshots.get(alice.accountId, created.snapshotId))?.snapshotId).toBe(created.snapshotId)
  })
  test("persists the provider reference as preparing before preparation starts", async () => {
    const gate = deferred()
    const started = deferred()
    const provider = new FakeSandboxProvider()
    provider.prepareBarrier = gate.promise
    provider.prepareStarted = started.resolve
    const { service, sandboxes } = harness({ provider })

    const creation = service.createSandbox(alice, {}, { idempotencyKey: "checkpoint" })
    await started.promise

    expect(await sandboxes.get(alice.accountId, "sbx_calm-cactus-a1")).toMatchObject({
      state: "preparing",
      providerRef: { privateSandboxId: "sbx_calm-cactus-a1" },
    })
    gate.resolve()
    expect((await creation).state).toBe("running")
  })

  test("does not claim provider-reference durability when checkpoint persistence fails", async () => {
    const base = new InMemorySandboxRepository()
    const sandboxes = new FailingSandboxCasRepository(base)
    const provider = new FakeSandboxProvider()
    const service = inMemorySandboxService({
      sandboxes,
      snapshots: new InMemorySnapshotRepository(),
      idempotency: new InMemoryIdempotencyRepository(),
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      providerConfigurationId: binding,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(["sbx_calm-cactus-a1"]),
    })

    await expectDomainError(service.createSandbox(alice, {}, { idempotencyKey: "checkpoint-failure" }), "provider_failure")

    expect(provider.createCalls).toBe(1)
    expect(provider.prepareCalls).toBe(0)
    expect(await base.get(alice.accountId, "sbx_calm-cactus-a1")).toMatchObject({ state: "provisioning", providerRef: null })
  })

  test("pre-aborted create does not allocate, persist, or dispatch", async () => {
    const { service, sandboxes, idempotency, provider } = harness({ sandboxIds: [] })
    const controller = new AbortController()
    const reason = new DOMException("cancel create", "AbortError")
    controller.abort(reason)

    await expect(service.createSandbox(alice, {}, { idempotencyKey: "cancelled", signal: controller.signal })).rejects.toBe(reason)

    expect(provider.createCalls).toBe(0)
    expect((await sandboxes.list({ accountId: alice.accountId, limit: 10 })).items).toEqual([])
    expect(await idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "cancelled" })).toBeUndefined()
  })

  test("cancellation before provider create returns leaves the old provisioning record", async () => {
    const gate = deferred()
    const started = deferred()
    const provider = new AbortBeforeCreateResultProvider()
    provider.createBarrier = gate.promise
    provider.createStarted = started.resolve
    const { service, sandboxes, idempotency } = harness({ provider })
    const controller = new AbortController()
    const creation = service.createSandbox(alice, {}, { idempotencyKey: "cancel-before-create", signal: controller.signal })
    await started.promise
    const reason = new DOMException("cancel before create result", "AbortError")
    controller.abort(reason)
    gate.resolve()

    await expect(creation).rejects.toBe(reason)
    expect(await sandboxes.get(alice.accountId, "sbx_calm-cactus-a1")).toMatchObject({ state: "provisioning", providerRef: null })
    expect((await idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "cancel-before-create" }))?.state).toBe("in_progress")
    await expectDomainError(service.createSandbox(alice, {}, { idempotencyKey: "cancel-before-create" }), "idempotency_in_progress")
    expect(provider.createCalls).toBe(1)
  })

  test("cancellation that receives a provider reference persists the preparation checkpoint", async () => {
    const gate = deferred()
    const started = deferred()
    const provider = new FakeSandboxProvider()
    provider.createBarrier = gate.promise
    provider.createStarted = started.resolve
    const { service, sandboxes, idempotency } = harness({ provider })
    const controller = new AbortController()
    const creation = service.createSandbox(alice, {}, { idempotencyKey: "cancelled", signal: controller.signal })
    await started.promise
    const reason = new DOMException("cancel in flight", "AbortError")
    controller.abort(reason)
    gate.resolve()

    await expect(creation).rejects.toBe(reason)
    expect(await sandboxes.get(alice.accountId, "sbx_calm-cactus-a1")).toMatchObject({
      state: "preparing",
      providerRef: { privateSandboxId: "sbx_calm-cactus-a1" },
    })
    expect((await sandboxes.get(alice.accountId, "sbx_calm-cactus-a1"))?.lastError).toBeUndefined()
    expect(await idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "cancelled" })).toMatchObject({
      state: "in_progress",
    })
    expect((await service.getSandbox(alice, "sbx_calm-cactus-a1")).state).toBe("preparing")
    expect((await service.createSandbox(alice, {}, { idempotencyKey: "cancelled" })).state).toBe("running")
    expect(provider.createCalls).toBe(1)
    expect(provider.prepareCalls).toBe(1)
  })

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

  test("two service instances sharing repositories reserve one ID and dispatch one provider create", async () => {
    const gate = deferred()
    const started = deferred()
    const provider = new FakeSandboxProvider()
    provider.createBarrier = gate.promise
    provider.createStarted = started.resolve
    const { service, sandboxes, snapshots, idempotency, sandboxCreations } = harness({ provider })
    const secondService = inMemorySandboxService({
      sandboxes,
      snapshots,
      idempotency,
      sandboxCreations,
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      providerConfigurationId: binding,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(["sbx_blue-river-b2"]),
    })

    const first = service.createSandbox(alice, {}, { idempotencyKey: "concurrent" })
    const second = expectDomainError(
      secondService.createSandbox(alice, {}, { idempotencyKey: "concurrent" }),
      "idempotency_in_progress",
    )
    await started.promise
    await second

    const reserved = await idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "concurrent" })
    expect(reserved?.resourceId).toBe("sbx_calm-cactus-a1")
    expect(reserved?.state).toBe("in_progress")
    expect((await sandboxes.list({ accountId: alice.accountId, limit: 10 })).items.map((item) => item.sandboxId))
      .toEqual(["sbx_calm-cactus-a1"])
    expect(provider.createCalls).toBe(1)

    gate.resolve()
    const created = await first
    expect(created.sandboxId).toBe("sbx_calm-cactus-a1")
    expect((await idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "concurrent" }))?.state)
      .toBe("completed")
  })

  test("concurrent preparation from reconstructed services converges through durable CAS", async () => {
    const gate = deferred()
    const firstStarted = deferred()
    const secondStarted = deferred()
    const provider = new FakeSandboxProvider()
    provider.prepareBarrier = gate.promise
    provider.prepareStarted = () => (provider.prepareCalls === 1 ? firstStarted : secondStarted).resolve()
    const first = harness({ provider })
    const secondService = inMemorySandboxService({
      sandboxes: first.sandboxes,
      snapshots: first.snapshots,
      idempotency: first.idempotency,
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      providerConfigurationId: binding,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(),
    })

    const initiating = first.service.createSandbox(alice, {}, { idempotencyKey: "concurrent-preparation" })
    await firstStarted.promise
    const reconstructed = secondService.createSandbox(alice, {}, { idempotencyKey: "concurrent-preparation" })
    await secondStarted.promise
    gate.resolve()

    const results = await Promise.all([initiating, reconstructed])
    expect(results.map((result) => result.state)).toEqual(["running", "running"])
    expect(provider.createCalls).toBe(1)
    expect((await first.idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "concurrent-preparation" }))?.state).toBe("completed")
  })

  test("definite preparation failure retains a deletable failed resource and redacted recovery handle", async () => {
    const provider = new FakeSandboxProvider()
    provider.prepareError = new ProviderError("failure", "provider secret bx_private")
    const { service, sandboxes, idempotency } = harness({ provider })

    const error = await expectDomainError(
      service.createSandbox(alice, {}, { idempotencyKey: "prepare-failure" }),
      "provider_failure",
    )

    expect(error).toBeInstanceOf(SandboxRecoveryError)
    expect((error as SandboxRecoveryError).sandboxId).toBe("sbx_calm-cactus-a1")
    expect(error.message).not.toContain("provider secret")
    expect(await sandboxes.get(alice.accountId, "sbx_calm-cactus-a1")).toMatchObject({
      state: "failed",
      providerRef: { privateSandboxId: "sbx_calm-cactus-a1" },
      lastError: { code: "provider_failure", message: "The provider operation failed" },
    })
    expect((await idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "prepare-failure" }))?.state).toBe("failed")
    const replay = await expectDomainError(
      service.createSandbox(alice, {}, { idempotencyKey: "prepare-failure" }),
      "provider_failure",
    )
    expect(replay).toBeInstanceOf(SandboxRecoveryError)
    expect((replay as SandboxRecoveryError).sandboxId).toBe("sbx_calm-cactus-a1")
    expect(provider.prepareCalls).toBe(1)
    expect((await service.probeSandbox(alice, "sbx_calm-cactus-a1")).state).toBe("failed")
    expect((await service.deleteSandbox(alice, "sbx_calm-cactus-a1")).state).toBe("terminated")
  })

  test("successful preparation persistence failure remains preparing and resumable", async () => {
    const base = new InMemorySandboxRepository()
    const sandboxes = new FailingRunningCommitRepository(base)
    const idempotency = new InMemoryIdempotencyRepository()
    const provider = new FakeSandboxProvider()
    const service = inMemorySandboxService({
      sandboxes,
      snapshots: new InMemorySnapshotRepository(),
      idempotency,
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      providerConfigurationId: binding,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(["sbx_calm-cactus-a1"]),
    })

    const error = await expectDomainError(
      service.createSandbox(alice, {}, { idempotencyKey: "running-commit" }),
      "conflict",
    )
    expect(error).toBeInstanceOf(SandboxRecoveryError)
    expect(await base.get(alice.accountId, "sbx_calm-cactus-a1")).toMatchObject({ state: "preparing", lastError: undefined })
    expect((await idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "running-commit" }))?.state).toBe("in_progress")

    expect((await service.createSandbox(alice, {}, { idempotencyKey: "running-commit" })).state).toBe("running")
    expect(provider.createCalls).toBe(1)
    expect(provider.prepareCalls).toBe(2)
  })

  test("failure persistence exhaustion reports recovery without leaving failed missing its error", async () => {
    const base = new InMemorySandboxRepository()
    const sandboxes = new RejectFailedSandboxRepository(base)
    const provider = new FakeSandboxProvider()
    provider.prepareError = new ProviderError("failure", "private failure")
    const service = inMemorySandboxService({
      sandboxes,
      snapshots: new InMemorySnapshotRepository(),
      idempotency: new InMemoryIdempotencyRepository(),
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      providerConfigurationId: binding,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(["sbx_calm-cactus-a1"]),
    })

    const error = await expectDomainError(
      service.createSandbox(alice, {}, { idempotencyKey: "failure-persistence" }),
      "conflict",
    )
    expect(error).toBeInstanceOf(SandboxRecoveryError)
    expect(await base.get(alice.accountId, "sbx_calm-cactus-a1")).toMatchObject({ state: "preparing", lastError: undefined })

    sandboxes.rejectFailures = false
    provider.prepareError = undefined
    expect((await service.createSandbox(alice, {}, { idempotencyKey: "failure-persistence" })).state).toBe("running")
  })

  test("ambiguous and cancelled preparation remain preparing and resumable", async () => {
    const ambiguousProvider = new FakeSandboxProvider()
    ambiguousProvider.prepareError = new ProviderError("ambiguous_execution", "lost response bx_private")
    const ambiguous = harness({ provider: ambiguousProvider })

    const error = await expectDomainError(
      ambiguous.service.createSandbox(alice, {}, { idempotencyKey: "ambiguous" }),
      "ambiguous_execution",
    )
    expect(error).toBeInstanceOf(SandboxRecoveryError)
    expect((await ambiguous.sandboxes.get(alice.accountId, "sbx_calm-cactus-a1"))?.state).toBe("preparing")
    expect((await ambiguous.idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "ambiguous" }))?.state).toBe("in_progress")
    ambiguousProvider.prepareError = undefined
    expect((await ambiguous.service.createSandbox(alice, {}, { idempotencyKey: "ambiguous" })).state).toBe("running")
    expect(ambiguousProvider.createCalls).toBe(1)

    const gate = deferred()
    const started = deferred()
    const cancelledProvider = new FakeSandboxProvider()
    cancelledProvider.prepareBarrier = gate.promise
    cancelledProvider.prepareStarted = started.resolve
    const cancelled = harness({ provider: cancelledProvider })
    const controller = new AbortController()
    const creation = cancelled.service.createSandbox(alice, {}, { idempotencyKey: "cancel-prepare", signal: controller.signal })
    await started.promise
    const reason = new DOMException("cancel preparation", "AbortError")
    controller.abort(reason)
    gate.resolve()
    await expect(creation).rejects.toBe(reason)
    expect((await cancelled.sandboxes.get(alice.accountId, "sbx_calm-cactus-a1"))?.state).toBe("preparing")
    expect((await cancelled.idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "cancel-prepare" }))?.state).toBe("in_progress")
    expect((await cancelled.service.createSandbox(alice, {}, { idempotencyKey: "cancel-prepare" })).state).toBe("running")
    expect(cancelledProvider.createCalls).toBe(1)
  })

  test("preparation cannot replace the durable provider reference", async () => {
    const provider = new FakeSandboxProvider()
    provider.prepareSandbox = async () => ({
      state: "running",
      providerRef: { privateSandboxId: "sbx_other-cloud-z9" },
    })
    const { service, sandboxes } = harness({ provider })

    await expectDomainError(service.createSandbox(alice, {}, { idempotencyKey: "changed-reference" }), "provider_failure")
    expect(await sandboxes.get(alice.accountId, "sbx_calm-cactus-a1")).toMatchObject({
      state: "failed",
      providerRef: { privateSandboxId: "sbx_calm-cactus-a1" },
    })
  })

})

describe("lifecycle and optional groups", () => {
  test("rejects configured providers without mandatory preparation", () => {
    const provider = new FakeSandboxProvider()
    const unsupported = { ...provider, name: provider.name, prepareSandbox: undefined } as unknown as FakeSandboxProvider

    expect(() => inMemorySandboxService({
      sandboxes: new InMemorySandboxRepository(),
      snapshots: new InMemorySnapshotRepository(),
      idempotency: new InMemoryIdempotencyRepository(),
      providers: new Map([[unsupported.name, unsupported]]),
      defaultProvider: unsupported.name,
      providerConfigurationId: binding,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(),
    })).toThrow("does not implement sandbox preparation")
  })

  test("preparing gates mutations and operations while deletion remains available", async () => {
    const { service, sandboxes, provider } = harness()
    const sandboxId = "sbx_preparing-cloud-a1" as SandboxId
    await sandboxes.createIfAbsent(sandboxRecord(alice.accountId, sandboxId, "preparing"))

    await expectDomainError(service.stopSandbox(alice, sandboxId), "invalid_state")
    await expectDomainError(service.resumeSandbox(alice, sandboxId), "invalid_state")
    await expectDomainError(service.createSnapshot(alice, sandboxId, {}), "invalid_state")
    await expectDomainError(service.executeTool(alice, sandboxId, "read", { filePath: "/workspace/a" }), "invalid_state")
    await expectDomainError(service.initiateSecureFileTransfer(alice, sandboxId), "invalid_state")
    await expectDomainError(service.observeBashJob(alice, sandboxId, `job_${"a".repeat(32)}`, 0, 64), "invalid_state")
    await expectDomainError(service.cleanupBashJob(alice, sandboxId, `job_${"a".repeat(32)}`), "invalid_state")

    expect(provider.stopCalls).toBe(0)
    expect(provider.executeCalls).toBe(0)
    expect((await service.deleteSandbox(alice, sandboxId)).state).toBe("terminated")
    expect(provider.deleteCalls).toBe(1)
  })

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
    const provider = new FakeSandboxProvider({ snapshots: false })
    const { service, snapshots } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})

    await expectDomainError(service.createSnapshot(alice, sandbox.sandboxId, {}), "unsupported_capability")
    expect(provider.createSnapshotCalls).toBe(0)
    expect((await snapshots.list({ accountId: alice.accountId, limit: 10 })).items).toHaveLength(0)
  })

  test("unsupported optional groups fail before IDs, persistence, transitions, or provider dispatch", async () => {
    const provider = new FakeSandboxProvider({ stopResume: false, snapshots: false })
    const { service, sandboxes, snapshots } = harness({ provider, snapshotIds: [] })
    const sandbox = await service.createSandbox(alice, {})
    const stoppedId = "sbx_stopped-cloud-a1" as SandboxId
    const runningId = "sbx_running-cloud-a1" as SandboxId
    const deletedSnapshotId = "snap_deleted-forest-a1" as SnapshotId
    await sandboxes.createIfAbsent(sandboxRecord(alice.accountId, stoppedId, "stopped"))
    await sandboxes.createIfAbsent(sandboxRecord(alice.accountId, runningId, "running"))
    await snapshots.createIfAbsent(snapshotRecord(alice.accountId, deletedSnapshotId, runningId, "deleted"))

    await expectDomainError(service.stopSandbox(alice, sandbox.sandboxId), "unsupported_capability")
    await expectDomainError(service.stopSandbox(alice, stoppedId), "unsupported_capability")
    await expectDomainError(service.resumeSandbox(alice, runningId), "unsupported_capability")
    await expectDomainError(service.createSnapshot(alice, sandbox.sandboxId, {}), "unsupported_capability")
    await expectDomainError(service.deleteSnapshot(alice, deletedSnapshotId), "unsupported_capability")

    expect((await sandboxes.get(alice.accountId, sandbox.sandboxId))?.state).toBe("running")
    expect((await snapshots.get(alice.accountId, deletedSnapshotId))?.state).toBe("deleted")
    expect((await snapshots.list({ accountId: alice.accountId, limit: 10 })).items).toHaveLength(1)
    expect(provider.inspectSandboxCalls).toBe(0)
    expect(provider.stopCalls).toBe(0)
    expect(provider.createSnapshotCalls).toBe(0)
  })

  test("stop, resume, and delete enforce canonical transitions", async () => {
    const { service, provider } = harness()
    const sandbox = await service.createSandbox(alice, {})

    expect((await service.stopSandbox(alice, sandbox.sandboxId)).state).toBe("stopped")
    expect((await service.stopSandbox(alice, sandbox.sandboxId)).state).toBe("stopped")
    expect((await service.resumeSandbox(alice, sandbox.sandboxId)).state).toBe("running")
    expect((await service.resumeSandbox(alice, sandbox.sandboxId)).state).toBe("running")
    expect((await service.deleteSandbox(alice, sandbox.sandboxId)).state).toBe("terminated")
    expect((await service.deleteSandbox(alice, sandbox.sandboxId)).state).toBe("terminated")
    expect(provider.stopCalls).toBe(2)
    expect(provider.resumeCalls).toBe(2)
    expect(provider.deleteCalls).toBe(1)
  })

  test("explicit stop and resume correct provider drift and keep canonical target results idempotent", async () => {
    const { service, provider, sandboxes } = harness()
    const sandbox = await service.createSandbox(alice, {})

    await service.stopSandbox(alice, sandbox.sandboxId)
    provider.sandboxStates.set(sandbox.sandboxId, "running")
    expect((await sandboxes.get(alice.accountId, sandbox.sandboxId))?.state).toBe("stopped")
    expect((await service.stopSandbox(alice, sandbox.sandboxId)).state).toBe("stopped")
    expect(provider.stopCalls).toBe(2)
    expect(provider.sandboxStates.get(sandbox.sandboxId)).toBe("stopped")

    provider.stopError = new ProviderError("known_state", "already stopped", {
      knownObservation: {
        resource: "sandbox",
        observation: { state: "stopped", providerRef: { privateSandboxId: sandbox.sandboxId } },
      },
    })
    expect((await service.stopSandbox(alice, sandbox.sandboxId)).state).toBe("stopped")
    expect(provider.stopCalls).toBe(3)
    provider.stopError = undefined

    await service.resumeSandbox(alice, sandbox.sandboxId)
    provider.sandboxStates.set(sandbox.sandboxId, "stopped")
    expect((await sandboxes.get(alice.accountId, sandbox.sandboxId))?.state).toBe("running")
    expect((await service.resumeSandbox(alice, sandbox.sandboxId)).state).toBe("running")
    expect(provider.resumeCalls).toBe(2)
    expect(provider.sandboxStates.get(sandbox.sandboxId)).toBe("running")

    provider.resumeError = new ProviderError("known_state", "already running", {
      knownObservation: {
        resource: "sandbox",
        observation: { state: "running", providerRef: { privateSandboxId: sandbox.sandboxId } },
      },
    })
    expect((await service.resumeSandbox(alice, sandbox.sandboxId)).state).toBe("running")
    expect(provider.resumeCalls).toBe(3)
    expect(provider.inspectSandboxCalls).toBe(0)
  })

  test("mutation cancellation is preflighted and in-flight stop remains reconcilable", async () => {
    const provider = new FakeSandboxProvider()
    const { service, sandboxes } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    const preflight = new AbortController()
    const preflightReason = new DOMException("cancel stop", "AbortError")
    preflight.abort(preflightReason)

    await expect(service.stopSandbox(alice, sandbox.sandboxId, preflight.signal)).rejects.toBe(preflightReason)
    expect((await sandboxes.get(alice.accountId, sandbox.sandboxId))?.state).toBe("running")
    expect(provider.stopCalls).toBe(0)

    const gate = deferred()
    const started = deferred()
    provider.stopBarrier = gate.promise
    provider.stopStarted = started.resolve
    const inFlight = new AbortController()
    const stopping = service.stopSandbox(alice, sandbox.sandboxId, inFlight.signal)
    await started.promise
    const inFlightReason = new DOMException("cancel stop in flight", "AbortError")
    inFlight.abort(inFlightReason)
    gate.resolve()

    await expect(stopping).rejects.toBe(inFlightReason)
    expect(await sandboxes.get(alice.accountId, sandbox.sandboxId)).toMatchObject({ state: "stopping" })
    expect((await sandboxes.get(alice.accountId, sandbox.sandboxId))?.lastError).toBeUndefined()
    expect((await service.getSandbox(alice, sandbox.sandboxId)).state).toBe("stopped")
  })

  test("snapshot create and delete enforce immutable lifecycle transitions", async () => {
    const { service, provider } = harness()
    const sandbox = await service.createSandbox(alice, {})
    const snapshot = await service.createSnapshot(alice, sandbox.sandboxId, { name: "checkpoint" })

    expect(snapshot.state).toBe("ready")
    expect((await service.deleteSnapshot(alice, snapshot.snapshotId)).state).toBe("deleted")
    expect((await service.deleteSnapshot(alice, snapshot.snapshotId)).state).toBe("deleted")
    expect(provider.createSnapshotCalls).toBe(1)
    expect(provider.deleteSnapshotCalls).toBe(1)
  })

  test("persists the source observation before finalizing a ready snapshot", async () => {
    const { service, provider, sandboxes, snapshots } = harness()
    const sandbox = await service.createSandbox(alice, {})
    provider.createSnapshotObservation = { state: "ready", providerRef: { fakeSnapshot: "native-snapshot" }, sourceSandbox: { state: "stopped", providerRef: { fakeSandbox: sandbox.sandboxId } } }
    const created = await service.createSnapshot(alice, sandbox.sandboxId, {})
    expect(created.state).toBe("ready")
    expect((await snapshots.get(alice.accountId, created.snapshotId))?.state).toBe("ready")
    expect((await sandboxes.get(alice.accountId, sandbox.sandboxId))?.state).toBe("stopped")
    expect((await service.getSandbox(alice, sandbox.sandboxId)).state).toBe("stopped")
  })

  test("keeps a concurrent source lifecycle winner while recovering snapshot source observation CAS", async () => {
    const base = new InMemorySandboxRepository()
    const racing = new RacingSandboxRepository(base, false)
    const snapshots = new InMemorySnapshotRepository()
    const provider = new FakeSandboxProvider()
    const service = inMemorySandboxService({
      sandboxes: racing,
      snapshots,
      idempotency: new InMemoryIdempotencyRepository(),
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      providerConfigurationId: binding,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(["sbx_calm-cactus-a1"], ["snap_silver-forest-a1"]),
    })
    const sandboxId = "sbx_calm-cactus-a1" as SandboxId
    await base.createIfAbsent(sandboxRecord(alice.accountId, sandboxId, "running"))
    provider.sandboxStates.set(sandboxId, "running")
    provider.createSnapshotObservation = {
      state: "ready",
      providerRef: { fakeSnapshot: "native-snapshot" },
      sourceSandbox: { state: "stopped", providerRef: { fakeSandbox: sandboxId } },
    }
    const nativeCreate = provider.snapshots!.create
    provider.snapshots!.create = async (input) => {
      racing.arm()
      return nativeCreate(input)
    }

    const created = await service.createSnapshot(alice, sandboxId, {})

    // The snapshot result is durable before the source CAS. A racing terminal
    // lifecycle winner remains authoritative rather than being overwritten.
    expect(created.state).toBe("ready")
    expect((await snapshots.get(alice.accountId, created.snapshotId))?.state).toBe("ready")
    expect((await base.get(alice.accountId, sandboxId))?.state).toBe("terminated")
    expect((await service.getSandbox(alice, sandboxId)).state).toBe("terminated")
  })

  test("leaves an exhausted source checkpoint creating and recovers it through later exact reconciliation", async () => {
    const base = new InMemorySandboxRepository()
    const sandboxes = new ExhaustingSourceCasRepository(base, 100)
    const snapshots = new InMemorySnapshotRepository(), provider = new FakeSandboxProvider()
    const sandboxId = "sbx_calm-cactus-a1" as SandboxId
    await base.createIfAbsent(sandboxRecord(alice.accountId, sandboxId, "running"))
    provider.sandboxStates.set(sandboxId, "running")
    provider.createSnapshotObservation = { state: "ready", providerRef: { privateSnapshotId: "snap_silver-forest-a1" }, sourceSandbox: { state: "stopped", providerRef: { fakeSandbox: sandboxId } } }
    const dependencies = { sandboxes, snapshots, idempotency: new InMemoryIdempotencyRepository(), providers: new Map([[provider.name, provider]]), defaultProvider: provider.name, providerConfigurationId: binding, clock: new FixedClock(), ids: new SequenceIdGenerator([], ["snap_silver-forest-a1"]) }
    const service = inMemorySandboxService(dependencies, { metadataConflictRetries: 1 })

    const created = await service.createSnapshot(alice, sandboxId, {})

    expect(created.state).toBe("creating")
    expect((await snapshots.get(alice.accountId, created.snapshotId))?.state).toBe("creating")
    expect((await base.get(alice.accountId, sandboxId))?.state).toBe("running")
    sandboxes.allow()
    provider.sandboxStates.set(sandboxId, "stopped")
    const recovered = inMemorySandboxService(dependencies)
    expect((await recovered.getSnapshot(alice, created.snapshotId)).state).toBe("ready")
    expect((await base.get(alice.accountId, sandboxId))?.state).toBe("stopped")
  })

  test("retains the checkpoint across a source repository error and reconciles a terminal failed snapshot", async () => {
    const base = new InMemorySandboxRepository()
    const sandboxes = new ExhaustingSourceCasRepository(base, 1, true)
    const snapshots = new InMemorySnapshotRepository(), provider = new FakeSandboxProvider()
    const sandboxId = "sbx_calm-cactus-a1" as SandboxId, snapshotId = "snap_silver-forest-a1" as SnapshotId
    await base.createIfAbsent(sandboxRecord(alice.accountId, sandboxId, "running"))
    provider.sandboxStates.set(sandboxId, "running")
    provider.createSnapshotObservation = { state: "failed", providerRef: { privateSnapshotId: snapshotId }, sourceSandbox: { state: "stopped", providerRef: { fakeSandbox: sandboxId } } }
    const dependencies = { sandboxes, snapshots, idempotency: new InMemoryIdempotencyRepository(), providers: new Map([[provider.name, provider]]), defaultProvider: provider.name, providerConfigurationId: binding, clock: new FixedClock(), ids: new SequenceIdGenerator([], [snapshotId]) }

    expect((await inMemorySandboxService(dependencies).createSnapshot(alice, sandboxId, {})).state).toBe("creating")
    expect((await snapshots.get(alice.accountId, snapshotId))?.providerRef).toEqual({ privateSnapshotId: snapshotId })
    sandboxes.allow()
    provider.snapshotStates.set(snapshotId, "failed")
    provider.sandboxStates.set(sandboxId, "stopped")
    expect((await inMemorySandboxService(dependencies).getSnapshot(alice, snapshotId)).state).toBe("failed")
    expect((await base.get(alice.accountId, sandboxId))?.state).toBe("stopped")
  })

  test("snapshot creation requires a running sandbox and never resumes implicitly", async () => {
    const { service, provider } = harness()
    const sandbox = await service.createSandbox(alice, {})
    await service.stopSandbox(alice, sandbox.sandboxId)

    await expectDomainError(service.createSnapshot(alice, sandbox.sandboxId, {}), "invalid_state")
    expect(provider.createSnapshotCalls).toBe(0)
    expect(provider.resumeCalls).toBe(0)
  })

  test("adapter-reported mutation ambiguity wins a racing caller abort", async () => {
    const createProvider = new FakeSandboxProvider()
    const createController = new AbortController()
    createProvider.createStarted = () => createController.abort(new DOMException("cancel create", "AbortError"))
    createProvider.createError = new ProviderError("ambiguous_execution", "create outcome unknown")
    const create = harness({ provider: createProvider })
    await expectDomainError(create.service.createSandbox(alice, {}, { signal: createController.signal }), "ambiguous_execution")

    const provider = new FakeSandboxProvider()
    const { service } = harness({ provider, sandboxIds: ["sbx_calm-cactus-a1", "sbx_blue-river-b2", "sbx_soft-cloud-c3"] })
    const stopTarget = await service.createSandbox(alice, {})
    const stopController = new AbortController()
    provider.stopStarted = () => stopController.abort(new DOMException("cancel stop", "AbortError"))
    provider.stopError = new ProviderError("ambiguous_execution", "stop outcome unknown")
    await expectDomainError(service.stopSandbox(alice, stopTarget.sandboxId, stopController.signal), "ambiguous_execution")

    provider.stopError = undefined
    provider.stopStarted = undefined
    const resumeTarget = await service.createSandbox(alice, {})
    await service.stopSandbox(alice, resumeTarget.sandboxId)
    const resumeController = new AbortController()
    provider.resumeStarted = () => resumeController.abort(new DOMException("cancel resume", "AbortError"))
    provider.resumeError = new ProviderError("ambiguous_execution", "resume outcome unknown")
    await expectDomainError(service.resumeSandbox(alice, resumeTarget.sandboxId, resumeController.signal), "ambiguous_execution")

    provider.resumeError = undefined
    provider.resumeStarted = undefined
    const deleteTarget = await service.createSandbox(alice, {})
    const deleteController = new AbortController()
    provider.deleteError = new ProviderError("ambiguous_execution", "delete outcome unknown")
    const originalDelete = provider.deleteSandbox.bind(provider)
    provider.deleteSandbox = async (input) => {
      deleteController.abort(new DOMException("cancel delete", "AbortError"))
      return originalDelete(input)
    }
    await expectDomainError(service.deleteSandbox(alice, deleteTarget.sandboxId, deleteController.signal), "ambiguous_execution")

    const snapshotProvider = new FakeSandboxProvider()
    const snapshot = harness({ provider: snapshotProvider })
    const snapshotTarget = await snapshot.service.createSandbox(alice, {})
    const snapshotController = new AbortController()
    snapshotProvider.createSnapshotError = new ProviderError("ambiguous_execution", "snapshot outcome unknown")
    const originalCreateSnapshot = snapshotProvider.snapshots!.create
    snapshotProvider.snapshots!.create = async (input) => {
      snapshotController.abort(new DOMException("cancel snapshot", "AbortError"))
      return originalCreateSnapshot(input)
    }
    await expectDomainError(snapshot.service.createSnapshot(alice, snapshotTarget.sandboxId, {}, snapshotController.signal), "ambiguous_execution")
  })

  test("a canceled resume joiner retains the active adapter ambiguity", async () => {
    const provider = new FakeSandboxProvider()
    const { service } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    await service.stopSandbox(alice, sandbox.sandboxId)
    const gate = deferred()
    const started = deferred()
    provider.resumeBarrier = gate.promise
    provider.resumeStarted = started.resolve
    provider.resumeError = new ProviderError("ambiguous_execution", "resume outcome unknown")
    const active = service.resumeSandbox(alice, sandbox.sandboxId)
    await started.promise
    const joiningController = new AbortController()
    const joining = service.resumeSandbox(alice, sandbox.sandboxId, joiningController.signal)
    joiningController.abort(new DOMException("cancel joining resume", "AbortError"))
    gate.resolve()

    await expectDomainError(active, "ambiguous_execution")
    await expectDomainError(joining, "ambiguous_execution")
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
    expect((await service.createSandbox(alice, { sourceSnapshotId: snapshot.snapshotId })).sourceSnapshotId).toBe(snapshot.snapshotId)
  })

  test("create-from-snapshot preflights cancellation before lookup or provider dispatch", async () => {
    const provider = new SnapshotSignalProvider()
    const { service, snapshots } = harness({ provider })
    const sourceSandboxId = "sbx_source-cloud-a1" as SandboxId
    const snapshotId = "snap_async-forest-a1" as SnapshotId
    await snapshots.createIfAbsent(snapshotRecord(alice.accountId, snapshotId, sourceSandboxId, "creating"))
    const controller = new AbortController()
    const reason = new Error("cancel reconciliation")
    controller.abort(reason)

    await expect(service.createSandbox(alice, { sourceSnapshotId: snapshotId }, { signal: controller.signal })).rejects.toBe(reason)

    expect(provider.inspectSnapshotSignal).toBeUndefined()
    expect(provider.createCalls).toBe(0)
  })

  test("create from an inactive provider snapshot is rejected before provider create dispatch", async () => {
    const sourceProvider = new FakeSandboxProvider({ name: "source" })
    const defaultProvider = new FakeSandboxProvider({ name: "default" })
    const snapshots = new InMemorySnapshotRepository()
    const snapshotId = "snap_owned-forest-a1" as SnapshotId
    await snapshots.createIfAbsent({
      ...snapshotRecord(alice.accountId, snapshotId, "sbx_source-cloud-a1", "ready"),
      provider: sourceProvider.name,
    })
    const service = inMemorySandboxService({
      sandboxes: new InMemorySandboxRepository(),
      snapshots,
      idempotency: new InMemoryIdempotencyRepository(),
      providers: new Map([[defaultProvider.name, defaultProvider], [sourceProvider.name, sourceProvider]]),
      defaultProvider: defaultProvider.name,
      providerConfigurationId: binding,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(["sbx_restored-cloud-a1"]),
    })

    await expectDomainError(service.createSandbox(alice, { sourceSnapshotId: snapshotId }), "provider_configuration_mismatch")
    expect(defaultProvider.createCalls).toBe(0)
    expect(sourceProvider.createCalls).toBe(0)
  })

  test("create from snapshot rejects an owning provider without snapshots before allocation or persistence", async () => {
    const sourceProvider = new FakeSandboxProvider({ name: "source", snapshots: false })
    const defaultProvider = new FakeSandboxProvider({ name: "default" })
    const sandboxes = new InMemorySandboxRepository()
    const snapshots = new InMemorySnapshotRepository()
    const idempotency = new InMemoryIdempotencyRepository()
    const snapshotId = "snap_owned-forest-a1" as SnapshotId
    await snapshots.createIfAbsent({
      ...snapshotRecord(alice.accountId, snapshotId, "sbx_source-cloud-a1", "ready"),
      provider: sourceProvider.name,
    })
    const service = inMemorySandboxService({
      sandboxes,
      snapshots,
      idempotency,
      providers: new Map([[defaultProvider.name, defaultProvider], [sourceProvider.name, sourceProvider]]),
      defaultProvider: defaultProvider.name,
      providerConfigurationId: binding,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(),
    })

    await expectDomainError(
      service.createSandbox(alice, { sourceSnapshotId: snapshotId }, { idempotencyKey: "restore" }),
      "provider_configuration_mismatch",
    )

    expect(sourceProvider.createCalls).toBe(0)
    expect(defaultProvider.createCalls).toBe(0)
    expect((await sandboxes.list({ accountId: alice.accountId, limit: 10 })).items).toEqual([])
    expect(await idempotency.get({ accountId: alice.accountId, scope: "sandbox:create", key: "restore" })).toBeUndefined()
  })
})

describe("execution and reconciliation", () => {
  test("a first tool failure learns an automatic stop without replaying the tool", async () => {
    const provider = new FakeSandboxProvider()
    const { service, sandboxes } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    provider.sandboxStates.set(sandbox.sandboxId, "stopped")
    provider.executeError = new ProviderError("failure", "provider rejected the command")

    await expectDomainError(collect(await service.executeTool(alice, sandbox.sandboxId, "read", { filePath: "note.txt" })), "provider_failure")
    expect(provider.executeCalls).toBe(1)
    expect(provider.resumeCalls).toBe(0)
    expect(provider.inspectSandboxCalls).toBe(1)
    expect((await sandboxes.get(alice.accountId, sandbox.sandboxId))?.state).toBe("stopped")

    provider.executeError = undefined
    expect(await collect(await service.executeTool(alice, sandbox.sandboxId, "read", { filePath: "note.txt" }))).toHaveLength(1)
    expect(provider.resumeCalls).toBe(1)
    expect(provider.executeCalls).toBe(2)
  })

  test("stream-time command ambiguity learns state but never turns a write into success", async () => {
    const provider = new FakeSandboxProvider()
    const { service, sandboxes } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    provider.sandboxStates.set(sandbox.sandboxId, "terminated")
    provider.executeError = new ProviderError("ambiguous_execution", "write response lost")

    await expectDomainError(collect(await service.executeTool(alice, sandbox.sandboxId, "write", { filePath: "note.txt", content: "text" })), "ambiguous_execution")
    expect(provider.executeCalls).toBe(1)
    expect(provider.inspectSandboxCalls).toBe(1)
    expect((await sandboxes.get(alice.accountId, sandbox.sandboxId))?.state).toBe("terminated")
  })

  test("secure transfer and Bash job failures learn exact sandbox state without retrying their operation", async () => {
    class OperationalProvider extends FakeSandboxProvider {
      override readonly secureFileTransfer = {
        initiate: async () => { throw new ProviderError("failure", "transfer unavailable") },
        consume: async () => { throw new ProviderError("ambiguous_execution", "transfer response lost") },
      }
      readonly bashJobs = {
        observe: async () => { throw new ProviderError("failure", "job unavailable") },
        cleanup: async () => { throw new ProviderError("ambiguous_execution", "cleanup response lost") },
      }
    }
    const provider = new OperationalProvider()
    const { service, sandboxes } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    const jobId = `job_${"a".repeat(32)}`
    provider.sandboxStates.set(sandbox.sandboxId, "stopped")

    await expectDomainError(service.initiateSecureFileTransfer(alice, sandbox.sandboxId), "provider_failure")
    expect((await sandboxes.get(alice.accountId, sandbox.sandboxId))?.state).toBe("stopped")
    // Bash observations do not resume, and their failed read still learns the
    // already-stopped state once rather than replaying the job operation.
    await expectDomainError(service.observeBashJob(alice, sandbox.sandboxId, jobId, 0, 64), "provider_failure")
    expect(provider.inspectSandboxCalls).toBe(2)
  })

  test("lifecycle investigation converges idempotent outcomes and retains ambiguous old states", async () => {
    const provider = new FakeSandboxProvider()
    const { service, sandboxes, snapshots } = harness({
      provider,
      sandboxIds: ["sbx_calm-cactus-a1", "sbx_blue-river-b2", "sbx_soft-cloud-c3", "sbx_warm-meadow-d4"],
    })
    const stopTarget = await service.createSandbox(alice, {})
    provider.sandboxStates.set(stopTarget.sandboxId, "stopped")
    provider.stopError = new ProviderError("known_state", "already stopped", {
      knownObservation: {
        resource: "sandbox",
        observation: { state: "stopped", providerRef: { privateSandboxId: stopTarget.sandboxId } },
      },
    })
    expect((await service.stopSandbox(alice, stopTarget.sandboxId)).state).toBe("stopped")
    expect(provider.stopCalls).toBe(1)
    expect(provider.inspectSandboxCalls).toBe(0)
    provider.stopError = undefined

    const resumeTarget = await service.createSandbox(alice, {})
    await service.stopSandbox(alice, resumeTarget.sandboxId)
    provider.sandboxStates.set(resumeTarget.sandboxId, "running")
    provider.resumeError = new ProviderError("failure", "already running")
    expect((await service.resumeSandbox(alice, resumeTarget.sandboxId)).state).toBe("running")
    expect(provider.resumeCalls).toBe(1)
    provider.resumeError = undefined

    const deleteTarget = await service.createSandbox(alice, {})
    provider.deleteError = new ProviderError("ambiguous_execution", "delete response lost")
    // The exact read sees the old state: preserve terminating because delayed
    // provider deletion remains possible.
    await expectDomainError(service.deleteSandbox(alice, deleteTarget.sandboxId), "ambiguous_execution")
    expect((await sandboxes.get(alice.accountId, deleteTarget.sandboxId))?.state).toBe("terminating")
    expect(provider.deleteCalls).toBe(1)
    provider.deleteError = undefined

    const snapshotSource = await service.createSandbox(alice, {})
    const snapshot = await service.createSnapshot(alice, snapshotSource.sandboxId, {})
    provider.snapshotStates.set(snapshot.snapshotId, "deleted")
    const originalDelete = provider.snapshots!.delete
    provider.snapshots!.delete = async () => { throw new ProviderError("failure", "already deleted") }
    expect((await service.deleteSnapshot(alice, snapshot.snapshotId)).state).toBe("deleted")
    expect(provider.deleteSnapshotCalls).toBe(0)
    expect((await snapshots.get(alice.accountId, snapshot.snapshotId))?.state).toBe("deleted")
    provider.snapshots!.delete = originalDelete
  })

  test("authoritative terminal absence converges stop, resume, and delete without redispatch", async () => {
    const provider = new FakeSandboxProvider()
    const { service, sandboxes } = harness({
      provider,
      sandboxIds: ["sbx_calm-cactus-a1", "sbx_blue-river-b2", "sbx_soft-cloud-c3"],
    })

    const stopTarget = await service.createSandbox(alice, {})
    provider.sandboxStates.set(stopTarget.sandboxId, "terminated")
    provider.stopError = new ProviderError("failure", "resource no longer exists")
    expect((await service.stopSandbox(alice, stopTarget.sandboxId)).state).toBe("terminated")
    expect(provider.stopCalls).toBe(1)
    expect((await service.getSandbox(alice, stopTarget.sandboxId)).state).toBe("terminated")
    expect((await service.probeSandbox(alice, stopTarget.sandboxId)).state).toBe("terminated")
    expect(provider.stopCalls).toBe(1)
    provider.stopError = undefined

    const resumeTarget = await service.createSandbox(alice, {})
    await service.stopSandbox(alice, resumeTarget.sandboxId)
    provider.sandboxStates.set(resumeTarget.sandboxId, "terminated")
    provider.resumeError = new ProviderError("failure", "resource no longer exists")
    await expectDomainError(service.resumeSandbox(alice, resumeTarget.sandboxId), "provider_failure")
    expect(provider.resumeCalls).toBe(1)
    expect((await sandboxes.get(alice.accountId, resumeTarget.sandboxId))?.state).toBe("terminated")
    expect((await service.getSandbox(alice, resumeTarget.sandboxId)).state).toBe("terminated")
    expect((await service.probeSandbox(alice, resumeTarget.sandboxId)).state).toBe("terminated")
    expect(provider.resumeCalls).toBe(1)
    provider.resumeError = undefined

    const deleteTarget = await service.createSandbox(alice, {})
    provider.sandboxStates.set(deleteTarget.sandboxId, "terminated")
    provider.deleteError = new ProviderError("failure", "resource no longer exists")
    expect((await service.deleteSandbox(alice, deleteTarget.sandboxId)).state).toBe("terminated")
    expect(provider.deleteCalls).toBe(1)
    expect((await service.deleteSandbox(alice, deleteTarget.sandboxId)).state).toBe("terminated")
    expect(provider.deleteCalls).toBe(1)
  })

  test("provider limits restore every lifecycle transition after exact old-state confirmation", async () => {
    const provider = new FakeSandboxProvider()
    const { service, sandboxes, snapshots } = harness({
      provider,
      sandboxIds: ["sbx_calm-cactus-a1", "sbx_blue-river-b2", "sbx_soft-cloud-c3", "sbx_warm-meadow-d4"],
    })

    const stopTarget = await service.createSandbox(alice, {})
    provider.stopError = new ProviderError("limit", "stop rate limited")
    await expectDomainError(service.stopSandbox(alice, stopTarget.sandboxId), "provider_limit")
    expect((await sandboxes.get(alice.accountId, stopTarget.sandboxId))?.state).toBe("running")
    expect(provider.stopCalls).toBe(1)
    expect(provider.inspectSandboxCalls).toBe(1)
    provider.stopError = undefined

    const resumeTarget = await service.createSandbox(alice, {})
    await service.stopSandbox(alice, resumeTarget.sandboxId)
    provider.resumeError = new ProviderError("limit", "resume rate limited")
    await expectDomainError(service.resumeSandbox(alice, resumeTarget.sandboxId), "provider_limit")
    expect((await sandboxes.get(alice.accountId, resumeTarget.sandboxId))?.state).toBe("stopped")
    expect(provider.resumeCalls).toBe(1)
    expect(provider.inspectSandboxCalls).toBe(2)
    provider.resumeError = undefined

    const deleteTarget = await service.createSandbox(alice, {})
    provider.deleteError = new ProviderError("limit", "delete rate limited")
    await expectDomainError(service.deleteSandbox(alice, deleteTarget.sandboxId), "provider_limit")
    expect((await sandboxes.get(alice.accountId, deleteTarget.sandboxId))?.state).toBe("running")
    expect(provider.deleteCalls).toBe(1)
    expect(provider.inspectSandboxCalls).toBe(3)
    provider.deleteError = undefined

    const source = await service.createSandbox(alice, {})
    const snapshot = await service.createSnapshot(alice, source.sandboxId, {})
    let snapshotDeleteAttempts = 0
    provider.snapshots!.delete = async () => {
      snapshotDeleteAttempts++
      throw new ProviderError("limit", "snapshot delete rate limited")
    }
    await expectDomainError(service.deleteSnapshot(alice, snapshot.snapshotId), "provider_limit")
    expect((await snapshots.get(alice.accountId, snapshot.snapshotId))?.state).toBe("ready")
    expect(snapshotDeleteAttempts).toBe(1)
    expect(provider.inspectSnapshotCalls).toBe(1)
  })

  test("known old states use the same definite-rejection and ambiguity policy", async () => {
    const provider = new FakeSandboxProvider()
    const { service, sandboxes, snapshots } = harness({
      provider,
      sandboxIds: ["sbx_calm-cactus-a1", "sbx_blue-river-b2", "sbx_soft-cloud-c3"],
    })

    const rejectedStop = await service.createSandbox(alice, {})
    provider.stopError = new ProviderError("limit", "stop rate limited", {
      knownObservation: {
        resource: "sandbox",
        observation: { state: "running", providerRef: { privateSandboxId: rejectedStop.sandboxId } },
      },
    })
    await expectDomainError(service.stopSandbox(alice, rejectedStop.sandboxId), "provider_limit")
    expect((await sandboxes.get(alice.accountId, rejectedStop.sandboxId))?.state).toBe("running")
    expect(provider.inspectSandboxCalls).toBe(0)
    provider.stopError = undefined

    const ambiguousStop = await service.createSandbox(alice, {})
    provider.stopError = new ProviderError("ambiguous_execution", "stop response lost", {
      knownObservation: {
        resource: "sandbox",
        observation: { state: "running", providerRef: { privateSandboxId: ambiguousStop.sandboxId } },
      },
    })
    await expectDomainError(service.stopSandbox(alice, ambiguousStop.sandboxId), "ambiguous_execution")
    expect((await service.getSandbox(alice, ambiguousStop.sandboxId)).state).toBe("stopping")
    expect(provider.stopCalls).toBe(2)
    provider.stopError = undefined

    const source = await service.createSandbox(alice, {})
    const rejectedSnapshot = await service.createSnapshot(alice, source.sandboxId, {})
    provider.snapshots!.delete = async () => {
      throw new ProviderError("limit", "snapshot delete rate limited", {
        knownObservation: {
          resource: "snapshot",
          observation: { state: "ready", providerRef: { privateSnapshotId: rejectedSnapshot.snapshotId } },
        },
      })
    }
    await expectDomainError(service.deleteSnapshot(alice, rejectedSnapshot.snapshotId), "provider_limit")
    expect((await snapshots.get(alice.accountId, rejectedSnapshot.snapshotId))?.state).toBe("ready")
    expect(provider.inspectSnapshotCalls).toBe(0)

    const ambiguousSnapshot = await service.createSnapshot(alice, source.sandboxId, {})
    let ambiguousSnapshotDeletes = 0
    provider.snapshots!.delete = async () => {
      ambiguousSnapshotDeletes++
      throw new ProviderError("ambiguous_execution", "snapshot delete response lost", {
        knownObservation: {
          resource: "snapshot",
          observation: { state: "ready", providerRef: { privateSnapshotId: ambiguousSnapshot.snapshotId } },
        },
      })
    }
    await expectDomainError(service.deleteSnapshot(alice, ambiguousSnapshot.snapshotId), "ambiguous_execution")
    expect((await service.getSnapshot(alice, ambiguousSnapshot.snapshotId)).state).toBe("deleting")
    expect(ambiguousSnapshotDeletes).toBe(1)
    expect(provider.inspectSnapshotCalls).toBe(1)
  })

  test("definite lifecycle rejections restore stable state but still surface the provider error", async () => {
    const provider = new FakeSandboxProvider()
    const { service, sandboxes, snapshots } = harness({
      provider,
      sandboxIds: ["sbx_calm-cactus-a1", "sbx_blue-river-b2", "sbx_soft-cloud-c3", "sbx_warm-meadow-d4"],
    })

    const stopTarget = await service.createSandbox(alice, {})
    provider.stopError = new ProviderError("failure", "stop rejected")
    await expectDomainError(service.stopSandbox(alice, stopTarget.sandboxId), "provider_failure")
    expect((await sandboxes.get(alice.accountId, stopTarget.sandboxId))?.state).toBe("running")
    expect(provider.stopCalls).toBe(1)
    provider.stopError = undefined

    const resumeTarget = await service.createSandbox(alice, {})
    await service.stopSandbox(alice, resumeTarget.sandboxId)
    provider.resumeError = new ProviderError("failure", "resume rejected")
    await expectDomainError(service.resumeSandbox(alice, resumeTarget.sandboxId), "provider_failure")
    expect((await sandboxes.get(alice.accountId, resumeTarget.sandboxId))?.state).toBe("stopped")
    expect(provider.resumeCalls).toBe(1)
    provider.resumeError = undefined

    const deleteTarget = await service.createSandbox(alice, {})
    provider.deleteError = new ProviderError("failure", "delete rejected")
    await expectDomainError(service.deleteSandbox(alice, deleteTarget.sandboxId), "provider_failure")
    expect((await sandboxes.get(alice.accountId, deleteTarget.sandboxId))?.state).toBe("running")
    expect(provider.deleteCalls).toBe(1)
    provider.deleteError = undefined

    const source = await service.createSandbox(alice, {})
    const snapshot = await service.createSnapshot(alice, source.sandboxId, {})
    const originalDelete = provider.snapshots!.delete
    let snapshotDeleteAttempts = 0
    provider.snapshots!.delete = async () => {
      snapshotDeleteAttempts++
      throw new ProviderError("failure", "snapshot delete rejected")
    }
    await expectDomainError(service.deleteSnapshot(alice, snapshot.snapshotId), "provider_failure")
    expect((await snapshots.get(alice.accountId, snapshot.snapshotId))?.state).toBe("ready")
    expect(snapshotDeleteAttempts).toBe(1)
    provider.snapshots!.delete = originalDelete
  })

  test("a failed investigation preserves the original safe error and transition", async () => {
    const provider = new FakeSandboxProvider()
    const { service, sandboxes } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    provider.stopError = new ProviderError("failure", "dispatch rejected")
    provider.inspectSandboxError = new ProviderError("failure", "inspection rejected")

    await expectDomainError(service.stopSandbox(alice, sandbox.sandboxId), "provider_failure")
    expect(provider.stopCalls).toBe(1)
    expect(provider.inspectSandboxCalls).toBe(1)
    expect((await sandboxes.get(alice.accountId, sandbox.sandboxId))?.state).toBe("stopping")
  })

  test("maps lifecycle and snapshot operations with exact account, provider reference, and signal continuity", async () => {
    const { service, provider } = harness()
    const createSignal = new AbortController().signal
    const sandbox = await service.createSandbox(alice, {}, { signal: createSignal })
    const sandboxRef = { privateSandboxId: sandbox.sandboxId }
    expect(provider.createInputs[0]).toMatchObject({ accountId: alice.accountId, sandboxId: sandbox.sandboxId, signal: createSignal })
    expect(provider.prepareInputs[0]).toEqual({ accountId: alice.accountId, providerRef: sandboxRef, signal: createSignal })

    const snapshotSignal = new AbortController().signal
    const snapshot = await service.createSnapshot(alice, sandbox.sandboxId, {}, snapshotSignal)
    const stopSignal = new AbortController().signal
    await service.stopSandbox(alice, sandbox.sandboxId, stopSignal)
    const resumeSignal = new AbortController().signal
    await service.resumeSandbox(alice, sandbox.sandboxId, resumeSignal)
    const deleteSnapshotSignal = new AbortController().signal
    await service.deleteSnapshot(alice, snapshot.snapshotId, deleteSnapshotSignal)
    const deleteSignal = new AbortController().signal
    await service.deleteSandbox(alice, sandbox.sandboxId, deleteSignal)

    expect(provider.lifecycleInputs).toEqual([
      { operation: "inspect", input: { accountId: alice.accountId, providerRef: sandboxRef, signal: snapshotSignal } },
      { operation: "stop", input: { accountId: alice.accountId, providerRef: sandboxRef, signal: stopSignal } },
      { operation: "resume", input: { accountId: alice.accountId, providerRef: sandboxRef, signal: resumeSignal } },
      { operation: "delete", input: { accountId: alice.accountId, providerRef: sandboxRef, signal: deleteSignal } },
    ])
    expect(provider.snapshotInputs).toEqual([
      { operation: "create", input: { accountId: alice.accountId, snapshotId: snapshot.snapshotId, sandboxRef, signal: snapshotSignal } },
      { operation: "delete", input: { accountId: alice.accountId, snapshotId: snapshot.snapshotId, providerRef: { privateSnapshotId: snapshot.snapshotId }, signal: deleteSnapshotSignal } },
    ])
  })

  test("dispatches all canonical tools with exact arguments and signal", async () => {
    const { service, provider } = harness()
    const sandbox = await service.createSandbox(alice, {})
    const signal = new AbortController().signal
    const requests = [
      ["read", { filePath: "/workspace/read", offset: 2, limit: 3 }],
      ["write", { filePath: "/workspace/write", content: "content" }],
      ["edit", { filePath: "/workspace/edit", oldString: "old", newString: "new", replaceAll: true }],
      ["patch", { patchText: "*** Begin Patch\n*** End Patch" }],
      ["glob", { pattern: "**/*.ts", path: "/workspace" }],
      ["grep", { pattern: "needle", path: "/workspace", include: "*.ts" }],
      ["bash", { command: "pwd", description: "where", timeout: 1000, workdir: "/workspace" }],
    ] as const

    for (const [toolName, arguments_] of requests) {
      await collect(await service.executeTool(alice, sandbox.sandboxId, toolName, arguments_ as never, signal))
    }

    expect(provider.toolInputs.map(({ accountId, providerRef, toolName, arguments: arguments_, signal: inputSignal }) => ({
      accountId,
      providerRef,
      toolName,
      arguments: arguments_,
      signal: inputSignal,
    }))).toEqual(requests.map(([toolName, arguments_]) => ({
      accountId: alice.accountId,
      providerRef: { privateSandboxId: sandbox.sandboxId },
      toolName,
      arguments: arguments_,
      signal,
    })))
  })

  test("preserves cancellation and does not dispatch an already-cancelled tool", async () => {
    const { service, provider } = harness()
    const sandbox = await service.createSandbox(alice, {})
    const beforeDispatch = new AbortController()
    const beforeReason = new DOMException("cancel before dispatch", "AbortError")
    beforeDispatch.abort(beforeReason)

    await expect(service.executeTool(alice, sandbox.sandboxId, "read", { filePath: "/workspace/a" }, beforeDispatch.signal)).rejects.toBe(beforeReason)
    expect(provider.executeCalls).toBe(0)

    const duringStream = new AbortController()
    const events = await service.executeTool(alice, sandbox.sandboxId, "read", { filePath: "/workspace/a" }, duringStream.signal)
    const streamReason = new DOMException("cancel stream", "AbortError")
    duringStream.abort(streamReason)
    await expect(collect(events)).rejects.toBe(streamReason)
    expect(provider.executeCalls).toBe(1)
  })

  test("concurrent execution resumes a stopped sandbox exactly once", async () => {
    const provider = new FakeSandboxProvider()
    const { service } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    await service.stopSandbox(alice, sandbox.sandboxId)
    const gate = deferred()
    const started = deferred()
    provider.resumeBarrier = gate.promise
    provider.resumeStarted = started.resolve

    const first = service.executeTool(alice, sandbox.sandboxId, "read", { filePath: "/workspace/a" })
    await started.promise
    const second = service.executeTool(alice, sandbox.sandboxId, "read", { filePath: "/workspace/b" })

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

  test("a canceled resume joiner rejects independently without canceling the shared operation", async () => {
    const provider = new FakeSandboxProvider()
    const { service } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    await service.stopSandbox(alice, sandbox.sandboxId)
    const gate = deferred()
    const started = deferred()
    provider.resumeBarrier = gate.promise
    provider.resumeStarted = started.resolve

    const initiating = service.resumeSandbox(alice, sandbox.sandboxId)
    await started.promise
    const joiningController = new AbortController()
    const joining = service.resumeSandbox(alice, sandbox.sandboxId, joiningController.signal)
    const reason = new DOMException("cancel joining resume", "AbortError")
    joiningController.abort(reason)

    gate.resolve()
    await expect(joining).rejects.toBe(reason)
    expect(provider.resumeCalls).toBe(1)
    expect((await initiating).state).toBe("running")
    expect(provider.resumeCalls).toBe(1)
  })

  test("an uncanceled resume waiter reconciles after the initiating caller is canceled", async () => {
    const provider = new FakeSandboxProvider()
    const { service } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    await service.stopSandbox(alice, sandbox.sandboxId)
    const gate = deferred()
    const started = deferred()
    provider.resumeBarrier = gate.promise
    provider.resumeStarted = started.resolve
    const initiatingController = new AbortController()

    const initiating = service.resumeSandbox(alice, sandbox.sandboxId, initiatingController.signal)
    await started.promise
    const joining = service.resumeSandbox(alice, sandbox.sandboxId)
    const reason = new DOMException("cancel initiating resume", "AbortError")
    initiatingController.abort(reason)

    gate.resolve()
    await expect(initiating).rejects.toBe(reason)
    expect((await joining).state).toBe("running")
    expect(provider.resumeCalls).toBe(1)
    expect(provider.inspectSandboxCalls).toBe(1)
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

  test("forwards a dispatched bash receipt unchanged", async () => {
    const receipt = {
      type: "result", outcome: "dispatched", title: "Bash command dispatched", output: "Command dispatched. statusPath reports execution state, and outputPath receives output continuously. Repeated output reads can duplicate tokens and pollute context.",
      metadata: {
        command: "sleep 20", workdir: "/workspace", timeout: 20_000,
        jobId: `job_${"a".repeat(32)}`,
        outputPath: `/run/waterbox/bash-jobs/job_${"a".repeat(32)}/output.log`,
        statusPath: `/run/waterbox/bash-jobs/job_${"a".repeat(32)}/status.json`,
      },
    } as const
    const provider = new FakeSandboxProvider()
    provider.executeTool = (() => (async function* () { yield receipt })()) as FakeSandboxProvider["executeTool"]
    const { service } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})

    expect(await collect(await service.executeTool(alice, sandbox.sandboxId, "bash", { command: "sleep 20", timeout: 20_000 }))).toEqual([receipt])
  })

  test("ownership-checks Bash job samples and cleanup before using the optional provider capability", async () => {
    const calls: Array<{ operation: string; accountId: string; jobId: string; offset?: number; maxBytes?: number }> = []
    class BashJobProvider extends FakeSandboxProvider {
      readonly bashJobs = {
        observe: async (input: any) => {
          calls.push({ operation: "observe", accountId: input.accountId, jobId: input.jobId, offset: input.offset, maxBytes: input.maxBytes })
          return { jobId: input.jobId, state: "running" as const, chunkBase64: "", nextOffset: input.offset, outputSize: input.offset }
        },
        cleanup: async (input: any) => { calls.push({ operation: "cleanup", accountId: input.accountId, jobId: input.jobId }) },
      }
    }
    const provider = new BashJobProvider()
    const { service } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    const jobId = `job_${"a".repeat(32)}`

    await expectDomainError(service.observeBashJob(bob, sandbox.sandboxId, jobId, 0, 64), "not_found")
    expect(await service.observeBashJob(alice, sandbox.sandboxId, jobId, 3, 64)).toMatchObject({ jobId, nextOffset: 3 })
    await service.cleanupBashJob(alice, sandbox.sandboxId, jobId)
    expect(calls).toEqual([
      { operation: "observe", accountId: alice.accountId, jobId, offset: 3, maxBytes: 64 },
      { operation: "cleanup", accountId: alice.accountId, jobId },
    ])
  })

  test("preserves ambiguous tool execution when cancellation races with dispatch", async () => {
    const provider = new FakeSandboxProvider()
    const controller = new AbortController()
    provider.executeTool = ((input: Parameters<FakeSandboxProvider["executeTool"]>[0]) => (async function* () {
      controller.abort(new DOMException("caller left", "AbortError"))
      throw new ProviderError("ambiguous_execution", "response lost")
    })()) as FakeSandboxProvider["executeTool"]
    const { service } = harness({ provider })
    const sandbox = await service.createSandbox(alice, {})
    const events = await service.executeTool(alice, sandbox.sandboxId, "bash", { command: "touch /workspace/a" }, controller.signal)
    await expectDomainError(collect(events), "ambiguous_execution")
  })

  test("preparing probe blocks readiness but persists provider failure and termination", async () => {
    const { service, sandboxes, snapshots, provider } = harness()
    const sandboxId = "sbx_async-cloud-a1" as SandboxId
    const terminatedId = "sbx_gone-cloud-a1" as SandboxId
    const snapshotId = "snap_async-forest-a1" as SnapshotId
    await sandboxes.createIfAbsent(sandboxRecord(alice.accountId, sandboxId, "preparing"))
    await sandboxes.createIfAbsent(sandboxRecord(alice.accountId, terminatedId, "preparing"))
    await snapshots.createIfAbsent(snapshotRecord(alice.accountId, snapshotId, sandboxId, "creating"))
    provider.sandboxStates.set(sandboxId, "running")
    provider.snapshotStates.set(snapshotId, "ready")

    const sandboxSignal = new AbortController().signal
    const snapshotSignal = new AbortController().signal
    expect((await service.getSandbox(alice, sandboxId, sandboxSignal)).state).toBe("preparing")
    expect((await service.probeSandbox(alice, sandboxId, sandboxSignal)).state).toBe("preparing")
    provider.sandboxStates.set(sandboxId, "failed")
    expect(await service.probeSandbox(alice, sandboxId, sandboxSignal)).toMatchObject({
      state: "failed",
      lastError: { code: "provider_failure", message: "The provider reports that sandbox preparation failed" },
    })
    provider.sandboxStates.set(terminatedId, "terminated")
    expect((await service.probeSandbox(alice, terminatedId, sandboxSignal)).state).toBe("terminated")
    expect((await service.getSnapshot(alice, snapshotId, snapshotSignal)).state).toBe("ready")
    expect(provider.inspectSandboxCalls).toBe(4)
    expect(provider.inspectSnapshotCalls).toBe(1)
    expect(provider.lifecycleInputs[0]).toEqual({
      operation: "inspect",
      input: { accountId: alice.accountId, providerRef: { privateSandboxId: sandboxId }, signal: sandboxSignal },
    })
    expect(provider.snapshotInputs[0]).toEqual({
      operation: "inspect",
      input: { accountId: alice.accountId, snapshotId, providerRef: { privateSnapshotId: snapshotId }, signal: snapshotSignal },
    })
  })

  test("asynchronous create remains provisioning until readiness is prepared", async () => {
    const gate = deferred()
    const started = deferred()
    const provider = new AsyncCreateProvider()
    provider.prepareBarrier = gate.promise
    provider.prepareStarted = started.resolve
    const { service, sandboxes } = harness({ provider })

    const created = await service.createSandbox(alice, {}, { idempotencyKey: "async-create" })
    expect(created.state).toBe("provisioning")
    await expectDomainError(service.createSandbox(alice, {}, { idempotencyKey: "async-create" }), "idempotency_in_progress")

    const reconciling = service.getSandbox(alice, created.sandboxId)
    await started.promise
    expect(await sandboxes.get(alice.accountId, created.sandboxId)).toMatchObject({ state: "preparing" })
    await expectDomainError(service.executeTool(alice, created.sandboxId, "read", { filePath: "/workspace/a" }), "invalid_state")
    expect(provider.executeCalls).toBe(0)
    gate.resolve()
    expect((await reconciling).state).toBe("running")
    expect(provider.createCalls).toBe(1)
    expect(provider.inspectSandboxCalls).toBe(1)
    expect(provider.prepareCalls).toBe(1)
  })

  test("async readiness cannot persist provider-reported preparing", async () => {
    const provider = new AsyncCreateProvider()
    const { service, sandboxes } = harness({ provider })

    const created = await service.createSandbox(alice, {})
    provider.sandboxStates.set(created.sandboxId, "preparing")

    await expectDomainError(service.getSandbox(alice, created.sandboxId), "provider_failure")
    expect(await sandboxes.get(alice.accountId, created.sandboxId)).toMatchObject({
      state: "provisioning",
      providerRef: { privateSandboxId: created.sandboxId },
    })
    expect(provider.prepareCalls).toBe(0)
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
    expect(serialized).not.toContain("providerConfigurationId")
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

    expect(await sandboxes.compareAndSwap({ ...initialSandbox, state: "stopping", version: 2 }, 1)).toBe(true)
    expect(await sandboxes.compareAndSwap({ ...initialSandbox, state: "terminating", version: 2 }, 1)).toBe(false)
    expect((await sandboxes.get(alice.accountId, sandboxId))?.state).toBe("stopping")
    expect(await snapshots.compareAndSwap({ ...initialSnapshot, state: "deleting", version: 2 }, 1)).toBe(true)
    expect(await snapshots.compareAndSwap({ ...initialSnapshot, state: "failed", version: 2 }, 1)).toBe(false)
    expect((await snapshots.get(alice.accountId, snapshotId))?.state).toBe("deleting")
  })

  test("a service transition losing CAS does not invoke the provider or overwrite the winner", async () => {
    const base = new InMemorySandboxRepository()
    const racing = new RacingSandboxRepository(base)
    const provider = new FakeSandboxProvider()
    const service = inMemorySandboxService({
      sandboxes: racing,
      snapshots: new InMemorySnapshotRepository(),
      idempotency: new InMemoryIdempotencyRepository(),
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      providerConfigurationId: binding,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(),
    })
    const sandboxId = "sbx_calm-cactus-a1" as SandboxId
    await base.createIfAbsent(sandboxRecord(alice.accountId, sandboxId, "running"))

    await expectDomainError(service.stopSandbox(alice, sandboxId), "invalid_state")
    expect((await base.get(alice.accountId, sandboxId))?.state).toBe("terminated")
    expect(provider.stopCalls).toBe(0)
  })
})

class InvalidCreateObservationProvider extends FakeSandboxProvider {
  override async createSandbox(input: ProviderCreateSandboxInput) {
    this.createCalls++
    return { state: "stopped" as const, providerRef: { privateSandboxId: input.sandboxId } }
  }
}

class AsyncCreateProvider extends FakeSandboxProvider {
  override async createSandbox(input: ProviderCreateSandboxInput) {
    this.createCalls++
    this.createInputs.push(input)
    this.providerIdempotencyKeys.push(input.idempotencyKey)
    this.sandboxStates.set(input.sandboxId, "running")
    return { state: "provisioning" as const, providerRef: { privateSandboxId: input.sandboxId } }
  }
}

class AbortBeforeCreateResultProvider extends FakeSandboxProvider {
  override async createSandbox(input: ProviderCreateSandboxInput) {
    this.createCalls++
    this.createStarted?.()
    this.createInputs.push(input)
    this.providerIdempotencyKeys.push(input.idempotencyKey)
    await this.createBarrier
    input.signal.throwIfAborted()
    return { state: "running" as const, providerRef: { privateSandboxId: input.sandboxId } }
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

class RacingSandboxRepository implements SandboxRepository {
  #race: boolean

  constructor(readonly base: InMemorySandboxRepository, race = true) {
    this.#race = race
  }

  arm(): void { this.#race = true }

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
}

class FailingSandboxCasRepository implements SandboxRepository {
  constructor(readonly base: InMemorySandboxRepository) {}

  createIfAbsent(record: SandboxRecord): Promise<boolean> { return this.base.createIfAbsent(record) }
  get(accountId: string, sandboxId: SandboxId): Promise<SandboxRecord | undefined> { return this.base.get(accountId, sandboxId) }
  list(input: ListRepositoryInput): Promise<RepositoryPage<SandboxRecord>> { return this.base.list(input) }
  async compareAndSwap(): Promise<boolean> { throw new Error("injected sandbox persistence failure") }
}

class ExhaustingSourceCasRepository implements SandboxRepository {
  constructor(readonly base: InMemorySandboxRepository, private remaining: number, private readonly throws = false) {}
  createIfAbsent(record: SandboxRecord): Promise<boolean> { return this.base.createIfAbsent(record) }
  get(accountId: string, sandboxId: SandboxId): Promise<SandboxRecord | undefined> { return this.base.get(accountId, sandboxId) }
  list(input: ListRepositoryInput): Promise<RepositoryPage<SandboxRecord>> { return this.base.list(input) }
  allow(): void { this.remaining = 0 }
  compareAndSwap(record: SandboxRecord, expectedVersion: number): Promise<boolean> {
    if (record.state === "stopped" && this.remaining > 0) {
      this.remaining--
      if (this.throws) return Promise.reject(new Error("injected source persistence failure"))
      return Promise.resolve(false)
    }
    return this.base.compareAndSwap(record, expectedVersion)
  }
}

class FailingRunningCommitRepository implements SandboxRepository {
  #failRunningCommit = true
  constructor(readonly base: InMemorySandboxRepository) {}

  createIfAbsent(record: SandboxRecord): Promise<boolean> { return this.base.createIfAbsent(record) }
  get(accountId: string, sandboxId: SandboxId): Promise<SandboxRecord | undefined> { return this.base.get(accountId, sandboxId) }
  list(input: ListRepositoryInput): Promise<RepositoryPage<SandboxRecord>> { return this.base.list(input) }
  compareAndSwap(record: SandboxRecord, expectedVersion: number): Promise<boolean> {
    if (this.#failRunningCommit && record.state === "running") {
      this.#failRunningCommit = false
      throw new Error("injected running commit failure")
    }
    return this.base.compareAndSwap(record, expectedVersion)
  }
}

class RejectFailedSandboxRepository implements SandboxRepository {
  rejectFailures = true
  constructor(readonly base: InMemorySandboxRepository) {}

  createIfAbsent(record: SandboxRecord): Promise<boolean> { return this.base.createIfAbsent(record) }
  get(accountId: string, sandboxId: SandboxId): Promise<SandboxRecord | undefined> { return this.base.get(accountId, sandboxId) }
  list(input: ListRepositoryInput): Promise<RepositoryPage<SandboxRecord>> { return this.base.list(input) }
  compareAndSwap(record: SandboxRecord, expectedVersion: number): Promise<boolean> {
    if (this.rejectFailures && record.state === "failed") return Promise.resolve(false)
    return this.base.compareAndSwap(record, expectedVersion)
  }
}

function sandboxRecord(accountId: string, sandboxId: SandboxId, state: SandboxRecord["state"]): SandboxRecord {
  return {
    accountId,
    sandboxId,
    provider: "fake",
    providerConfigurationId: binding,
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
    providerConfigurationId: binding,
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
