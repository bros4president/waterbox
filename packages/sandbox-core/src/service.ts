import {
  SandboxIdSchema,
  SnapshotIdSchema,
  type CreateSandboxRequest,
  type CreateSnapshotRequest,
  type CursorPaginationRequest,
  type Identity,
  type Sandbox,
  type SandboxId,
  type SandboxPage,
  type SandboxState,
  type Snapshot,
  type SnapshotId,
  type SnapshotPage,
  type SnapshotState,
  type ToolName,
} from "@waterbox/contracts"
import { DomainError, errorRecord, mapProviderError } from "./errors.ts"
import type {
  Clock,
  IdempotencyRepository,
  ReadableIdGenerator,
  SandboxRepository,
  SnapshotRepository,
} from "./ports.ts"
import type {
  SandboxProvider,
  ToolArgumentsByName,
  ToolEventByName,
} from "./provider.ts"
import type {
  IdempotencyRecord,
  JsonValue,
  SandboxRecord,
  SnapshotRecord,
} from "./records.ts"

const CREATE_SCOPE = "sandbox:create"
const DEFAULT_LIMIT = 50
const NEVER_ABORTED = new AbortController().signal

export interface SandboxServiceDependencies {
  sandboxes: SandboxRepository
  snapshots: SnapshotRepository
  idempotency: IdempotencyRepository
  providers: ReadonlyMap<string, SandboxProvider>
  defaultProvider: string
  clock: Clock
  ids: ReadableIdGenerator
}

export interface SandboxServiceConfig {
  idempotencyTtlMs?: number
  metadataConflictRetries?: number
  reconciliationAttempts?: number
}

export interface CreateSandboxOptions {
  idempotencyKey?: string
  signal?: AbortSignal
}

export class SandboxService {
  readonly #deps: SandboxServiceDependencies
  readonly #idempotencyTtlMs: number
  readonly #metadataConflictRetries: number
  readonly #reconciliationAttempts: number
  readonly #resumeOperations = new Map<string, Promise<SandboxRecord>>()

  constructor(dependencies: SandboxServiceDependencies, config: SandboxServiceConfig = {}) {
    this.#deps = dependencies
    this.#idempotencyTtlMs = config.idempotencyTtlMs ?? 24 * 60 * 60 * 1_000
    this.#metadataConflictRetries = config.metadataConflictRetries ?? 4
    this.#reconciliationAttempts = config.reconciliationAttempts ?? 8
    if (!dependencies.providers.has(dependencies.defaultProvider)) {
      throw new DomainError("internal_error", "The default provider is not configured")
    }
  }

