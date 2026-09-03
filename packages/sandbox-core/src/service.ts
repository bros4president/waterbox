import {
  SandboxIdSchema,
  SnapshotIdSchema,
  type CreateSandboxRequest,
  type CreateSnapshotRequest,
  type CursorPaginationRequest,
  type Identity,
  type ProviderConfigurationId,
  type Sandbox,
  type SandboxId,
  type SandboxPage,
  type SandboxState,
  type SecureTransferConsumeRequest,
  type SecureTransferDelivered,
  type SecureTransferId,
  type SecureTransferInitiated,
  type Snapshot,
  type SnapshotId,
  type SnapshotPage,
  type SnapshotState,
  type ToolName,
  type BashJobObservation,
  type ToolArgumentsByName,
  type ToolEventByName,
} from "@waterbox/contracts"
import { DomainError, SandboxRecoveryError, errorRecord, mapProviderError } from "./errors.ts"
import { ProviderError, type ProviderSandboxObservation, type ProviderSnapshotObservation } from "./provider.ts"
import type {
  Clock,
  IdempotencyRepository,
  ReadableIdGenerator,
  SandboxCreationRepository,
  SandboxRepository,
  SnapshotRepository,
} from "./ports.ts"
import type { SandboxProvider } from "./provider.ts"
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
  /** Atomic ownership of a generated row and optional idempotency record. */
  sandboxCreations: SandboxCreationRepository
  providers: ReadonlyMap<string, SandboxProvider>
  defaultProvider: string
  /** The only provider resource scope this embedded service may operate. */
  providerConfigurationId: ProviderConfigurationId
  clock: Clock
  ids: ReadableIdGenerator
}

export interface SandboxServiceConfig {
  allocationAttempts?: number
  metadataConflictRetries?: number
  reconciliationAttempts?: number
}

export interface CreateSandboxOptions {
  idempotencyKey?: string
  signal?: AbortSignal
}

export class SandboxService {
  readonly #deps: SandboxServiceDependencies
  readonly #allocationAttempts: number
  readonly #metadataConflictRetries: number
  readonly #reconciliationAttempts: number
  readonly #resumeOperations = new Map<string, Promise<SandboxRecord>>()

  constructor(dependencies: SandboxServiceDependencies, config: SandboxServiceConfig = {}) {
    this.#deps = dependencies
    this.#allocationAttempts = config.allocationAttempts ?? 4
    this.#metadataConflictRetries = config.metadataConflictRetries ?? 4
    this.#reconciliationAttempts = config.reconciliationAttempts ?? 8
    if (!dependencies.providers.has(dependencies.defaultProvider)) {
      throw new DomainError("internal_error", "The default provider is not configured")
    }
    for (const provider of dependencies.providers.values()) {
      if (typeof provider.prepareSandbox !== "function") {
        throw new DomainError("internal_error", "A configured provider does not implement sandbox preparation")
      }
    }
  }