  async createSandbox(
    identity: Identity,
    request: CreateSandboxRequest,
    options: CreateSandboxOptions = {},
  ): Promise<Sandbox> {
    const requestHash = await hashCreateRequest(request)
    const now = this.#now()
    let reservation: IdempotencyRecord | undefined
    let reservationCanFail = true

    if (options.idempotencyKey !== undefined) {
      const existing = await this.#deps.idempotency.get({
        accountId: identity.accountId,
        scope: CREATE_SCOPE,
        key: options.idempotencyKey,
      })
      if (existing !== undefined) {
        return this.#resolveExistingCreate(identity, options.idempotencyKey, requestHash)
      }
    }

    const sandboxId = this.#sandboxId()

    if (options.idempotencyKey !== undefined) {
      reservation = {
        accountId: identity.accountId,
        scope: CREATE_SCOPE,
        key: options.idempotencyKey,
        requestHash,
        resourceId: sandboxId,
        state: "in_progress",
        version: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(this.#deps.clock.now().getTime() + this.#idempotencyTtlMs).toISOString(),
      }
      if (!await this.#deps.idempotency.createIfAbsent(reservation)) {
        return this.#resolveExistingCreate(identity, options.idempotencyKey, requestHash)
      }
    }

    try {
      const source = request.sourceSnapshotId === undefined
        ? undefined
        : await this.#getReadySnapshotRecord(identity, request.sourceSnapshotId, options.signal ?? NEVER_ABORTED)
      const providerName = source?.provider ?? this.#deps.defaultProvider
      const provider = this.#provider(providerName)
      if (source !== undefined && !provider.capabilities.createFromSnapshot) {
        throw new DomainError("unsupported_capability", "The provider does not support creating from snapshots")
      }

      const record: SandboxRecord = {
        accountId: identity.accountId,
        sandboxId,
        provider: providerName,
        providerRef: null,
        state: "provisioning",
        ...(request.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: request.sourceSnapshotId }),
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      if (!await this.#deps.sandboxes.createIfAbsent(record)) {
        throw new DomainError("conflict", "The generated sandbox ID is already in use")
      }

      let observation
      try {
        observation = await provider.createSandbox({
          accountId: identity.accountId,
          sandboxId,
          ...(source === undefined ? {} : { sourceSnapshotRef: source.providerRef }),
          idempotencyKey: await providerIdempotencyKey(identity.accountId, sandboxId),
          signal: options.signal ?? NEVER_ABORTED,
        })
      } catch (error) {
        const domainError = mapProviderError(error)
        await this.#failSandbox(record, "provisioning", domainError)
        throw domainError
      }

      let completed
      try {
        completed = await this.#applySandboxObservation(record, "provisioning", observation)
      } catch (error) {
        const domainError = error instanceof DomainError ? error : mapProviderError(error)
        await this.#failSandbox({ ...record, providerRef: observation.providerRef }, "provisioning", domainError)
        throw domainError
      }
      reservationCanFail = false
      if (reservation !== undefined) {
        try {
          await this.#completeIdempotency(reservation)
        } catch {
          throw new DomainError("conflict", "The sandbox was created but idempotency completion is pending")
        }
      }
      return toSandbox(completed)
    } catch (error) {
      const domainError = error instanceof DomainError ? error : mapProviderError(error)
      if (reservation !== undefined && reservationCanFail) await this.#failIdempotency(reservation, domainError)
      throw domainError
    }
  }

  async getSandbox(identity: Identity, sandboxId: SandboxId, signal?: AbortSignal): Promise<Sandbox> {
    const record = await this.#getSandboxRecord(identity, sandboxId)
    return toSandbox(await this.#reconcileSandbox(record, signal ?? NEVER_ABORTED))
  }

  async listSandboxes(identity: Identity, request: CursorPaginationRequest = {}, signal?: AbortSignal): Promise<SandboxPage> {
    const page = await this.#deps.sandboxes.list({
      accountId: identity.accountId,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      limit: request.limit ?? DEFAULT_LIMIT,
    })
    const items = await Promise.all(page.items.map((record) => this.#reconcileSandbox(record, signal ?? NEVER_ABORTED)))
    return { items: items.map(toSandbox), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }
  }

  async suspendSandbox(identity: Identity, sandboxId: SandboxId, signal?: AbortSignal): Promise<Sandbox> {
    const providerSignal = signal ?? NEVER_ABORTED
    const existing = await this.#getSandboxRecord(identity, sandboxId)
    if (existing.state !== "running") throw invalidState("suspend", existing.state)
    const existingProvider = this.#provider(existing.provider)
    this.#requireCapability(existingProvider.capabilities.suspend, "suspend")
    const record = await this.#claimSandboxTransition(identity, sandboxId, ["running"], "suspending")
    const provider = this.#provider(record.provider)
    try {
      const observation = await provider.suspendSandbox({
        accountId: identity.accountId,
        providerRef: record.providerRef,
        signal: providerSignal,
      })
      return toSandbox(await this.#applySandboxObservation(record, "suspending", observation))
    } catch (error) {
      const domainError = mapProviderError(error)
      await this.#failSandbox(record, "suspending", domainError)
      throw domainError
    }
  }

  async resumeSandbox(identity: Identity, sandboxId: SandboxId, signal?: AbortSignal): Promise<Sandbox> {
    const initial = await this.#getSandboxRecord(identity, sandboxId)
    if (initial.state !== "suspended" && initial.state !== "resuming") {
      throw invalidState("resume", initial.state)
    }
    return toSandbox(await this.#resumeRecord(identity, sandboxId, signal ?? NEVER_ABORTED))
  }

  async deleteSandbox(identity: Identity, sandboxId: SandboxId, signal?: AbortSignal): Promise<Sandbox> {
    const record = await this.#claimSandboxTransition(
      identity,
      sandboxId,
      ["running", "suspended", "failed"],
      "terminating",
    )
    const provider = this.#provider(record.provider)
    try {
      const observation = await provider.deleteSandbox({
        accountId: identity.accountId,
        providerRef: record.providerRef,
        signal: signal ?? NEVER_ABORTED,
      })
      return toSandbox(await this.#applySandboxObservation(record, "terminating", observation))
    } catch (error) {
      const domainError = mapProviderError(error)
      await this.#failSandbox(record, "terminating", domainError)
      throw domainError
    }
  }

  async createSnapshot(
    identity: Identity,
    sandboxId: SandboxId,
    request: CreateSnapshotRequest,
    signal?: AbortSignal,
  ): Promise<Snapshot> {
    const sandbox = await this.#reconcileSandbox(await this.#getSandboxRecord(identity, sandboxId), signal ?? NEVER_ABORTED)
    if (sandbox.state !== "running") throw invalidState("create a snapshot", sandbox.state)
    const provider = this.#provider(sandbox.provider)
    this.#requireCapability(provider.capabilities.snapshots, "snapshots")
    const snapshotId = this.#snapshotId()
    const now = this.#now()
    const record: SnapshotRecord = {
      accountId: identity.accountId,
      snapshotId,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.description === undefined ? {} : { description: request.description }),
      provider: sandbox.provider,
      providerRef: null,
      sourceSandboxId: sandboxId,
      state: "creating",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    if (!await this.#deps.snapshots.createIfAbsent(record)) {
      throw new DomainError("conflict", "The generated snapshot ID is already in use")
    }
    try {
      const observation = await provider.createSnapshot({
        accountId: identity.accountId,
        snapshotId,
        sandboxRef: sandbox.providerRef,
        signal: signal ?? NEVER_ABORTED,
      })
      return toSnapshot(await this.#applySnapshotObservation(record, "creating", observation))
    } catch (error) {
      const domainError = mapProviderError(error)
      await this.#failSnapshot(record, "creating", domainError)
      throw domainError
    }
  }

  async getSnapshot(identity: Identity, snapshotId: SnapshotId, signal?: AbortSignal): Promise<Snapshot> {
    const record = await this.#getSnapshotRecord(identity, snapshotId)
    return toSnapshot(await this.#reconcileSnapshot(record, signal ?? NEVER_ABORTED))
  }

  async listSnapshots(identity: Identity, request: CursorPaginationRequest = {}, signal?: AbortSignal): Promise<SnapshotPage> {
    const page = await this.#deps.snapshots.list({
      accountId: identity.accountId,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      limit: request.limit ?? DEFAULT_LIMIT,
    })
    const items = await Promise.all(page.items.map((record) => this.#reconcileSnapshot(record, signal ?? NEVER_ABORTED)))
    return { items: items.map(toSnapshot), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }
  }

  async deleteSnapshot(identity: Identity, snapshotId: SnapshotId, signal?: AbortSignal): Promise<Snapshot> {
    const existing = await this.#getSnapshotRecord(identity, snapshotId)
    if (existing.state !== "ready" && existing.state !== "failed") throw invalidState("delete", existing.state)
    this.#requireCapability(this.#provider(existing.provider).capabilities.snapshots, "snapshots")
    const record = await this.#claimSnapshotTransition(identity, snapshotId, ["ready", "failed"], "deleting")
    const provider = this.#provider(record.provider)
    try {
      const observation = await provider.deleteSnapshot({
        accountId: identity.accountId,
        snapshotId,
        providerRef: record.providerRef,
        signal: signal ?? NEVER_ABORTED,
      })
      return toSnapshot(await this.#applySnapshotObservation(record, "deleting", observation))
    } catch (error) {
      const domainError = mapProviderError(error)
      await this.#failSnapshot(record, "deleting", domainError)
      throw domainError
    }
  }

  async executeTool<N extends ToolName>(
    identity: Identity,
    sandboxId: SandboxId,
    toolName: N,
    arguments_: ToolArgumentsByName[N],
    signal?: AbortSignal,
  ): Promise<AsyncIterable<ToolEventByName[N]>> {
    const sandbox = await this.#ensureRunning(identity, sandboxId, signal ?? NEVER_ABORTED)
    const provider = this.#provider(sandbox.provider)
    let events: AsyncIterable<ToolEventByName[N]>
    try {
      events = provider.executeTool({
        accountId: identity.accountId,
        providerRef: sandbox.providerRef,
        toolName,
        arguments: arguments_,
        signal: signal ?? NEVER_ABORTED,
      })
    } catch (error) {
      throw mapProviderError(error)
    }
    return mapToolErrors(events)
  }

  async #resolveExistingCreate(identity: Identity, key: string, requestHash: string): Promise<Sandbox> {
    const record = await this.#deps.idempotency.get({ accountId: identity.accountId, scope: CREATE_SCOPE, key })
    if (record === undefined) throw new DomainError("conflict", "The idempotency reservation changed")
    if (record.requestHash !== requestHash) {
      throw new DomainError("idempotency_conflict", "The idempotency key was used with a different request")
    }
    if (record.state === "in_progress") {
      const sandbox = await this.#deps.sandboxes.get(identity.accountId, record.resourceId)
      if (sandbox?.state === "failed") {
        const failure = new DomainError(
          sandbox.lastError?.code ?? "provider_failure",
          sandbox.lastError?.message ?? "The sandbox creation failed",
        )
        await this.#failIdempotency(record, failure)
        throw failure
      }
      if (sandbox !== undefined && sandbox.state !== "provisioning") {
        await this.#completeIdempotency(record)
        return this.getSandbox(identity, record.resourceId)
      }
      throw new DomainError("idempotency_in_progress", "The idempotent request is still in progress")
    }
    if (record.state === "failed") {
      throw new DomainError(record.lastError?.code ?? "provider_failure", record.lastError?.message ?? "The idempotent request failed")
    }
    return this.getSandbox(identity, record.resourceId)
  }

  async #completeIdempotency(original: IdempotencyRecord): Promise<void> {
    await this.#updateIdempotency(original, "completed")
  }

  async #failIdempotency(original: IdempotencyRecord, error: DomainError): Promise<void> {
    await this.#updateIdempotency(original, "failed", error)
  }

  async #updateIdempotency(original: IdempotencyRecord, state: "completed" | "failed", error?: DomainError): Promise<void> {
    let current = original
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      if (current.state !== "in_progress") return
      const updated: IdempotencyRecord = {
        ...current,
        state,
        version: current.version + 1,
        updatedAt: this.#now(),
        ...(error === undefined ? {} : { lastError: errorRecord(error) }),
      }
      if (await this.#deps.idempotency.compareAndSwap(updated, current.version)) return
      const next = await this.#deps.idempotency.get({
        accountId: current.accountId,
        scope: current.scope,
        key: current.key,
      })
      if (next === undefined) throw new DomainError("conflict", "The idempotency reservation disappeared")
      current = next
    }
    throw new DomainError("conflict", "The idempotency record changed concurrently")
  }

  async #claimSandboxTransition(
    identity: Identity,
    sandboxId: SandboxId,
    allowed: SandboxState[],
    transition: SandboxState,
  ): Promise<SandboxRecord> {
    let current = await this.#getSandboxRecord(identity, sandboxId)
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      if (!allowed.includes(current.state)) throw invalidState(transition, current.state)
      const updated: SandboxRecord = {
        ...current,
        state: transition,
        version: current.version + 1,
        updatedAt: this.#now(),
        lastError: undefined,
      }
      if (await this.#deps.sandboxes.compareAndSwap(updated, current.version)) return updated
      current = await this.#getSandboxRecord(identity, sandboxId)
    }
    throw new DomainError("conflict", "The sandbox changed concurrently")
  }

  async #claimSnapshotTransition(
    identity: Identity,
    snapshotId: SnapshotId,
    allowed: SnapshotState[],
    transition: SnapshotState,
  ): Promise<SnapshotRecord> {
    let current = await this.#getSnapshotRecord(identity, snapshotId)
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      if (!allowed.includes(current.state)) throw invalidState(transition, current.state)
      const updated: SnapshotRecord = {
        ...current,
        state: transition,
        version: current.version + 1,
        updatedAt: this.#now(),
        lastError: undefined,
      }
      if (await this.#deps.snapshots.compareAndSwap(updated, current.version)) return updated
      current = await this.#getSnapshotRecord(identity, snapshotId)
    }
    throw new DomainError("conflict", "The snapshot changed concurrently")
  }

  async #applySandboxObservation(
    original: SandboxRecord,
    transition: SandboxState,
    observation: { state: SandboxState; providerRef: JsonValue },
  ): Promise<SandboxRecord> {
    if (isStaleSandboxObservation(transition, observation.state)) return original
    if (!isAllowedSandboxObservation(transition, observation.state)) {
      throw new DomainError("provider_failure", "The provider returned an invalid sandbox state")
    }
    let current = original
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      if (current.state !== transition) return current
      const updated: SandboxRecord = {
        ...current,
        providerRef: observation.providerRef,
        state: observation.state,
        version: current.version + 1,
        updatedAt: this.#now(),
        lastError: undefined,
      }
      if (await this.#deps.sandboxes.compareAndSwap(updated, current.version)) return updated
      const next = await this.#deps.sandboxes.get(current.accountId, current.sandboxId)
      if (next === undefined) throw new DomainError("conflict", "The sandbox disappeared")
      current = next
    }
    throw new DomainError("conflict", "The sandbox changed concurrently")
  }

  async #applySnapshotObservation(
    original: SnapshotRecord,
    transition: SnapshotState,
    observation: { state: SnapshotState; providerRef: JsonValue },
  ): Promise<SnapshotRecord> {
    if (isStaleSnapshotObservation(transition, observation.state)) return original
    if (!isAllowedSnapshotObservation(transition, observation.state)) {
      throw new DomainError("provider_failure", "The provider returned an invalid snapshot state")
    }
    let current = original
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      if (current.state !== transition) return current
      const updated: SnapshotRecord = {
        ...current,
        providerRef: observation.providerRef,
        state: observation.state,
        version: current.version + 1,
        updatedAt: this.#now(),
        lastError: undefined,
      }
      if (await this.#deps.snapshots.compareAndSwap(updated, current.version)) return updated
      const next = await this.#deps.snapshots.get(current.accountId, current.snapshotId)
      if (next === undefined) throw new DomainError("conflict", "The snapshot disappeared")
      current = next
    }
    throw new DomainError("conflict", "The snapshot changed concurrently")
  }

  async #failSandbox(original: SandboxRecord, transition: SandboxState, error: DomainError): Promise<void> {
    await this.#applySandboxObservation(original, transition, { state: "failed", providerRef: original.providerRef })
    await this.#setSandboxError(original.accountId, original.sandboxId, error)
  }

  async #setSandboxError(accountId: string, sandboxId: SandboxId, error: DomainError): Promise<void> {
    let current = await this.#deps.sandboxes.get(accountId, sandboxId)
    for (let attempt = 0; current !== undefined && attempt < this.#metadataConflictRetries; attempt++) {
      if (current.state !== "failed") return
      const updated = { ...current, lastError: errorRecord(error), version: current.version + 1, updatedAt: this.#now() }
      if (await this.#deps.sandboxes.compareAndSwap(updated, current.version)) return
      current = await this.#deps.sandboxes.get(accountId, sandboxId)
    }
  }

  async #failSnapshot(original: SnapshotRecord, transition: SnapshotState, error: DomainError): Promise<void> {
    await this.#applySnapshotObservation(original, transition, { state: "failed", providerRef: original.providerRef })
    let current = await this.#deps.snapshots.get(original.accountId, original.snapshotId)
    for (let attempt = 0; current !== undefined && attempt < this.#metadataConflictRetries; attempt++) {
      if (current.state !== "failed") return
      const updated = { ...current, lastError: errorRecord(error), version: current.version + 1, updatedAt: this.#now() }
      if (await this.#deps.snapshots.compareAndSwap(updated, current.version)) return
      current = await this.#deps.snapshots.get(original.accountId, original.snapshotId)
    }
  }

  async #reconcileSandbox(record: SandboxRecord, signal: AbortSignal): Promise<SandboxRecord> {
    if (!isTransitionalSandbox(record.state)) return record
    const provider = this.#provider(record.provider)
    let observation
    try {
      observation = await provider.inspectSandbox({ accountId: record.accountId, providerRef: record.providerRef, signal })
    } catch (error) {
      throw mapProviderError(error)
    }
    return this.#applySandboxObservation(record, record.state, observation)
  }

  async #reconcileSnapshot(record: SnapshotRecord, signal: AbortSignal): Promise<SnapshotRecord> {
    if (record.state !== "creating" && record.state !== "deleting") return record
    const provider = this.#provider(record.provider)
    let observation
    try {
      observation = await provider.inspectSnapshot({
        accountId: record.accountId,
        snapshotId: record.snapshotId,
        providerRef: record.providerRef,
        signal,
      })
    } catch (error) {
      throw mapProviderError(error)
    }
    return this.#applySnapshotObservation(record, record.state, observation)
  }

  async #resumeRecord(identity: Identity, sandboxId: SandboxId, signal: AbortSignal): Promise<SandboxRecord> {
    const operationKey = `${identity.accountId}\u0000${sandboxId}`
    for (let attempt = 0; attempt < this.#reconciliationAttempts; attempt++) {
      const current = await this.#getSandboxRecord(identity, sandboxId)
      if (current.state === "running") return current
      if (current.state === "resuming") {
        const active = this.#resumeOperations.get(operationKey)
        if (active !== undefined) return active
        const reconciled = await this.#reconcileSandbox(current, signal)
        if (reconciled.state === "running") return reconciled
        continue
      }
      if (current.state !== "suspended") throw invalidState("resume", current.state)
      const provider = this.#provider(current.provider)
      this.#requireCapability(provider.capabilities.resume, "resume")
      const claimed: SandboxRecord = {
        ...current,
        state: "resuming",
        version: current.version + 1,
        updatedAt: this.#now(),
        lastError: undefined,
      }
      if (!await this.#deps.sandboxes.compareAndSwap(claimed, current.version)) continue
      const operation = this.#finishResume(claimed, provider, signal)
      this.#resumeOperations.set(operationKey, operation)
      try {
        return await operation
      } finally {
        if (this.#resumeOperations.get(operationKey) === operation) this.#resumeOperations.delete(operationKey)
      }
    }
    throw new DomainError("conflict", "The sandbox resume is still in progress")
  }

  async #finishResume(record: SandboxRecord, provider: SandboxProvider, signal: AbortSignal): Promise<SandboxRecord> {
    try {
      const observation = await provider.resumeSandbox({
        accountId: record.accountId,
        providerRef: record.providerRef,
        signal,
      })
      return await this.#applySandboxObservation(record, "resuming", observation)
    } catch (error) {
      const domainError = mapProviderError(error)
      await this.#failSandbox(record, "resuming", domainError)
      throw domainError
    }
  }

  async #ensureRunning(identity: Identity, sandboxId: SandboxId, signal: AbortSignal): Promise<SandboxRecord> {
    for (let attempt = 0; attempt < this.#reconciliationAttempts; attempt++) {
      const current = await this.#getSandboxRecord(identity, sandboxId)
      if (current.state === "running") return current
      if (current.state === "suspended" || current.state === "resuming") {
        const resumed = await this.#resumeRecord(identity, sandboxId, signal)
        if (resumed.state === "running") return resumed
        continue
      }
      if (current.state === "provisioning") {
        const reconciled = await this.#reconcileSandbox(current, signal)
        if (reconciled.state === "running") return reconciled
        continue
      }
      throw invalidState("execute a tool", current.state)
    }
    throw new DomainError("conflict", "The sandbox did not become ready within the reconciliation bound")
  }

  async #getSandboxRecord(identity: Identity, sandboxId: SandboxId): Promise<SandboxRecord> {
    const record = await this.#deps.sandboxes.get(identity.accountId, sandboxId)
    if (record === undefined) throw new DomainError("not_found", "Sandbox not found")
    return record
  }

  async #getSnapshotRecord(identity: Identity, snapshotId: SnapshotId): Promise<SnapshotRecord> {
    const record = await this.#deps.snapshots.get(identity.accountId, snapshotId)
    if (record === undefined) throw new DomainError("not_found", "Snapshot not found")
    return record
  }

  async #getReadySnapshotRecord(
    identity: Identity,
    snapshotId: SnapshotId,
    signal: AbortSignal,
  ): Promise<SnapshotRecord> {
    const record = await this.#reconcileSnapshot(await this.#getSnapshotRecord(identity, snapshotId), signal)
    if (record.state !== "ready") throw invalidState("create a sandbox from the snapshot", record.state)
    return record
  }

  #provider(name: string): SandboxProvider {
    const provider = this.#deps.providers.get(name)
    if (provider === undefined) throw new DomainError("internal_error", "The resource provider is not configured")
    return provider
  }

  #requireCapability(supported: boolean, capability: string): void {
    if (!supported) throw new DomainError("unsupported_capability", `The provider does not support ${capability}`)
  }

  #sandboxId(): SandboxId {
    const parsed = SandboxIdSchema.safeParse(this.#deps.ids.sandboxId())
    if (!parsed.success) throw new DomainError("internal_error", "The ID generator returned an invalid sandbox ID")
    return parsed.data
  }

  #snapshotId(): SnapshotId {
    const parsed = SnapshotIdSchema.safeParse(this.#deps.ids.snapshotId())
    if (!parsed.success) throw new DomainError("internal_error", "The ID generator returned an invalid snapshot ID")
    return parsed.data
  }

  #now(): string {
    return this.#deps.clock.now().toISOString()
  }
}

function toSandbox(record: SandboxRecord): Sandbox {
  return {
    sandboxId: record.sandboxId,
    provider: record.provider,
    state: record.state,
    ...(record.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: record.sourceSnapshotId }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  }
}

function toSnapshot(record: SnapshotRecord): Snapshot {
  return {
    snapshotId: record.snapshotId,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.description === undefined ? {} : { description: record.description }),
    provider: record.provider,
    sourceSandboxId: record.sourceSandboxId,
    state: record.state,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  }
}

async function hashCreateRequest(request: CreateSandboxRequest): Promise<string> {
  const normalized = JSON.stringify({ sourceSnapshotId: request.sourceSnapshotId ?? null })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized))
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

async function providerIdempotencyKey(accountId: string, sandboxId: SandboxId): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${accountId}\u0000${sandboxId}`))
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `waterbox:create:${hash}`
}

function invalidState(operation: string, state: string): DomainError {
  return new DomainError("invalid_state", `Cannot ${operation} while the resource is ${state}`)
}

function isTransitionalSandbox(state: SandboxState): boolean {
  return state === "provisioning" || state === "suspending" || state === "resuming" || state === "terminating"
}

function isAllowedSandboxObservation(transition: SandboxState, observed: SandboxState): boolean {
  if (observed === transition || observed === "failed") return true
  if (transition === "provisioning") return observed === "running"
  if (transition === "suspending") return observed === "suspended"
  if (transition === "resuming") return observed === "running"
  if (transition === "terminating") return observed === "terminated"
  return false
}

function isStaleSandboxObservation(transition: SandboxState, observed: SandboxState): boolean {
  if (transition === "suspending") return observed === "running"
  if (transition === "resuming") return observed === "suspended"
  if (transition === "terminating") return observed === "running" || observed === "suspended"
  return false
}

function isAllowedSnapshotObservation(transition: SnapshotState, observed: SnapshotState): boolean {
  if (observed === transition || observed === "failed") return true
  if (transition === "creating") return observed === "ready"
  if (transition === "deleting") return observed === "deleted"
  return false
}

function isStaleSnapshotObservation(transition: SnapshotState, observed: SnapshotState): boolean {
  return transition === "deleting" && observed === "ready"
}

async function* mapToolErrors<T>(events: AsyncIterable<T>): AsyncIterable<T> {
  try {
    for await (const event of events) yield event
  } catch (error) {
    throw mapProviderError(error)
  }
}