  async createSandbox(
    identity: Identity,
    request: CreateSandboxRequest,
    options: CreateSandboxOptions = {},
  ): Promise<Sandbox> {
    const providerSignal = options.signal ?? NEVER_ABORTED
    providerSignal.throwIfAborted()
    const requestHash = await hashCreateRequest(request)
    let reservation: IdempotencyRecord | undefined
    let reservationCanFail = true

    if (options.idempotencyKey !== undefined && await this.#deps.idempotency.get({
      accountId: identity.accountId,
      scope: CREATE_SCOPE,
      key: options.idempotencyKey,
    }) !== undefined) return this.#resolveExistingCreate(identity, options.idempotencyKey, requestHash, providerSignal)

    const source = request.sourceSnapshotId === undefined
      ? undefined
      : await this.#getReadySnapshotRecord(identity, request.sourceSnapshotId, providerSignal)
    const providerName = this.#deps.defaultProvider
    const provider = this.#provider(providerName)

    providerSignal.throwIfAborted()
    let record: SandboxRecord | undefined
    for (let attempt = 0; attempt < this.#allocationAttempts; attempt++) {
      const sandboxId = this.#sandboxId()
      const now = this.#now()
      const candidate: SandboxRecord = {
        accountId: identity.accountId,
        sandboxId,
        provider: providerName,
        providerConfigurationId: this.#activeProviderConfigurationId(),
        providerRef: null,
        state: "provisioning",
        ...(request.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: request.sourceSnapshotId }),
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      const candidateReservation = options.idempotencyKey === undefined ? undefined : {
        accountId: identity.accountId,
        scope: CREATE_SCOPE,
        key: options.idempotencyKey,
        requestHash,
        resourceId: sandboxId,
        state: "in_progress" as const,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      const allocation = await this.#deps.sandboxCreations.reserve({
        sandbox: candidate,
        ...(candidateReservation === undefined ? {} : { idempotency: candidateReservation }),
      })
      if (allocation.outcome === "candidate_collision") continue
      if (allocation.outcome === "request_mismatch") {
        throw new DomainError("idempotency_conflict", "The idempotency key was used with a different request")
      }
      if (allocation.outcome === "existing_match") {
        return this.#resolveExistingCreate(identity, options.idempotencyKey!, requestHash, providerSignal)
      }
      record = candidate
      reservation = allocation.reservation
      break
    }
    if (record === undefined) throw new DomainError("internal_error", "Unable to allocate a unique sandbox ID")
    const sandboxId = record.sandboxId

    try {
      let observation
      try {
        observation = await provider.createSandbox({
          accountId: identity.accountId,
          sandboxId,
          ...(source === undefined ? {} : { sourceSnapshotRef: source.providerRef }),
          idempotencyKey: await providerIdempotencyKey(identity.accountId, sandboxId),
          signal: providerSignal,
        })
        providerSignal.throwIfAborted()
      } catch (error) {
        if (providerSignal.aborted && !isAmbiguousExecution(error)) {
          if (observation !== undefined) {
            try {
              if (observation.state === "running") await this.#checkpointPreparation(record, observation)
              else await this.#applySandboxObservation(record, "provisioning", observation)
            } catch {}
          }
          throw providerSignal.reason
        }
        const domainError = mapProviderError(error)
        await this.#failSandbox(record, "provisioning", domainError)
        throw domainError
      }

      if (observation.state === "provisioning") {
        try {
          const pending = await this.#applySandboxObservation(record, "provisioning", observation)
          reservationCanFail = false
          return toSandbox(pending)
        } catch (error) {
          const domainError = error instanceof DomainError ? error : mapProviderError(error)
          await this.#failSandbox({ ...record, providerRef: observation.providerRef }, "provisioning", domainError)
          throw domainError
        }
      }

      let preparing: SandboxRecord
      try {
        preparing = await this.#checkpointPreparation(record, observation)
      } catch (error) {
        const domainError = error instanceof DomainError ? error : mapProviderError(error)
        await this.#failSandbox({ ...record, providerRef: observation.providerRef }, "provisioning", domainError)
        throw domainError
      }
      reservationCanFail = false
      const completed = await this.#finishPreparation(preparing, provider, providerSignal, reservation)
      if (reservation !== undefined) {
        try {
          await this.#completeIdempotency(reservation)
        } catch {
          throw new SandboxRecoveryError(
            new DomainError("conflict", "The sandbox was created but idempotency completion is pending"),
            sandboxId,
          )
        }
      }
      return toSandbox(completed)
    } catch (error) {
      if (providerSignal.aborted && !isAmbiguousExecution(error)) throw providerSignal.reason
      const domainError = error instanceof DomainError ? error : mapProviderError(error)
      if (reservation !== undefined && reservationCanFail) await this.#failIdempotency(reservation, domainError)
      if (!reservationCanFail && !(domainError instanceof SandboxRecoveryError)) {
        throw new SandboxRecoveryError(domainError, sandboxId)
      }
      throw domainError
    }
  }

  async getSandbox(identity: Identity, sandboxId: SandboxId, signal?: AbortSignal): Promise<Sandbox> {
    const record = await this.#getSandboxRecord(identity, sandboxId)
    return toSandbox(await this.#reconcileSandbox(record, signal ?? NEVER_ABORTED))
  }

  async probeSandbox(identity: Identity, sandboxId: SandboxId, signal: AbortSignal = NEVER_ABORTED): Promise<Sandbox> {
    let current = await this.#getSandboxRecord(identity, sandboxId)
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      signal.throwIfAborted()
      if (current.providerRef === null) return toSandbox(current)
      const provider = this.#provider(current.provider)
      let observation
      try {
        observation = await provider.inspectSandbox({ accountId: current.accountId, providerRef: current.providerRef, signal })
        signal.throwIfAborted()
      } catch (error) {
        if (signal.aborted) throw signal.reason
        throw mapProviderError(error)
      }
      if (current.state === "provisioning") {
        if (current.providerRef === null) return toSandbox(current)
        const reconciled = await this.#reconcileProvisioning(current, signal, observation)
        return toSandbox(reconciled)
      }
      if (current.state === "preparing") {
        if (observation.state === "failed") {
          return toSandbox(await this.#failSandbox(
            current,
            "preparing",
            new DomainError("provider_failure", "The provider reports that sandbox preparation failed"),
          ))
        }
        if (observation.state === "terminated") {
          return toSandbox(await this.#applySandboxObservation(current, "preparing", {
            state: "terminated",
            providerRef: current.providerRef,
          }))
        }
        return toSandbox(current)
      }
      if (current.state === "failed") {
        if (observation.state === "terminated") {
          return toSandbox(await this.#applySandboxObservation(current, "failed", {
            state: "terminated",
            providerRef: observation.providerRef,
          }))
        }
        return toSandbox(current)
      }
      if (isTransitionalSandbox(current.state)) return toSandbox(await this.#applySandboxObservation(current, current.state, observation))
      if (!isAllowedLiveSandboxObservation(current.state, observation.state)) {
        throw new DomainError("provider_failure", "The provider returned an invalid live sandbox state")
      }
      if (current.state === observation.state) return toSandbox(current)
      const updated: SandboxRecord = {
        ...current,
        providerRef: observation.providerRef,
        state: observation.state,
        version: current.version + 1,
        updatedAt: this.#now(),
        lastError: undefined,
      }
      if (await this.#deps.sandboxes.compareAndSwap(updated, current.version)) return toSandbox(updated)
      current = await this.#getSandboxRecord(identity, sandboxId)
    }
    throw new DomainError("conflict", "The sandbox changed concurrently")
  }

  async listSandboxes(identity: Identity, request: CursorPaginationRequest = {}, signal?: AbortSignal): Promise<SandboxPage> {
    const page = await this.#deps.sandboxes.list({
      accountId: identity.accountId,
      provider: this.#deps.defaultProvider,
      providerConfigurationId: this.#activeProviderConfigurationId(),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      limit: request.limit ?? DEFAULT_LIMIT,
    })
    const items = await Promise.all(page.items.map((record) => this.#reconcileSandbox(record, signal ?? NEVER_ABORTED)))
    return { items: items.map(toSandbox), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }
  }

  async stopSandbox(identity: Identity, sandboxId: SandboxId, signal?: AbortSignal): Promise<Sandbox> {
    const providerSignal = signal ?? NEVER_ABORTED
    providerSignal.throwIfAborted()
    const existing = await this.#getSandboxRecord(identity, sandboxId)
    const existingProvider = this.#provider(existing.provider)
    const stopResume = this.#requireStopResume(existingProvider)
    if (existing.state !== "running" && existing.state !== "stopped") throw invalidState("stop", existing.state)
    // Stable local state is only an observational checkpoint. An explicit stop
    // always claims and dispatches so out-of-band provider drift is corrected.
    const claimed = await this.#claimSandboxTransition(identity, sandboxId, ["running", "stopped"], "stopping", providerSignal)
    const { record, previous } = claimed
    try {
      const observation = await stopResume.stop({
        accountId: identity.accountId,
        providerRef: record.providerRef,
        signal: providerSignal,
      })
      providerSignal.throwIfAborted()
      return toSandbox(await this.#applySandboxObservation(record, "stopping", observation))
    } catch (error) {
      if (providerSignal.aborted && !isAmbiguousExecution(error)) throw providerSignal.reason
      const recovered = await this.#investigateSandboxLifecycle(record, "stopping", previous, "stopped", error, providerSignal)
      if (recovered !== undefined) return toSandbox(recovered)
      throw mapProviderError(error)
    }
  }

  async resumeSandbox(identity: Identity, sandboxId: SandboxId, signal?: AbortSignal): Promise<Sandbox> {
    const providerSignal = signal ?? NEVER_ABORTED
    providerSignal.throwIfAborted()
    const initial = await this.#getSandboxRecord(identity, sandboxId)
    this.#requireStopResume(this.#provider(initial.provider))
    if (initial.state !== "running" && initial.state !== "stopped" && initial.state !== "resuming") {
      throw invalidState("resume", initial.state)
    }
    return toSandbox(await this.#resumeRecord(identity, sandboxId, providerSignal, true))
  }

  async deleteSandbox(identity: Identity, sandboxId: SandboxId, signal?: AbortSignal): Promise<Sandbox> {
    const providerSignal = signal ?? NEVER_ABORTED
    providerSignal.throwIfAborted()
    const existing = await this.#getSandboxRecord(identity, sandboxId)
    if (existing.state === "terminated") return toSandbox(existing)
    const claimed = await this.#claimSandboxTransition(
      identity,
      sandboxId,
      ["preparing", "running", "stopped", "failed"],
      "terminating",
      providerSignal,
    )
    const { record, previous } = claimed
    const provider = this.#provider(record.provider)
    try {
      const observation = await provider.deleteSandbox({
        accountId: identity.accountId,
        providerRef: record.providerRef,
        signal: providerSignal,
      })
      providerSignal.throwIfAborted()
      return toSandbox(await this.#applySandboxObservation(record, "terminating", observation))
    } catch (error) {
      if (providerSignal.aborted && !isAmbiguousExecution(error)) throw providerSignal.reason
      const recovered = await this.#investigateSandboxLifecycle(record, "terminating", previous, "terminated", error, providerSignal)
      if (recovered !== undefined) return toSandbox(recovered)
      throw mapProviderError(error)
    }
  }

  async createSnapshot(
    identity: Identity,
    sandboxId: SandboxId,
    request: CreateSnapshotRequest,
    signal?: AbortSignal,
  ): Promise<Snapshot> {
    const providerSignal = signal ?? NEVER_ABORTED
    providerSignal.throwIfAborted()
    const existing = await this.#getSandboxRecord(identity, sandboxId)
    const provider = this.#provider(existing.provider)
    const snapshots = this.#requireSnapshots(provider)
    // This core preflight can become stale; the primitive adapter performs the
    // final native running revalidation immediately before its mutation.
    await this.probeSandbox(identity, sandboxId, providerSignal)
    const sandbox = await this.#getSandboxRecord(identity, sandboxId)
    if (sandbox.state !== "running") throw invalidState("create a snapshot", sandbox.state)
    providerSignal.throwIfAborted()
    let record: SnapshotRecord | undefined
    for (let attempt = 0; attempt < this.#allocationAttempts; attempt++) {
      const snapshotId = this.#snapshotId()
      const now = this.#now()
      const candidate: SnapshotRecord = {
        accountId: identity.accountId,
        snapshotId,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.description === undefined ? {} : { description: request.description }),
        provider: sandbox.provider,
        providerConfigurationId: this.#activeProviderConfigurationId(),
        providerRef: null,
        sourceSandboxId: sandboxId,
        state: "creating",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      if (await this.#deps.snapshots.createIfAbsent(candidate)) {
        record = candidate
        break
      }
    }
    if (record === undefined) throw new DomainError("internal_error", "Unable to allocate a unique snapshot ID")
    const snapshotId = record.snapshotId
    let observation
    try {
      observation = await snapshots.create({
        accountId: identity.accountId,
        snapshotId,
        sandboxRef: sandbox.providerRef,
        signal: providerSignal,
      })
      providerSignal.throwIfAborted()
      // Retain creating until a provider-reported source consequence is durable.
      // The persisted reference lets normal snapshot reconciliation finish this
      // checkpoint after a process loss without any provider-specific state.
      const checkpointed = await this.#applySnapshotObservation(record, "creating", {
        state: observation.sourceSandbox === undefined ? observation.state : "creating",
        providerRef: observation.providerRef,
      })
      if (observation.sourceSandbox !== undefined) {
        try { await this.#applySnapshotSourceObservation(sandbox, observation.sourceSandbox) }
        catch { return toSnapshot(checkpointed) }
      }
      return toSnapshot(await this.#applySnapshotObservation(checkpointed, "creating", observation))
    } catch (error) {
      if (providerSignal.aborted && !isAmbiguousExecution(error)) {
        if (observation !== undefined) {
          try {
            await this.#applySnapshotObservation(record, "creating", {
              state: "creating",
              providerRef: observation.providerRef,
            })
          } catch {}
        }
        throw providerSignal.reason
      }
      const domainError = mapProviderError(error)
      await this.#failSnapshot(record, "creating", domainError)
      throw domainError
    }
  }

  async getSnapshot(identity: Identity, snapshotId: SnapshotId, signal?: AbortSignal): Promise<Snapshot> {
    const record = await this.#getSnapshotRecord(identity, snapshotId)
    this.#requireSnapshots(this.#provider(record.provider))
    return toSnapshot(await this.#reconcileSnapshot(record, signal ?? NEVER_ABORTED))
  }

  async listSnapshots(identity: Identity, request: CursorPaginationRequest = {}, signal?: AbortSignal): Promise<SnapshotPage> {
    const page = await this.#deps.snapshots.list({
      accountId: identity.accountId,
      provider: this.#deps.defaultProvider,
      providerConfigurationId: this.#activeProviderConfigurationId(),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      limit: request.limit ?? DEFAULT_LIMIT,
    })
    for (const record of page.items) this.#requireSnapshots(this.#provider(record.provider))
    const items = await Promise.all(page.items.map((record) => this.#reconcileSnapshot(record, signal ?? NEVER_ABORTED)))
    return { items: items.map(toSnapshot), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }
  }

  async deleteSnapshot(identity: Identity, snapshotId: SnapshotId, signal?: AbortSignal): Promise<Snapshot> {
    const providerSignal = signal ?? NEVER_ABORTED
    providerSignal.throwIfAborted()
    const existing = await this.#getSnapshotRecord(identity, snapshotId)
    const snapshots = this.#requireSnapshots(this.#provider(existing.provider))
    if (existing.state === "deleted") return toSnapshot(existing)
    if (existing.state !== "ready" && existing.state !== "failed") throw invalidState("delete", existing.state)
    const record = await this.#claimSnapshotTransition(identity, snapshotId, ["ready", "failed"], "deleting", providerSignal)
    try {
      const observation = await snapshots.delete({
        accountId: identity.accountId,
        snapshotId,
        providerRef: record.providerRef,
        signal: providerSignal,
      })
      providerSignal.throwIfAborted()
      return toSnapshot(await this.#applySnapshotObservation(record, "deleting", observation))
    } catch (error) {
      if (providerSignal.aborted && !isAmbiguousExecution(error)) throw providerSignal.reason
      const recovered = await this.#investigateSnapshotLifecycle(record, "deleting", existing.state, error, providerSignal)
      if (recovered !== undefined) return toSnapshot(recovered)
      throw mapProviderError(error)
    }
  }

  async executeTool<N extends ToolName>(
    identity: Identity,
    sandboxId: SandboxId,
    toolName: N,
    arguments_: ToolArgumentsByName[N],
    signal?: AbortSignal,
  ): Promise<AsyncIterable<ToolEventByName[N]>> {
    const providerSignal = signal ?? NEVER_ABORTED
    providerSignal.throwIfAborted()
    const sandbox = await this.#ensureRunning(identity, sandboxId, providerSignal)
    const provider = this.#provider(sandbox.provider)
    let events: AsyncIterable<ToolEventByName[N]>
    try {
      events = provider.executeTool({
        accountId: identity.accountId,
        providerRef: sandbox.providerRef,
        toolName,
        arguments: arguments_,
        signal: providerSignal,
      })
    } catch (error) {
      if (providerSignal.aborted) throw providerSignal.reason
      await this.#learnSandboxFromOperationalFailure(sandbox, error, providerSignal)
      throw mapProviderError(error)
    }
    return this.#mapToolErrors(events, sandbox, providerSignal)
  }

  async observeBashJob(identity: Identity, sandboxId: SandboxId, jobId: string, offset: number, maxBytes: number, signal: AbortSignal = NEVER_ABORTED): Promise<BashJobObservation> {
    signal.throwIfAborted()
    if (!/^job_[0-9a-f]{32}$/.test(jobId) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) throw new DomainError("invalid_request", "The Bash job observation is invalid")
    const sandbox = await this.#getSandboxRecord(identity, sandboxId)
    if (sandbox.state === "preparing") throw invalidState("observe a Bash job", sandbox.state)
    const capability = this.#provider(sandbox.provider).bashJobs
    if (capability === undefined) throw new DomainError("unsupported_capability", "The provider does not support Bash job observation")
    try {
      return await capability.observe({ accountId: sandbox.accountId, providerRef: sandbox.providerRef, jobId, offset, maxBytes, signal })
    } catch (error) {
      if (signal.aborted) throw signal.reason
      await this.#learnSandboxFromOperationalFailure(sandbox, error, signal)
      throw mapProviderError(error)
    }
  }

  async cleanupBashJob(identity: Identity, sandboxId: SandboxId, jobId: string, signal: AbortSignal = NEVER_ABORTED): Promise<void> {
    signal.throwIfAborted()
    if (!/^job_[0-9a-f]{32}$/.test(jobId)) throw new DomainError("invalid_request", "The Bash job cleanup is invalid")
    const sandbox = await this.#getSandboxRecord(identity, sandboxId)
    if (sandbox.state === "preparing") throw invalidState("clean up a Bash job", sandbox.state)
    const capability = this.#provider(sandbox.provider).bashJobs
    if (capability === undefined) throw new DomainError("unsupported_capability", "The provider does not support Bash job observation")
    try {
      await capability.cleanup({ accountId: sandbox.accountId, providerRef: sandbox.providerRef, jobId, signal })
    } catch (error) {
      if (signal.aborted) throw signal.reason
      await this.#learnSandboxFromOperationalFailure(sandbox, error, signal)
      throw mapProviderError(error)
    }
  }

  async initiateSecureFileTransfer(identity: Identity, sandboxId: SandboxId, signal: AbortSignal = NEVER_ABORTED): Promise<SecureTransferInitiated> {
    signal.throwIfAborted()
    const existing = await this.#getSandboxRecord(identity, sandboxId)
    const transfers = this.#requireSecureFileTransfer(this.#provider(existing.provider))
    const sandbox = await this.#ensureRunning(identity, sandboxId, signal)
    try {
      const result = await transfers.initiate({ accountId: identity.accountId, providerRef: sandbox.providerRef, signal })
      signal.throwIfAborted()
      return result
    } catch (error) {
      if (signal.aborted) throw signal.reason
      await this.#learnSandboxFromOperationalFailure(sandbox, error, signal)
      throw mapProviderError(error)
    }
  }

  async consumeSecureFileTransfer(
    identity: Identity,
    sandboxId: SandboxId,
    transferId: SecureTransferId,
    request: SecureTransferConsumeRequest,
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<SecureTransferDelivered> {
    signal.throwIfAborted()
    const existing = await this.#getSandboxRecord(identity, sandboxId)
    const transfers = this.#requireSecureFileTransfer(this.#provider(existing.provider))
    const sandbox = await this.#ensureRunning(identity, sandboxId, signal)
    try {
      const result = await transfers.consume({ accountId: identity.accountId, providerRef: sandbox.providerRef, transferId, ...request, signal })
      return result
    } catch (error) {
      if (signal.aborted && !(error instanceof ProviderError && error.kind === "ambiguous_execution")) throw signal.reason
      await this.#learnSandboxFromOperationalFailure(sandbox, error, signal)
      throw mapProviderError(error)
    }
  }

  async #resolveExistingCreate(identity: Identity, key: string, requestHash: string, signal: AbortSignal): Promise<Sandbox> {
    const record = await this.#deps.idempotency.get({ accountId: identity.accountId, scope: CREATE_SCOPE, key })
    if (record === undefined) throw new DomainError("conflict", "The idempotency reservation changed")
    if (record.requestHash !== requestHash) {
      throw new DomainError("idempotency_conflict", "The idempotency key was used with a different request")
    }
    if (record.state === "in_progress") {
      const sandbox = await this.#deps.sandboxes.get(identity.accountId, record.resourceId)
      if (sandbox !== undefined) this.#requireActiveBinding(sandbox)
      if (sandbox?.state === "failed") {
        const failure = new DomainError(
          sandbox.lastError?.code ?? "provider_failure",
          sandbox.lastError?.message ?? "The sandbox creation failed",
        )
        try { await this.#failIdempotency(record, failure) } catch {}
        throw new SandboxRecoveryError(failure, sandbox.sandboxId)
      }
      if (sandbox?.state === "preparing" && sandbox.providerRef !== null) {
        const completed = await this.#finishPreparation(sandbox, this.#provider(sandbox.provider), signal, record)
        try {
          await this.#completeIdempotency(record)
        } catch {
          throw new SandboxRecoveryError(
            new DomainError("conflict", "The sandbox was created but idempotency completion is pending"),
            sandbox.sandboxId,
          )
        }
        return toSandbox(completed)
      }
      if (sandbox !== undefined && sandbox.state !== "provisioning") {
        await this.#completeIdempotency(record)
        return this.getSandbox(identity, record.resourceId)
      }
      throw new DomainError("idempotency_in_progress", "The idempotent request is still in progress")
    }
    if (record.state === "failed") {
      const sandbox = await this.#deps.sandboxes.get(identity.accountId, record.resourceId)
      if (sandbox !== undefined) this.#requireActiveBinding(sandbox)
      const failure = new DomainError(
        sandbox?.lastError?.code ?? record.lastError?.code ?? "provider_failure",
        sandbox?.lastError?.message ?? record.lastError?.message ?? "The idempotent request failed",
      )
      if (sandbox !== undefined && sandbox.providerRef !== null) {
        throw new SandboxRecoveryError(failure, sandbox.sandboxId)
      }
      throw failure
    }
    return this.getSandbox(identity, record.resourceId)
  }

  async #checkpointPreparation(
    original: SandboxRecord,
    observation: { state: SandboxState; providerRef: JsonValue },
  ): Promise<SandboxRecord> {
    if (observation.state !== "running" || observation.providerRef === null) {
      throw new DomainError("provider_failure", "The provider returned an invalid sandbox state")
    }
    if (original.providerRef !== null && !jsonEquals(original.providerRef, observation.providerRef)) {
      throw new DomainError("provider_failure", "The provider returned a mismatched sandbox reference")
    }
    return this.#applySandboxObservation(original, "provisioning", {
      state: "preparing",
      providerRef: observation.providerRef,
    })
  }

  async #finishPreparation(
    record: SandboxRecord,
    provider: SandboxProvider,
    signal: AbortSignal,
    reservation?: IdempotencyRecord,
  ): Promise<SandboxRecord> {
    try {
      const observation = await provider.prepareSandbox({
        accountId: record.accountId,
        providerRef: record.providerRef,
        signal,
      })
      signal.throwIfAborted()
      if (observation.state !== "running" || !jsonEquals(observation.providerRef, record.providerRef)) {
        throw new ProviderError("failure", "The provider returned an invalid preparation result")
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      const domainError = mapProviderError(error)
      if (domainError.code === "ambiguous_execution") {
        throw new SandboxRecoveryError(domainError, record.sandboxId)
      }
      let failed
      try {
        failed = await this.#failSandbox(record, "preparing", domainError)
      } catch {
        throw new SandboxRecoveryError(
          new DomainError("conflict", "The sandbox preparation result could not be persisted"),
          record.sandboxId,
        )
      }
      if (failed.state === "running") return failed
      if (reservation !== undefined) {
        try {
          await this.#failIdempotency(reservation, domainError)
        } catch {
          throw new SandboxRecoveryError(
            new DomainError("conflict", "The sandbox preparation failure is pending persistence"),
            record.sandboxId,
          )
        }
      }
      throw new SandboxRecoveryError(domainError, record.sandboxId)
    }
    try {
      return await this.#commitPreparationSuccess(record)
    } catch {
      throw new SandboxRecoveryError(
        new DomainError("conflict", "The successful sandbox preparation result is pending persistence"),
        record.sandboxId,
      )
    }
  }

  async #commitPreparationSuccess(original: SandboxRecord): Promise<SandboxRecord> {
    let current = original
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      if (!jsonEquals(current.providerRef, original.providerRef)) {
        throw new DomainError("conflict", "The sandbox provider reference changed during preparation")
      }
      if (current.state === "running") return current
      if (current.state !== "preparing") {
        throw new DomainError("conflict", "The sandbox changed during preparation")
      }
      const updated: SandboxRecord = {
        ...current,
        providerRef: original.providerRef,
        state: "running",
        version: current.version + 1,
        updatedAt: this.#now(),
        lastError: undefined,
      }
      if (await this.#deps.sandboxes.compareAndSwap(updated, current.version)) return updated
      const next = await this.#deps.sandboxes.get(current.accountId, current.sandboxId)
      if (next === undefined) throw new DomainError("conflict", "The sandbox disappeared")
      current = next
    }
    throw new DomainError("conflict", "The successful sandbox preparation result is still pending")
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
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<{ record: SandboxRecord; previous: SandboxState }> {
    let current = await this.#getSandboxRecord(identity, sandboxId)
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      if (!allowed.includes(current.state)) throw invalidState(transition, current.state)
      signal.throwIfAborted()
      const updated: SandboxRecord = {
        ...current,
        state: transition,
        version: current.version + 1,
        updatedAt: this.#now(),
        lastError: undefined,
      }
      if (await this.#deps.sandboxes.compareAndSwap(updated, current.version)) {
        return { record: updated, previous: current.state }
      }
      current = await this.#getSandboxRecord(identity, sandboxId)
    }
    throw new DomainError("conflict", "The sandbox changed concurrently")
  }

  async #claimSnapshotTransition(
    identity: Identity,
    snapshotId: SnapshotId,
    allowed: SnapshotState[],
    transition: SnapshotState,
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<SnapshotRecord> {
    let current = await this.#getSnapshotRecord(identity, snapshotId)
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      if (!allowed.includes(current.state)) throw invalidState(transition, current.state)
      signal.throwIfAborted()
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

  /**
   * A native snapshot may itself stop or fail its already-running source. This
   * narrow path is deliberately separate from ordinary lifecycle transitions:
   * it accepts only exact terminal/live consequences returned with a persisted
   * snapshot observation, and uses the same bounded CAS recovery discipline.
   */
  async #applySnapshotSourceObservation(
    original: SandboxRecord,
    observation: { state: SandboxState; providerRef: JsonValue },
  ): Promise<SandboxRecord> {
    if (observation.providerRef === null || !["running", "stopped", "failed", "terminated"].includes(observation.state)) {
      throw new DomainError("provider_failure", "The provider returned an invalid snapshot source state")
    }
    let current = original
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      // A concurrent lifecycle winner is authoritative; never overwrite it.
      if (current.state !== "running") return current
      const updated: SandboxRecord = { ...current, providerRef: observation.providerRef, state: observation.state, version: current.version + 1, updatedAt: this.#now(), lastError: undefined }
      if (await this.#deps.sandboxes.compareAndSwap(updated, current.version)) return updated
      const next = await this.#deps.sandboxes.get(current.accountId, current.sandboxId)
      if (next === undefined) throw new DomainError("conflict", "The sandbox disappeared")
      current = next
    }
    throw new DomainError("conflict", "The snapshot source changed concurrently")
  }

  async #failSandbox(original: SandboxRecord, transition: SandboxState, error: DomainError): Promise<SandboxRecord> {
    let current = original
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      if (current.state === "failed" && current.lastError !== undefined) return current
      if (current.state !== transition && current.state !== "failed") return current
      const updated: SandboxRecord = {
        ...current,
        providerRef: current.providerRef,
        state: "failed",
        version: current.version + 1,
        updatedAt: this.#now(),
        lastError: errorRecord(error),
      }
      if (await this.#deps.sandboxes.compareAndSwap(updated, current.version)) return updated
      const next = await this.#deps.sandboxes.get(current.accountId, current.sandboxId)
      if (next === undefined) throw new DomainError("conflict", "The sandbox disappeared")
      current = next
    }
    throw new DomainError("conflict", "The sandbox failure changed concurrently")
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

  /**
   * A lifecycle dispatch is never repeated.  We may, however, use one exact
   * read of the known resource to turn an idempotent result into its durable
   * state, or to restore a state after a provider-established pre-dispatch
   * rejection.  An old observation after an ambiguous asynchronous operation
   * deliberately leaves the transition in place.
   */
  async #investigateSandboxLifecycle(
    record: SandboxRecord,
    transition: SandboxState,
    previous: SandboxState,
    successState: SandboxState,
    error: unknown,
    signal: AbortSignal,
  ): Promise<SandboxRecord | undefined> {
    let observation = knownSandboxObservation(error)
    if (observation === undefined) {
      if (!(error instanceof ProviderError)) return undefined
      try {
        observation = await this.#provider(record.provider).inspectSandbox({ accountId: record.accountId, providerRef: record.providerRef, signal })
        signal.throwIfAborted()
      } catch {
        return undefined
      }
    }
    // Authoritative absence satisfies stop's no-running-compute promise and
    // delete's terminal promise, even after an otherwise definite error.
    if (observation.state === "terminated" && (transition === "stopping" || transition === "terminating")) {
      return this.#applySandboxObservation(record, transition, observation)
    }
    if (isDefiniteLifecycleRejection(error)) {
      // A proven pre-dispatch rejection makes the exact provider observation
      // newer than our cached stable checkpoint. Persist any valid stable
      // drift, but do not convert the rejected user operation into success.
      if (isStableSandboxObservation(observation.state)) {
        await this.#replaceSandboxTransitionWithObservation(record, transition, observation)
      }
      return undefined
    }
    // The requested target is idempotent even when it was also our last local
    // checkpoint. Canonical already-state results and conclusive observations
    // after ambiguity reach this path; proven rejections above still surface.
    if (observation.state === successState) {
      return this.#applySandboxObservation(record, transition, observation)
    }
    if (observation.state === previous) return undefined
    if (!isAllowedSandboxObservation(transition, observation.state) && !isStaleSandboxObservation(transition, observation.state)) return undefined
    const applied = await this.#applySandboxObservation(record, transition, observation)
    if (applied.state === successState) return applied
    return undefined
  }

  async #investigateSnapshotLifecycle(
    record: SnapshotRecord,
    transition: SnapshotState,
    previous: SnapshotState,
    error: unknown,
    signal: AbortSignal,
  ): Promise<SnapshotRecord | undefined> {
    let observation = knownSnapshotObservation(error)
    if (observation === undefined) {
      if (!(error instanceof ProviderError)) return undefined
      try {
        observation = await this.#requireSnapshots(this.#provider(record.provider)).inspect({ accountId: record.accountId, snapshotId: record.snapshotId, providerRef: record.providerRef, signal })
        signal.throwIfAborted()
      } catch {
        return undefined
      }
    }
    if (observation.state === previous) {
      if (!isDefiniteLifecycleRejection(error)) return undefined
      // As above, restoration is recovery bookkeeping, not a successful
      // delete response.
      await this.#restoreSnapshotTransition(record, transition, previous)
      return undefined
    }
    if (!isAllowedSnapshotObservation(transition, observation.state) && !isStaleSnapshotObservation(transition, observation.state)) return undefined
    const applied = await this.#applySnapshotObservation(record, transition, observation)
    return applied.state === "deleted" ? applied : undefined
  }

  async #replaceSandboxTransitionWithObservation(
    original: SandboxRecord,
    transition: SandboxState,
    observation: { state: SandboxState; providerRef: JsonValue },
  ): Promise<SandboxRecord> {
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

  async #restoreSnapshotTransition(original: SnapshotRecord, transition: SnapshotState, state: SnapshotState): Promise<SnapshotRecord> {
    let current = original
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      if (current.state !== transition) return current
      const updated = { ...current, state, version: current.version + 1, updatedAt: this.#now(), lastError: undefined }
      if (await this.#deps.snapshots.compareAndSwap(updated, current.version)) return updated
      const next = await this.#deps.snapshots.get(current.accountId, current.snapshotId)
      if (next === undefined) throw new DomainError("conflict", "The snapshot disappeared")
      current = next
    }
    throw new DomainError("conflict", "The snapshot changed concurrently")
  }

  /** Learn a stopped/terminal state after an ordinary operation failure only. */
  async #learnSandboxFromOperationalFailure(record: SandboxRecord, error: unknown, signal: AbortSignal): Promise<void> {
    if (!(error instanceof ProviderError)) return
    const known = knownSandboxObservation(error)
    if (known !== undefined) {
      await this.#learnLiveSandboxObservation(record, known)
      return
    }
    try {
      const observation = await this.#provider(record.provider).inspectSandbox({ accountId: record.accountId, providerRef: record.providerRef, signal })
      signal.throwIfAborted()
      await this.#learnLiveSandboxObservation(record, observation)
    } catch {
      // The operation's original safe provider error is more useful than a
      // failed follow-up inspection, and no state is guessed.
    }
  }

  async #learnLiveSandboxObservation(original: SandboxRecord, observation: ProviderSandboxObservation): Promise<void> {
    let current = original
    for (let attempt = 0; attempt < this.#metadataConflictRetries; attempt++) {
      if (!isAllowedLiveSandboxObservation(current.state, observation.state) || current.state === observation.state) return
      const updated = { ...current, providerRef: observation.providerRef, state: observation.state, version: current.version + 1, updatedAt: this.#now(), lastError: undefined }
      if (await this.#deps.sandboxes.compareAndSwap(updated, current.version)) return
      const next = await this.#deps.sandboxes.get(current.accountId, current.sandboxId)
      if (next === undefined) return
      current = next
    }
  }

  async *#mapToolErrors<T>(events: AsyncIterable<T>, sandbox: SandboxRecord, signal: AbortSignal): AsyncIterable<T> {
    try {
      for await (const event of events) yield event
    } catch (error) {
      if (signal.aborted && !(error instanceof ProviderError && error.kind === "ambiguous_execution")) throw signal.reason
      await this.#learnSandboxFromOperationalFailure(sandbox, error, signal)
      throw mapProviderError(error)
    }
  }

  async #reconcileSandbox(record: SandboxRecord, signal: AbortSignal): Promise<SandboxRecord> {
    if (record.state === "provisioning") {
      if (record.providerRef === null) return record
      signal.throwIfAborted()
      const provider = this.#provider(record.provider)
      let observation
      try {
        observation = await provider.inspectSandbox({ accountId: record.accountId, providerRef: record.providerRef, signal })
        signal.throwIfAborted()
      } catch (error) {
        if (signal.aborted) throw signal.reason
        throw mapProviderError(error)
      }
      return this.#reconcileProvisioning(record, signal, observation)
    }
    if (!isTransitionalSandbox(record.state)) return record
    signal.throwIfAborted()
    const provider = this.#provider(record.provider)
    let observation
    try {
      observation = await provider.inspectSandbox({ accountId: record.accountId, providerRef: record.providerRef, signal })
      signal.throwIfAborted()
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw mapProviderError(error)
    }
    return this.#applySandboxObservation(record, record.state, observation)
  }

  async #reconcileProvisioning(
    record: SandboxRecord,
    signal: AbortSignal,
    observation: { state: SandboxState; providerRef: JsonValue },
  ): Promise<SandboxRecord> {
    if (observation.state === "preparing") {
      throw new DomainError("provider_failure", "The provider returned an invalid sandbox state")
    }
    if (observation.state !== "running") return this.#applySandboxObservation(record, "provisioning", observation)
    const preparing = await this.#checkpointPreparation(record, observation)
    return this.#finishPreparation(preparing, this.#provider(record.provider), signal)
  }

  async #reconcileSnapshot(record: SnapshotRecord, signal: AbortSignal): Promise<SnapshotRecord> {
    if (record.state !== "creating" && record.state !== "deleting") return record
    signal.throwIfAborted()
    const provider = this.#provider(record.provider)
    const snapshots = this.#requireSnapshots(provider)
    let observation
    try {
      observation = await snapshots.inspect({
        accountId: record.accountId,
        snapshotId: record.snapshotId,
        providerRef: record.providerRef,
        signal,
      })
      signal.throwIfAborted()
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw mapProviderError(error)
    }
    if (record.state === "creating" && observation.state !== "creating") {
      const source = await this.#getSandboxRecord({ accountId: record.accountId }, record.sourceSandboxId)
      let sourceObservation
      try {
        sourceObservation = await provider.inspectSandbox({ accountId: source.accountId, providerRef: source.providerRef, signal })
        signal.throwIfAborted()
      } catch (error) {
        if (signal.aborted) throw signal.reason
        throw mapProviderError(error)
      }
      try { await this.#applySnapshotSourceObservation(source, sourceObservation) }
      catch (error) {
        if (error instanceof DomainError && error.code === "conflict") return record
        throw error
      }
    }
    return this.#applySnapshotObservation(record, record.state, observation)
  }

  async #resumeRecord(
    identity: Identity,
    sandboxId: SandboxId,
    signal: AbortSignal,
    forceProviderOperation = false,
  ): Promise<SandboxRecord> {
    const operationKey = `${identity.accountId}\u0000${sandboxId}`
    for (let attempt = 0; attempt < this.#reconciliationAttempts; attempt++) {
      const current = await this.#getSandboxRecord(identity, sandboxId)
      if (current.state === "running" && !forceProviderOperation) return current
      if (current.state === "resuming") {
        const active = this.#resumeOperations.get(operationKey)
        if (active !== undefined) {
          try {
            return await waitForResume(active, signal, true)
          } catch (error) {
            if (signal.aborted && !isAmbiguousExecution(error)) throw signal.reason
            // A cancelled waiter must not turn an adapter-established ambiguous
            // mutation into its own cancellation while attempting a follow-up
            // read. The active operation remains the authoritative outcome.
            if (signal.aborted) throw error
            const latest = await this.#getSandboxRecord(identity, sandboxId)
            if (latest.state !== "resuming") throw error
            const reconciled = await this.#reconcileSandbox(latest, signal)
            if (reconciled.state === "running") return reconciled
            continue
          }
        }
        const reconciled = await this.#reconcileSandbox(current, signal)
        if (reconciled.state === "running") return reconciled
        continue
      }
      if (current.state !== "running" && current.state !== "stopped") throw invalidState("resume", current.state)
      const provider = this.#provider(current.provider)
      const stopResume = this.#requireStopResume(provider)
      const claimed: SandboxRecord = {
        ...current,
        state: "resuming",
        version: current.version + 1,
        updatedAt: this.#now(),
        lastError: undefined,
      }
      signal.throwIfAborted()
      if (!await this.#deps.sandboxes.compareAndSwap(claimed, current.version)) continue
      const operation = this.#finishResume(claimed, stopResume, current.state, signal)
      this.#resumeOperations.set(operationKey, operation)
      const clearOperation = () => {
        if (this.#resumeOperations.get(operationKey) === operation) this.#resumeOperations.delete(operationKey)
      }
      void operation.then(clearOperation, clearOperation)
      return waitForResume(operation, signal, true)
    }
    throw new DomainError("conflict", "The sandbox resume is still in progress")
  }

  async #finishResume(
    record: SandboxRecord,
    stopResume: NonNullable<SandboxProvider["stopResume"]>,
    previous: SandboxState,
    signal: AbortSignal,
  ): Promise<SandboxRecord> {
    try {
      const observation = await stopResume.resume({
        accountId: record.accountId,
        providerRef: record.providerRef,
        signal,
      })
      signal.throwIfAborted()
      return await this.#applySandboxObservation(record, "resuming", observation)
    } catch (error) {
      if (signal.aborted && !isAmbiguousExecution(error)) throw signal.reason
      const recovered = await this.#investigateSandboxLifecycle(record, "resuming", previous, "running", error, signal)
      if (recovered !== undefined) return recovered
      throw mapProviderError(error)
    }
  }

  async #ensureRunning(identity: Identity, sandboxId: SandboxId, signal: AbortSignal): Promise<SandboxRecord> {
    for (let attempt = 0; attempt < this.#reconciliationAttempts; attempt++) {
      const current = await this.#getSandboxRecord(identity, sandboxId)
      if (current.state === "running") return current
      if (current.state === "stopped" || current.state === "resuming") {
        this.#requireStopResume(this.#provider(current.provider))
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
    this.#requireActiveBinding(record)
    return record
  }

  async #getSnapshotRecord(identity: Identity, snapshotId: SnapshotId): Promise<SnapshotRecord> {
    const record = await this.#deps.snapshots.get(identity.accountId, snapshotId)
    if (record === undefined) throw new DomainError("not_found", "Snapshot not found")
    this.#requireActiveBinding(record)
    return record
  }

  #requireActiveBinding(record: Pick<SandboxRecord | SnapshotRecord, "provider" | "providerConfigurationId">): void {
    if (record.provider !== this.#deps.defaultProvider || record.providerConfigurationId !== this.#activeProviderConfigurationId()) {
      throw new DomainError("provider_configuration_mismatch", "The resource belongs to a different provider configuration")
    }
  }

  #activeProviderConfigurationId(): ProviderConfigurationId {
    return this.#deps.providerConfigurationId
  }

  async #getReadySnapshotRecord(
    identity: Identity,
    snapshotId: SnapshotId,
    signal: AbortSignal,
  ): Promise<SnapshotRecord> {
    const existing = await this.#getSnapshotRecord(identity, snapshotId)
    this.#requireSnapshots(this.#provider(existing.provider))
    const record = await this.#reconcileSnapshot(existing, signal)
    if (record.state !== "ready") throw invalidState("create a sandbox from the snapshot", record.state)
    return record
  }

  #provider(name: string): SandboxProvider {
    const provider = this.#deps.providers.get(name)
    if (provider === undefined) throw new DomainError("internal_error", "The resource provider is not configured")
    return provider
  }

  #requireStopResume(provider: SandboxProvider): NonNullable<SandboxProvider["stopResume"]> {
    if (provider.stopResume === undefined) throw new DomainError("unsupported_capability", "The provider does not support stop/resume")
    return provider.stopResume
  }

  #requireSnapshots(provider: SandboxProvider): NonNullable<SandboxProvider["snapshots"]> {
    if (provider.snapshots === undefined) throw new DomainError("unsupported_capability", "The provider does not support snapshots")
    return provider.snapshots
  }

  #requireSecureFileTransfer(provider: SandboxProvider): NonNullable<SandboxProvider["secureFileTransfer"]> {
    if (provider.secureFileTransfer === undefined) throw new DomainError("unsupported_capability", "The provider does not support secure file transfer")
    return provider.secureFileTransfer
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
  return state === "stopping" || state === "resuming" || state === "terminating"
}

function isAllowedSandboxObservation(transition: SandboxState, observed: SandboxState): boolean {
  if (observed === transition || observed === "failed") return true
  if (transition === "provisioning") return observed === "preparing"
  if (transition === "preparing") return observed === "running" || observed === "terminated"
  if (transition === "failed") return observed === "terminated"
  if (transition === "stopping") return observed === "stopped" || observed === "terminated"
  if (transition === "resuming") return observed === "running" || observed === "terminated"
  if (transition === "terminating") return observed === "terminated"
  return false
}

function isStaleSandboxObservation(transition: SandboxState, observed: SandboxState): boolean {
  if (transition === "stopping") return observed === "running"
  if (transition === "resuming") return observed === "stopped"
  if (transition === "terminating") return observed === "running" || observed === "stopped"
  return false
}

function isStableSandboxObservation(state: SandboxState): boolean {
  return state === "running" || state === "stopped" || state === "failed" || state === "terminated"
}

function isAllowedLiveSandboxObservation(current: SandboxState, observed: SandboxState): boolean {
  if (current === "terminated") return observed === "terminated"
  if (current === "running" || current === "stopped" || current === "failed") {
    return observed === "running" || observed === "stopped" || observed === "terminated" || observed === "failed"
  }
  return false
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEquals(value, right[index]!))
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && jsonEquals(left[key]!, right[key]!))
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

function isAmbiguousExecution(error: unknown): boolean {
  return (error instanceof ProviderError && error.kind === "ambiguous_execution")
    || (error instanceof DomainError && error.code === "ambiguous_execution")
}

/**
 * Provider adapters reserve these kinds for responses or local validation
 * that prove the lifecycle mutation was rejected before execution. Transport
 * loss, 5xx responses, and invalid post-dispatch results cross the boundary as
 * ambiguous_execution and must never restore or redispatch the operation.
 */
function isDefiniteLifecycleRejection(error: unknown): boolean {
  return error instanceof ProviderError && (error.kind === "failure" || error.kind === "limit")
}

function knownSandboxObservation(error: unknown): ProviderSandboxObservation | undefined {
  return error instanceof ProviderError && error.knownObservation?.resource === "sandbox"
    ? error.knownObservation.observation
    : undefined
}

function knownSnapshotObservation(error: unknown): ProviderSnapshotObservation | undefined {
  return error instanceof ProviderError && error.knownObservation?.resource === "snapshot"
    ? error.knownObservation.observation
    : undefined
}

function waitForResume<T>(operation: Promise<T>, signal: AbortSignal, preserveAmbiguity = false): Promise<T> {
  if (signal.aborted && !preserveAmbiguity) signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let aborted = signal.aborted
    const onAbort = () => {
      aborted = true
      if (!preserveAmbiguity) reject(signal.reason)
    }
    if (!aborted) signal.addEventListener("abort", onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        if (aborted) reject(signal.reason)
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        if (aborted && !isAmbiguousExecution(error)) reject(signal.reason)
        else reject(error)
      },
    )
  })
}
