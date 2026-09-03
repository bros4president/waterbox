import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { ProviderError, type ProviderSandboxObservation, type SandboxProvider } from "@waterbox/core/provider"
import {
  FULL_LINUX_RUNTIME_PROFILE,
  MAX_COMMAND_OUTPUT_BYTES,
  WaterboxSandboxBackend,
  assertCommandInput,
  assertCommandResult,
  assertCreateInput,
  assertJsonReference,
  assertWriteFileInput,
  type InfrastructureCommandInput,
  type InfrastructureCommandResult,
  type InfrastructureCreateInput,
  type InfrastructureCreateSnapshotInput,
  type InfrastructureInventoryInput,
  type InfrastructureSandboxInput,
  type InfrastructureSandboxObservation,
  type InfrastructureSnapshotInput,
  type InfrastructureSnapshotObservation,
  type InfrastructureWriteFileInput,
  type JsonReference,
  type FullLinuxRuntimeProfile,
  type RuntimeDiagnostic,
  type RuntimePathProvisioner,
  type SandboxRuntimeArtifact,
  type SandboxInfrastructure,
} from "@waterbox/provider-runtime"

export type VercelProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export interface VercelProviderClock { now(): number; sleep(milliseconds: number, signal: AbortSignal): Promise<void> }
export interface VercelProviderConfig {
  apiOrigin: string
  token: string
  teamId: string
  projectId: string
  polling: { intervalMs: number; timeoutMs: number; requestTimeoutMs: number }
  automaticStopMs?: number
}
export interface VercelInfrastructureDependencies { fetch?: VercelProviderFetch; clock: VercelProviderClock; diagnostic?: (event: VercelProviderDiagnostic) => void }
export type VercelProviderDiagnostic = { type: "http"; operation: "read" | "mutation"; status: number } | { type: "command-log-invalid" }
export type VercelCompositionDiagnostic = VercelProviderDiagnostic | RuntimeDiagnostic
export interface VercelProviderDependencies {
  artifact: SandboxRuntimeArtifact
  clock: VercelProviderClock
  fetch?: VercelProviderFetch
  diagnostic?: (event: VercelCompositionDiagnostic) => void
}

/** The audited Vercel image supports the same semantic runtime layout. */
export const VERCEL_RUNTIME_PROFILE: FullLinuxRuntimeProfile = FULL_LINUX_RUNTIME_PROFILE

/**
 * Vercel's command user is root in the audited image, with a sudo fallback
 * retained for equivalent project images. This remains adapter input rather
 * than a provider conditional in the shared runtime.
 */
export const VERCEL_RUNTIME_PATH_PROVISIONER: RuntimePathProvisioner = {
  prepareWorkspace(profile) {
    return [
      "set -eu",
      "uid=$(id -u); gid=$(id -g)",
      "if test \"$uid\" = 0; then install_bin=install; else sudo -n true; install_bin='sudo -n install'; fi",
      `$install_bin -d -m 0755 -o \"$uid\" -g \"$gid\" ${quote(profile.workspacePath)}`,
    ].join("\n")
  },
  provision(profile) {
    return [
      "uid=$(id -u); gid=$(id -g)",
      "if test \"$uid\" = 0; then install_bin=install; else sudo -n true; install_bin='sudo -n install'; fi",
      `$install_bin -d -m 0755 -o \"$uid\" -g \"$gid\" ${quote(profile.workspacePath)}`,
      `$install_bin -d -m 0755 -o \"$uid\" -g \"$gid\" ${quote(profile.persistentPaths.runtimeDirectory)}`,
      `$install_bin -d -m 0700 -o \"$uid\" -g \"$gid\" ${quote(profile.ephemeralPaths.jobsDirectory)}`,
    ].join("\n")
  },
  launch(profile) { return `node ${quote(profile.persistentPaths.cliPath)} \"$@\"` },
}

export class SystemVercelProviderClock implements VercelProviderClock {
  now(): number { return Date.now() }
  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted()
      const timer = setTimeout(done, milliseconds)
      const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")) }
      function done() { signal.removeEventListener("abort", abort); resolve() }
      signal.addEventListener("abort", abort, { once: true })
    })
  }
}

type SandboxRef = { kind: "vercel-sandbox-v1"; name: string; owner: string; account: string; automaticSnapshotId?: string }
type SnapshotRef = { kind: "vercel-snapshot-v1"; id: string; owner: string; sourceName: string }
type NativeSandbox = { name: string; sessionId: string; status: NativeState; owner: string; account: string; currentSnapshotId?: string }
type NativeSnapshot = { id: string; sourceSessionId: string; status: "created" | "deleted" | "failed"; creationMethod?: string; sourceName?: string; owner?: string; account?: string }
type NativeState = "pending" | "snapshotting" | "running" | "stopping" | "stopped" | "failed" | "aborted"

const MAX_RESPONSE_BYTES = 1_048_576
const MAX_LOG_BYTES = MAX_COMMAND_OUTPUT_BYTES * 2 + 65_536
const MAX_PAGES = 100
const OWNER_TAG = "waterbox-owner"
const ACCOUNT_TAG = "waterbox-account"

/** Native REST implementation. Durable references never contain a session id. */
export class VercelSandboxInfrastructure implements SandboxInfrastructure {
  readonly name = "vercel"
  readonly stopResume = { stop: (input: InfrastructureSandboxInput) => this.#stop(input), resume: (input: InfrastructureSandboxInput) => this.#resume(input) }
  readonly snapshots = { create: (input: InfrastructureCreateSnapshotInput) => this.#createSnapshot(input), inspect: (input: InfrastructureSnapshotInput) => this.#inspectSnapshot(input), delete: (input: InfrastructureSnapshotInput) => this.#deleteSnapshot(input) }
  readonly inventory = { listSandboxes: (input: InfrastructureInventoryInput) => this.#listSandboxes(input), listSnapshots: (input: InfrastructureInventoryInput) => this.#listSnapshots(input) }
  readonly #config: Readonly<VercelProviderConfig>
  readonly #fetch: VercelProviderFetch
  readonly #clock: VercelProviderClock
  readonly #diagnostic?: (event: VercelProviderDiagnostic) => void

  constructor(config: VercelProviderConfig, dependencies: VercelInfrastructureDependencies) {
    if (!isConfig(config)) throw new TypeError("Vercel provider configuration is invalid")
    if (!dependencies || !dependencies.clock || typeof dependencies.clock.now !== "function" || typeof dependencies.clock.sleep !== "function" || (dependencies.fetch !== undefined && typeof dependencies.fetch !== "function") || (dependencies.diagnostic !== undefined && typeof dependencies.diagnostic !== "function")) throw new TypeError("Vercel provider dependencies are invalid")
    const now = dependencies.clock.now()
    if (!Number.isFinite(now)) throw new TypeError("Vercel provider dependencies are invalid")
    this.#config = { ...config, apiOrigin: normalizedOrigin(config.apiOrigin), polling: { ...config.polling }, ...(config.automaticStopMs === undefined ? {} : { automaticStopMs: config.automaticStopMs }) }
    this.#fetch = dependencies.fetch ?? fetch
    this.#clock = dependencies.clock
    this.#diagnostic = dependencies.diagnostic
  }

  async create(input: InfrastructureCreateInput): Promise<InfrastructureSandboxObservation> {
    assertCreateInput(input); input.signal.throwIfAborted()
    const owner = digest(`${input.accountId}:${input.sandboxId}:${input.idempotencyKey}`), account = digest(input.accountId), name = sandboxName(input.sandboxId, owner)
    if (input.sourceSnapshotRef !== undefined) snapshotRef(input.sourceSnapshotRef)
    const body = {
      name, projectId: this.#config.projectId, persistent: true,
      tags: { [OWNER_TAG]: owner, [ACCOUNT_TAG]: account },
      ...(this.#config.automaticStopMs === undefined ? {} : { timeout: this.#config.automaticStopMs }),
      ...(input.sourceSnapshotRef === undefined ? {} : { source: { type: "snapshot", snapshotId: snapshotRef(input.sourceSnapshotRef).id } }),
    }
    try {
      const response = await this.#json("POST", "/v4/sandboxes", input.signal, { query: { teamId: this.#config.teamId }, body, mutation: true, statuses: [200, 201, 202] })
      let native: NativeSandbox
      try { native = sandbox(response, name, this.#config.projectId, owner, account) }
      catch { throw ambiguous("Vercel sandbox create outcome is unknown") }
      return observation(native, ref(name, owner, account))
    } catch (error) {
      // The single safe create reconciliation is an exact, non-resuming owned-name lookup.
      if (!isReconciliableCreate(error)) throw error
      try {
        const native = await this.#inspectNamed(name, owner, account, input.signal)
        return observation(native, ref(name, owner, account))
      } catch { throw ambiguous("Vercel sandbox create outcome is unknown") }
    }
  }

  async inspect(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation> {
    input.signal.throwIfAborted(); const value = sandboxRef(input.providerRef), deadline = this.#deadline()
    while (true) {
      let current: NativeSandbox
      try { current = await this.#inspectNamed(value.name, value.owner, value.account, input.signal) }
      catch (error) { if (error instanceof VercelHttpError && error.status === 404) return { state: "terminated", providerRef: value }; throw error }
      // Vercel's automatic shutdown may expose its native stopping and
      // snapshotting phases. They are provider implementation details, not
      // Waterbox lifecycle checkpoints: only an explicit Waterbox mutation
      // owns the durable `stopping` state. Keep polling this exact owned name
      // without resume until Vercel supplies an authoritative stable shape.
      if (!automaticStopTransient(current.status)) return observation(current, value)
      if (this.#now() >= deadline) throw new ProviderError("failure", "Vercel sandbox inspection did not reach a stable state")
      await this.#clock.sleep(this.#config.polling.intervalMs, input.signal)
    }
  }

  async runCommand(input: InfrastructureCommandInput): Promise<InfrastructureCommandResult> {
    assertCommandInput(input); input.signal.throwIfAborted(); const value = sandboxRef(input.providerRef)
    const native = await this.#active(value, input.signal)
    let commandId: string
    try {
      const body = { command: "/bin/sh", args: ["-c", input.script], ...(input.cwd === undefined ? {} : { cwd: input.cwd }), env: input.environment ?? {}, sudo: false, timeout: input.timeoutMs }
      const created = await this.#json("POST", `/v2/sandboxes/sessions/${segment(native.sessionId)}/cmd`, input.signal, { query: { teamId: this.#config.teamId }, body, mutation: true })
      commandId = command(created, native.sessionId).id
    } catch (error) { throw mutationError(error, "Vercel command outcome is unknown") }
    try {
      const terminal = await this.#waitCommand(native.sessionId, commandId, input.timeoutMs, input.signal)
      const logs = await this.#logs(native.sessionId, commandId, input.signal, input.maxStdoutBytes ?? MAX_COMMAND_OUTPUT_BYTES, input.maxStderrBytes ?? MAX_COMMAND_OUTPUT_BYTES)
      const result = { exitCode: terminal.exitCode, stdout: logs.stdout, stderr: logs.stderr, timedOut: false, stdoutTruncated: false, stderrTruncated: false }
      assertCommandResult(result, input)
      return result
    } catch (error) {
      if (input.signal.aborted) await this.#kill(native.sessionId, commandId)
      throw mutationError(error, "Vercel command outcome is unknown")
    }
  }

  async writeFile(input: InfrastructureWriteFileInput): Promise<void> {
    assertWriteFileInput(input); input.signal.throwIfAborted(); const native = await this.#active(sandboxRef(input.providerRef), input.signal)
    try {
      await this.#json("POST", `/v2/sandboxes/sessions/${segment(native.sessionId)}/fs/write`, input.signal, { query: { teamId: this.#config.teamId }, body: gzipTar(input.path, input.contents, input.mode ?? 0o644), binary: true, headers: { "x-cwd": "/" }, mutation: true })
    } catch (error) { throw mutationError(error, "Vercel file write outcome is unknown") }
  }

  async #stop(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation> {
    input.signal.throwIfAborted(); const value = sandboxRef(input.providerRef), native = await this.#active(value, input.signal)
    try {
      const result = await this.#json("POST", `/v2/sandboxes/sessions/${segment(native.sessionId)}/stop`, input.signal, { query: { teamId: this.#config.teamId }, mutation: true })
      const stopped = stopResult(result, native.sessionId)
      const automaticSnapshotId = stopped.snapshot?.id
      if (value.automaticSnapshotId !== undefined && stopped.snapshot !== undefined) {
        const after = await this.#inspectNamed(value.name, value.owner, value.account, input.signal)
        await this.#cleanupSupersededAutomatic(value, after, stopped.snapshot, input.signal)
      }
      return { state: "stopped", providerRef: { kind: value.kind, name: value.name, owner: value.owner, account: value.account, ...(automaticSnapshotId === undefined ? (value.automaticSnapshotId === undefined ? {} : { automaticSnapshotId: value.automaticSnapshotId }) : { automaticSnapshotId }) } }
    } catch (error) { throw mutationError(error, "Vercel stop outcome is unknown") }
  }

  async #resume(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation> {
    input.signal.throwIfAborted(); const value = sandboxRef(input.providerRef)
    let started: NativeSandbox
    try {
      started = await this.#inspectNamed(value.name, value.owner, value.account, input.signal, true, true)
    } catch (error) {
      throw mutationError(error, "Vercel resume outcome is unknown")
    }
    try {
      if (started.status === "running") return observation(started, value)
      const terminal = resumeTerminalError(started, value)
      if (terminal !== undefined) throw terminal
      const ready = await this.#waitResumed(value, input.signal)
      return observation(ready, value)
    } catch (error) {
      throw postDispatchResumeError(error, value)
    }
  }

  async delete(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation> {
    input.signal.throwIfAborted(); const value = sandboxRef(input.providerRef)
    let native: NativeSandbox | undefined
    try { native = await this.#inspectNamed(value.name, value.owner, value.account, input.signal) }
    catch (error) { if (error instanceof VercelHttpError && error.status === 404) return { state: "terminated", providerRef: value }; throw error }
    await this.#cleanupAutomaticSnapshot(native, input.signal)
    try { await this.#json("DELETE", `/v2/sandboxes/${segment(value.name)}`, input.signal, { query: { projectId: this.#config.projectId, teamId: this.#config.teamId, deleteOrphanSnapshots: "false" }, mutation: true, empty: true, statuses: [200] }) }
    catch (error) { if (!(error instanceof VercelHttpError && error.status === 404)) throw mutationError(error, "Vercel delete outcome is unknown") }
    const deadline = this.#deadline()
    while (true) {
      try { await this.#inspectNamed(value.name, value.owner, value.account, input.signal) }
      catch (error) { if (error instanceof VercelHttpError && error.status === 404) return { state: "terminated", providerRef: value }; throw ambiguous("Vercel deletion outcome is unknown") }
      if (this.#now() >= deadline) throw ambiguous("Vercel deletion outcome is unknown")
      await this.#clock.sleep(this.#config.polling.intervalMs, input.signal)
    }
  }

  async #createSnapshot(input: InfrastructureCreateSnapshotInput): Promise<InfrastructureSnapshotObservation> {
    if (input.expectedState !== "running") throw new TypeError("Snapshot source precondition is invalid")
    input.signal.throwIfAborted(); const source = sandboxRef(input.providerRef)
    let native: NativeSandbox
    try { native = await this.#inspectNamed(source.name, source.owner, source.account, input.signal) } catch (error) { throw error }
    if (native.status !== "running") throw new ProviderError("failure", "The snapshot source is not running")
    try {
      const result = await this.#json("POST", `/v3/sandboxes/sessions/${segment(native.sessionId)}/snapshot`, input.signal, { query: { teamId: this.#config.teamId }, body: {}, mutation: true, statuses: [201] })
      const created = manualSnapshot(result, native.sessionId)
      const sourceAfter = await this.#waitSnapshotSource(source, input.signal)
      return { state: snapshotState(created.status), providerRef: snapshotReference(created.id, source.owner, source.name), sourceSandbox: observation(sourceAfter, source) }
    } catch (error) { throw mutationError(error, "Vercel snapshot outcome is unknown") }
  }

  async #inspectSnapshot(input: InfrastructureSnapshotInput): Promise<InfrastructureSnapshotObservation> {
    input.signal.throwIfAborted(); const value = snapshotRef(input.providerRef)
    try { const current = snapshotEnvelope(await this.#json("GET", `/v2/sandboxes/snapshots/${segment(value.id)}`, input.signal, { query: { teamId: this.#config.teamId } })); if (current.id !== value.id) throw new ProviderError("failure", "Vercel snapshot identity mismatch"); return { state: snapshotState(current.status), providerRef: value } }
    catch (error) { if (error instanceof VercelHttpError && error.status === 404) return { state: "deleted", providerRef: value }; throw error }
  }

  async #deleteSnapshot(input: InfrastructureSnapshotInput): Promise<InfrastructureSnapshotObservation> {
    input.signal.throwIfAborted(); const value = snapshotRef(input.providerRef)
    const current = await this.#inspectSnapshot(input)
    if (current.state === "deleted") return current
    try {
      const result = snapshotEnvelope(await this.#json("DELETE", `/v2/sandboxes/snapshots/${segment(value.id)}`, input.signal, { query: { teamId: this.#config.teamId }, mutation: true }))
      if (result.id !== value.id || result.status !== "deleted") throw ambiguous("Vercel snapshot deletion outcome is unknown")
      return { state: "deleted", providerRef: value }
    } catch (error) {
      if (error instanceof VercelHttpError && error.status === 404) return { state: "deleted", providerRef: value }
      // 400/409 may be a tombstone race; exact GET can establish deletion, never replay DELETE.
      if (error instanceof VercelHttpError && (error.status === 400 || error.status === 409)) {
        const current = await this.#inspectSnapshot(input); if (current.state === "deleted") return current
      }
      throw mutationError(error, "Vercel snapshot deletion outcome is unknown")
    }
  }

  async *#listSandboxes(input: InfrastructureInventoryInput): AsyncIterable<InfrastructureSandboxObservation> {
    const account = digest(input.accountId)
    for await (const item of this.#pages("sandboxes", input.signal, input.pageSize)) {
      const native = listSandbox(item)
      if (native.account !== account) continue
      yield { state: state(native.status), providerRef: ref(native.name, native.owner, native.account) }
    }
  }

  async *#listSnapshots(input: InfrastructureInventoryInput): AsyncIterable<InfrastructureSnapshotObservation> {
    const account = digest(input.accountId)
    for await (const item of this.#pages("snapshots", input.signal, input.pageSize)) {
      const native = snapshot(item)
      // Snapshot metadata itself is the durable proof; do not depend on a
      // replaceable/deleted source session or infer ownership from listings.
      if (native.creationMethod !== "manual" || !native.sourceName || !native.owner || native.account !== account) continue
      yield { state: snapshotState(native.status), providerRef: snapshotReference(native.id, native.owner, native.sourceName) }
    }
  }

  async *#pages(kind: "sandboxes" | "snapshots", signal: AbortSignal, pageSize: number): AsyncIterable<unknown> {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError("Inventory page size is invalid")
    let cursor: string | undefined
    for (let count = 0; count < MAX_PAGES; count++) {
      const result = await this.#json("GET", kind === "sandboxes" ? "/v2/sandboxes" : "/v2/sandboxes/snapshots", signal, { query: { project: this.#config.projectId, teamId: this.#config.teamId, limit: String(pageSize), ...(cursor === undefined ? {} : { cursor }) } })
      const parsed = page(result, kind); for (const item of parsed.items) yield item
      if (parsed.next === undefined) return
      if (parsed.next === cursor) throw new ProviderError("failure", "Vercel inventory pagination cycle")
      cursor = parsed.next
    }
    throw new ProviderError("failure", "Vercel inventory pagination limit exceeded")
  }

  async #active(value: SandboxRef, signal: AbortSignal): Promise<NativeSandbox> {
    const native = await this.#inspectNamed(value.name, value.owner, value.account, signal)
    if (native.status !== "running") throw new ProviderError("failure", "Vercel sandbox is not running")
    return native
  }

  async #inspectNamed(name: string, owner: string, account: string, signal: AbortSignal, resume = false, mutation = false): Promise<NativeSandbox> {
    return sandbox(await this.#json("GET", `/v2/sandboxes/${segment(name)}`, signal, { query: { projectId: this.#config.projectId, teamId: this.#config.teamId, resume: String(resume) }, mutation }), name, this.#config.projectId, owner, account)
  }

  async #waitCommand(sessionId: string, commandId: string, timeoutMs: number, signal: AbortSignal): Promise<{ exitCode: number }> {
    const deadline = this.#now() + timeoutMs + this.#config.polling.requestTimeoutMs
    while (true) {
      const remaining = Math.max(1, deadline - this.#now())
      let result: { id: string; exitCode: number | null }
      try { result = command(await this.#json("GET", `/v2/sandboxes/sessions/${segment(sessionId)}/cmd/${segment(commandId)}`, signal, { query: { teamId: this.#config.teamId, wait: "true" }, requestTimeoutMs: remaining }), sessionId) }
      catch (error) { if (!signal.aborted) await this.#kill(sessionId, commandId); throw error }
      if (result.id !== commandId) throw new Error("command identity mismatch")
      if (result.exitCode !== null) return { exitCode: result.exitCode }
      if (this.#now() >= deadline) { await this.#kill(sessionId, commandId); throw new Error("command polling timed out") }
      await this.#clock.sleep(this.#config.polling.intervalMs, signal)
    }
  }

  async #waitSnapshotSource(value: SandboxRef, signal: AbortSignal): Promise<NativeSandbox> {
    const deadline = this.#deadline()
    while (true) {
      const current = await this.#inspectNamed(value.name, value.owner, value.account, signal)
      if (current.status === "running" || current.status === "stopped" || current.status === "failed" || current.status === "aborted") return current
      if (this.#now() >= deadline) throw ambiguous("Vercel snapshot source state is unknown")
      await this.#clock.sleep(this.#config.polling.intervalMs, signal)
    }
  }

  async #waitResumed(value: SandboxRef, signal: AbortSignal): Promise<NativeSandbox> {
    const deadline = this.#deadline()
    while (true) {
      const current = await this.#inspectNamed(value.name, value.owner, value.account, signal)
      if (current.status === "running") return current
      const terminal = resumeTerminalError(current, value)
      if (terminal !== undefined) throw terminal
      if (this.#now() >= deadline) throw ambiguous("Vercel resume outcome is unknown")
      await this.#clock.sleep(this.#config.polling.intervalMs, signal)
    }
  }

  async #logs(sessionId: string, commandId: string, signal: AbortSignal, stdoutLimit: number, stderrLimit: number): Promise<{ stdout: Uint8Array; stderr: Uint8Array }> {
    let response: Response
    try { response = await this.#request("GET", `/v2/sandboxes/sessions/${segment(sessionId)}/cmd/${segment(commandId)}/logs`, signal, { query: { teamId: this.#config.teamId } }) }
    catch (error) { throw error }
    if (!response.ok) { this.#emit({ type: "http", operation: "read", status: response.status }); await cancel(response); throw new VercelHttpError(response.status) }
    // Command logs are an exact v2 read contract. A ranged/partial (206) or
    // any other success cannot prove that the bounded terminal output is the
    // complete command transcript, so the already-dispatched command remains
    // ambiguous rather than being reported as a definite HTTP rejection.
    if (response.status !== 200) { this.#emit({ type: "http", operation: "read", status: response.status }); await cancel(response); throw new Error("unexpected command log status") }
    if (media(response) !== "application/x-ndjson") { await cancel(response); this.#emit({ type: "command-log-invalid" }); throw new Error("invalid command logs") }
    // NDJSON framing is bounded separately from decoded stream bytes; a tiny
    // caller output limit must not make one valid framed event unreadable.
    const text = await boundedText(response, Math.min(MAX_LOG_BYTES, stdoutLimit + stderrLimit + 65_536), signal)
    const encoder = new TextEncoder(); const stdout: Uint8Array[] = [], stderr: Uint8Array[] = []; let stdoutSize = 0, stderrSize = 0
    for (const line of text.split("\n")) {
      if (!line) continue
      let item: unknown; try { item = JSON.parse(line) } catch { this.#emit({ type: "command-log-invalid" }); throw new Error("invalid command logs") }
      if (!record(item) || !["stdout", "stderr"].includes(item.stream) || typeof item.data !== "string") { this.#emit({ type: "command-log-invalid" }); throw new Error("invalid command logs") }
      const bytes = encoder.encode(item.data)
      if (item.stream === "stdout") { if ((stdoutSize += bytes.byteLength) > stdoutLimit) throw new Error("stdout limit exceeded"); stdout.push(bytes) } else { if ((stderrSize += bytes.byteLength) > stderrLimit) throw new Error("stderr limit exceeded"); stderr.push(bytes) }
    }
    return { stdout: join(stdout, stdoutSize), stderr: join(stderr, stderrSize) }
  }

  async #kill(sessionId: string, commandId: string): Promise<void> {
    // Cancellation is best-effort and never changes the original command's
    // ambiguous outcome. Use a fresh bounded signal because the caller's is
    // already aborted.
    try { await this.#json("POST", `/v2/sandboxes/sessions/${segment(sessionId)}/cmd/${segment(commandId)}/kill`, new AbortController().signal, { query: { teamId: this.#config.teamId }, body: { signal: 15 }, mutation: true }) } catch {}
  }

  async #cleanupAutomaticSnapshot(native: NativeSandbox, signal: AbortSignal): Promise<void> {
    const automaticSnapshotId = native.currentSnapshotId
    if (!automaticSnapshotId) return
    let current: NativeSnapshot
    try { current = snapshotEnvelope(await this.#json("GET", `/v2/sandboxes/snapshots/${segment(automaticSnapshotId)}`, signal, { query: { teamId: this.#config.teamId } })) }
    catch (error) { if (error instanceof VercelHttpError && error.status === 404) return; throw error }
    // The live snapshot resource has no copied name/tags. Exact ownership is
    // instead proved by the exact owned named-sandbox read and its current
    // snapshot link, plus the snapshot's explicit automatic creation method.
    // Never infer this from inventory or from the stored reference alone.
    if (current.status === "deleted" || current.creationMethod !== "automatic" || native.currentSnapshotId !== current.id) return
    try {
      const deleted = snapshotEnvelope(await this.#json("DELETE", `/v2/sandboxes/snapshots/${segment(current.id)}`, signal, { query: { teamId: this.#config.teamId }, mutation: true }))
      if (deleted.id !== current.id || deleted.status !== "deleted") throw ambiguous("Vercel automatic snapshot cleanup outcome is unknown")
    } catch (error) {
      if (error instanceof VercelHttpError && error.status === 404) return
      if (error instanceof VercelHttpError && (error.status === 400 || error.status === 409)) return this.#confirmDeletedAutomatic(current.id, signal)
      throw mutationError(error, "Vercel automatic snapshot cleanup outcome is unknown")
    }
  }

  async #cleanupSupersededAutomatic(previous: SandboxRef, after: NativeSandbox, current: NativeSnapshot, signal: AbortSignal): Promise<void> {
    if (!previous.automaticSnapshotId || after.currentSnapshotId !== current.id || current.id === previous.automaticSnapshotId) throw ambiguous("Vercel automatic snapshot cleanup outcome is unknown")
    let old: NativeSnapshot
    try { old = snapshotEnvelope(await this.#json("GET", `/v2/sandboxes/snapshots/${segment(previous.automaticSnapshotId)}`, signal, { query: { teamId: this.#config.teamId } })) }
    catch (error) { if (error instanceof VercelHttpError && error.status === 404) return; throw ambiguous("Vercel automatic snapshot cleanup outcome is unknown") }
    if (old.id !== previous.automaticSnapshotId || old.status === "deleted") return
    // The previous ID was persisted only from this same owned sandbox's
    // acknowledged stop response. Vercel snapshot reads omit copied sandbox
    // tags/names, so the automatic method plus that tracked stop result is
    // the strongest exact provider evidence available for supersession.
    if (old.creationMethod !== "automatic") throw ambiguous("Vercel automatic snapshot cleanup outcome is unknown")
    try {
      const deleted = snapshotEnvelope(await this.#json("DELETE", `/v2/sandboxes/snapshots/${segment(old.id)}`, signal, { query: { teamId: this.#config.teamId }, mutation: true }))
      if (deleted.id !== old.id || deleted.status !== "deleted") throw ambiguous("Vercel automatic snapshot cleanup outcome is unknown")
    } catch (error) {
      if (error instanceof VercelHttpError && error.status === 404) return
      if (error instanceof VercelHttpError && (error.status === 400 || error.status === 409)) return this.#confirmDeletedAutomatic(old.id, signal)
      throw mutationError(error, "Vercel automatic snapshot cleanup outcome is unknown")
    }
  }

  async #confirmDeletedAutomatic(id: string, signal: AbortSignal): Promise<void> {
    try {
      const current = snapshotEnvelope(await this.#json("GET", `/v2/sandboxes/snapshots/${segment(id)}`, signal, { query: { teamId: this.#config.teamId } }))
      if (current.id === id && current.status === "deleted") return
    } catch (error) { if (error instanceof VercelHttpError && error.status === 404) return; throw ambiguous("Vercel automatic snapshot cleanup outcome is unknown") }
    throw ambiguous("Vercel automatic snapshot cleanup outcome is unknown")
  }

  async #json(method: string, path: string, signal: AbortSignal, options: { query?: Record<string, string>; body?: unknown; binary?: boolean; empty?: boolean; headers?: Record<string, string>; mutation?: boolean; statuses?: readonly number[]; requestTimeoutMs?: number } = {}): Promise<unknown> {
    let response: Response
    try { response = await this.#request(method, path, signal, options) }
    catch (error) { if (options.mutation) throw ambiguous("Vercel mutation outcome is unknown", true); if (signal.aborted) throw signal.reason ?? error; throw new ProviderError("failure", "Vercel request failed") }
    if (!response.ok) {
      this.#emit({ type: "http", operation: options.mutation ? "mutation" : "read", status: response.status }); await cancel(response)
      if (options.mutation && response.status >= 500) throw ambiguous("Vercel mutation outcome is unknown")
      if (response.status === 429) throw new ProviderError("limit", "Vercel provider limit reached")
      throw new VercelHttpError(response.status)
    }
    const acceptedStatuses = options.statuses ?? [200]
    if (!acceptedStatuses.includes(response.status)) { await cancel(response); if (options.mutation) throw ambiguous("Vercel mutation outcome is unknown"); throw new ProviderError("failure", "Vercel returned an unexpected status") }
    if (options.binary || options.empty) { await cancel(response); return undefined }
    if (media(response) !== "application/json") { await cancel(response); if (options.mutation) throw ambiguous("Vercel mutation outcome is unknown"); throw new ProviderError("failure", "Vercel returned an invalid response") }
    try { return JSON.parse(await boundedText(response, MAX_RESPONSE_BYTES, signal)) }
    catch (error) { if (options.mutation) throw ambiguous("Vercel mutation outcome is unknown"); if (signal.aborted) throw signal.reason ?? error; throw new ProviderError("failure", "Vercel returned an invalid response") }
  }

  #request(method: string, path: string, signal: AbortSignal, options: { query?: Record<string, string>; body?: unknown; binary?: boolean; headers?: Record<string, string>; requestTimeoutMs?: number } = {}): Promise<Response> {
    const url = new URL(path, this.#config.apiOrigin)
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
    return this.#fetch(url, { method, headers: { authorization: `Bearer ${this.#config.token}`, accept: "application/json", "content-type": options.binary ? "application/gzip" : "application/json", ...(options.headers ?? {}) }, ...(options.body === undefined ? {} : { body: (options.binary ? options.body : JSON.stringify(options.body)) as BodyInit }), signal: AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs ?? this.#config.polling.requestTimeoutMs)]) })
  }
  #deadline(): number { return this.#now() + this.#config.polling.timeoutMs }
  #now(): number { const value = this.#clock.now(); if (!Number.isFinite(value)) throw new ProviderError("failure", "Vercel provider clock is invalid"); return value }
  #emit(event: VercelProviderDiagnostic): void { try { this.#diagnostic?.(event) } catch {} }
}

/** Thin provider façade: every Waterbox product operation is shared runtime code. */
export class VercelSandboxProvider implements SandboxProvider {
  readonly #backend: WaterboxSandboxBackend
  readonly name: string
  readonly stopResume: SandboxProvider["stopResume"]
  readonly snapshots: SandboxProvider["snapshots"]
  readonly secureFileTransfer: NonNullable<SandboxProvider["secureFileTransfer"]>
  readonly bashJobs: NonNullable<SandboxProvider["bashJobs"]>

  constructor(config: VercelProviderConfig, dependencies: VercelProviderDependencies) {
    if (!record(dependencies) || !Object.hasOwn(dependencies, "clock") || !Object.hasOwn(dependencies, "artifact") || !Object.keys(dependencies).every(key => ["clock", "artifact", "fetch", "diagnostic"].includes(key))) throw new TypeError("Vercel provider dependencies are invalid")
    const infrastructure = new VercelSandboxInfrastructure(config, {
      clock: dependencies.clock,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      ...(dependencies.diagnostic === undefined ? {} : { diagnostic: event => dependencies.diagnostic!(event) }),
    })
    try {
      this.#backend = new WaterboxSandboxBackend(infrastructure, {
        artifact: dependencies.artifact,
        runtimeProfile: VERCEL_RUNTIME_PROFILE,
        pathProvisioner: VERCEL_RUNTIME_PATH_PROVISIONER,
        ...(dependencies.diagnostic === undefined ? {} : { diagnostic: event => dependencies.diagnostic!(event) }),
      })
    } catch (error) {
      if (error instanceof TypeError) throw new TypeError("Vercel runtime artifact is invalid")
      throw error
    }
    this.name = this.#backend.name
    this.stopResume = this.#backend.stopResume
    this.snapshots = this.#backend.snapshots
    this.secureFileTransfer = this.#backend.secureFileTransfer
    this.bashJobs = this.#backend.bashJobs
  }

  createSandbox: SandboxProvider["createSandbox"] = input => this.#backend.createSandbox(input)
  prepareSandbox: SandboxProvider["prepareSandbox"] = input => this.#backend.prepareSandbox(input)
  inspectSandbox: SandboxProvider["inspectSandbox"] = input => this.#backend.inspectSandbox(input)
  deleteSandbox: SandboxProvider["deleteSandbox"] = input => this.#backend.deleteSandbox(input)
  executeTool: SandboxProvider["executeTool"] = input => this.#backend.executeTool(input as never)
}

class VercelHttpError extends ProviderError { constructor(readonly status: number) { super("failure", `Vercel request failed (${status})`) } }
class VercelAmbiguousError extends ProviderError { constructor(message: string, readonly createReconciliationAllowed = false) { super("ambiguous_execution", message) } }
function isConfig(value: unknown): value is VercelProviderConfig { return record(value) && exactSome(value, ["apiOrigin", "token", "teamId", "projectId", "polling"], ["automaticStopMs"]) && strings(value.apiOrigin, value.token, value.teamId, value.projectId) && record(value.polling) && exact(value.polling, ["intervalMs", "timeoutMs", "requestTimeoutMs"]) && Number.isSafeInteger(value.polling.intervalMs) && value.polling.intervalMs > 0 && Number.isSafeInteger(value.polling.timeoutMs) && value.polling.timeoutMs >= value.polling.intervalMs && Number.isSafeInteger(value.polling.requestTimeoutMs) && value.polling.requestTimeoutMs > 0 && value.polling.requestTimeoutMs <= value.polling.timeoutMs && (value.automaticStopMs === undefined || automaticStopMilliseconds(value.automaticStopMs)) }
function exact(value: Record<string, unknown>, required: readonly string[]): boolean { const keys = Object.keys(value); return keys.length === required.length && required.every(key => Object.hasOwn(value, key)) }
function automaticStopMilliseconds(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value % 60_000 === 0 }
function strings(...values: unknown[]): boolean { return values.every(value => typeof value === "string" && value.length > 0 && value === value.trim()) }
function normalizedOrigin(value: string): string { const url = new URL(value); if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new TypeError("Vercel provider configuration is invalid"); return url.toString().replace(/\/$/, "") }
function ref(name: string, owner: string, account: string): SandboxRef { return { kind: "vercel-sandbox-v1", name, owner, account } }
function sandboxRef(value: JsonReference): SandboxRef { assertJsonReference(value); if (!isRecord(value) || value.kind !== "vercel-sandbox-v1" || !strings(value.name, value.owner, value.account) || (value.automaticSnapshotId !== undefined && !strings(value.automaticSnapshotId)) || !exactSome(value, ["kind", "name", "owner", "account"], ["automaticSnapshotId"])) throw new TypeError("Vercel sandbox reference is invalid"); return value as SandboxRef }
function snapshotReference(id: string, owner: string, sourceName: string): SnapshotRef { return { kind: "vercel-snapshot-v1", id, owner, sourceName } }
function snapshotRef(value: JsonReference): SnapshotRef { assertJsonReference(value); if (!isRecord(value) || value.kind !== "vercel-snapshot-v1" || !strings(value.id, value.owner, value.sourceName) || !exact(value, ["kind", "id", "owner", "sourceName"])) throw new TypeError("Vercel snapshot reference is invalid"); return value as SnapshotRef }
function exactSome(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean { const keys = Object.keys(value); return required.every(key => Object.hasOwn(value, key)) && keys.every(key => required.includes(key) || optional.includes(key)) }
function state(value: NativeState): InfrastructureSandboxObservation["state"] { return value === "pending" ? "provisioning" : value === "running" ? "running" : value === "stopped" ? "stopped" : value === "stopping" || value === "snapshotting" ? "stopping" : "failed" }
function snapshotState(value: NativeSnapshot["status"]): InfrastructureSnapshotObservation["state"] { return value === "created" ? "ready" : value === "deleted" ? "deleted" : "failed" }
function observation(native: NativeSandbox, providerRef: SandboxRef): InfrastructureSandboxObservation { return { state: state(native.status), providerRef } }
function coreObservation(native: NativeSandbox, providerRef: SandboxRef): ProviderSandboxObservation { return { state: state(native.status), providerRef } }
function resumeTerminalError(native: NativeSandbox, providerRef: SandboxRef): ProviderError | undefined {
  if (native.status === "failed" || native.status === "aborted") return new ProviderError("known_state", "Vercel sandbox could not resume", { knownObservation: { resource: "sandbox", observation: coreObservation(native, providerRef) } })
  if (native.status === "stopped") return new ProviderError("ambiguous_execution", "Vercel resume outcome is unknown", { knownObservation: { resource: "sandbox", observation: coreObservation(native, providerRef) } })
  return undefined
}
function sandbox(value: unknown, name: string, projectId: string, owner: string, account: string): NativeSandbox { const root = record(value) && record(value.sandbox) && record(value.session) ? value : undefined; if (!root || root.sandbox.name !== name || root.sandbox.currentSessionId !== root.session.id || root.session.projectId !== projectId || !strings(root.session.id) || !nativeState(root.sandbox.status) || !record(root.sandbox.tags) || root.sandbox.tags[OWNER_TAG] !== owner || root.sandbox.tags[ACCOUNT_TAG] !== account || (root.sandbox.currentSnapshotId !== undefined && !strings(root.sandbox.currentSnapshotId))) throw new ProviderError("failure", "Vercel returned an invalid sandbox response"); return { name, sessionId: root.session.id as string, status: root.sandbox.status, owner, account, ...(root.sandbox.currentSnapshotId === undefined ? {} : { currentSnapshotId: root.sandbox.currentSnapshotId as string }) } }
function listSandbox(value: unknown): NativeSandbox { if (!record(value) || !strings(value.name, value.currentSessionId) || !nativeState(value.status) || !record(value.tags) || !strings(value.tags[OWNER_TAG], value.tags[ACCOUNT_TAG])) throw new ProviderError("failure", "Vercel returned an invalid inventory sandbox"); return { name: value.name as string, sessionId: value.currentSessionId as string, status: value.status, owner: value.tags[OWNER_TAG] as string, account: value.tags[ACCOUNT_TAG] as string } }
function nativeState(value: unknown): value is NativeState { return value === "pending" || value === "snapshotting" || value === "running" || value === "stopping" || value === "stopped" || value === "failed" || value === "aborted" }
function automaticStopTransient(value: NativeState): boolean { return value === "stopping" || value === "snapshotting" }
function command(value: unknown, sessionId: string): { id: string; exitCode: number | null } { if (!record(value) || !record(value.command) || !strings(value.command.id) || value.command.sessionId !== sessionId || (value.command.exitCode !== null && (!Number.isSafeInteger(value.command.exitCode) || (value.command.exitCode as number) < 0))) throw new Error("invalid command response"); return { id: value.command.id as string, exitCode: value.command.exitCode as number | null } }
function stopResult(value: unknown, sessionId: string): { snapshot?: NativeSnapshot } { if (!record(value) || !record(value.session) || value.session.id !== sessionId || value.session.status !== "stopped") throw new Error("invalid stop response"); return record(value.snapshot) ? { snapshot: snapshot(value.snapshot, sessionId) } : {} }
function manualSnapshot(value: unknown, sessionId: string): NativeSnapshot { if (!record(value) || !record(value.session) || value.session.id !== sessionId || !nativeState(value.session.status) || !record(value.snapshot)) throw new Error("invalid snapshot response"); return snapshot(value.snapshot, sessionId) }
function snapshotEnvelope(value: unknown): NativeSnapshot { return snapshot(record(value) && record(value.snapshot) ? value.snapshot : value) }
function snapshot(value: unknown, sourceSession?: string): NativeSnapshot { if (!record(value) || !strings(value.id, value.sourceSessionId) || (value.status !== "created" && value.status !== "deleted" && value.status !== "failed") || (sourceSession !== undefined && value.sourceSessionId !== sourceSession)) throw new ProviderError("failure", "Vercel returned an invalid snapshot response"); const creationMethod = typeof value.creationMethod === "string" ? value.creationMethod : typeof value.type === "string" ? value.type : undefined; return { id: value.id as string, sourceSessionId: value.sourceSessionId as string, status: value.status, ...(creationMethod === undefined ? {} : { creationMethod }), ...(typeof value.sourceSandboxName === "string" ? { sourceName: value.sourceSandboxName } : {}), ...(record(value.tags) && typeof value.tags[OWNER_TAG] === "string" ? { owner: value.tags[OWNER_TAG] as string } : {}), ...(record(value.tags) && typeof value.tags[ACCOUNT_TAG] === "string" ? { account: value.tags[ACCOUNT_TAG] as string } : {}) } }
function page(value: unknown, kind: "sandboxes" | "snapshots"): { items: unknown[]; next?: string } { if (!record(value) || !Array.isArray(value[kind]) || !record(value.pagination) || !Number.isSafeInteger(value.pagination.count) || (value.pagination.next !== null && !strings(value.pagination.next))) throw new ProviderError("failure", "Vercel returned invalid pagination"); return { items: value[kind] as unknown[], ...(value.pagination.next === null ? {} : { next: value.pagination.next as string }) } }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function isRecord(value: JsonReference): value is { readonly [key: string]: JsonReference } { return typeof value === "object" && value !== null && !Array.isArray(value) }
function segment(value: string): string { return encodeURIComponent(value) }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24) }
function sandboxName(sandboxId: string, owner: string): string { const clean = sandboxId.replace(/[^a-z0-9-]/g, "-").slice(0, 42); return `waterbox-${clean}-${owner.slice(0, 12)}` }
function isAmbiguous(error: unknown): boolean { return error instanceof ProviderError && error.kind === "ambiguous_execution" }
function isReconciliableCreate(error: unknown): boolean { return error instanceof VercelAmbiguousError && error.createReconciliationAllowed }
function ambiguous(message: string, createReconciliationAllowed = false): ProviderError { return new VercelAmbiguousError(message, createReconciliationAllowed) }
function mutationError(error: unknown, message: string): ProviderError { if (error instanceof ProviderError && (error.kind === "limit" || error instanceof VercelHttpError && error.status < 500)) return error; return ambiguous(message) }
function postDispatchResumeError(error: unknown, value: SandboxRef): ProviderError {
  if (error instanceof ProviderError && error.knownObservation !== undefined) return error
  if (error instanceof VercelHttpError && error.status === 404) return new ProviderError("exact_absence", "Vercel sandbox is absent after accepted resume", { knownObservation: { resource: "sandbox", observation: { state: "terminated", providerRef: value } } })
  return ambiguous("Vercel resume outcome is unknown")
}
function media(response: Response): string { return response.headers.get("content-type")?.split(";", 1)[0] ?? "" }
async function cancel(response: Response): Promise<void> { await response.body?.cancel().catch(() => undefined) }
async function boundedText(response: Response, maximum: number, signal: AbortSignal): Promise<string> { if (!response.body) throw new Error("empty response"); const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0, done = false; try { while (true) { signal.throwIfAborted(); const item = await reader.read(); if (item.done) { done = true; break }; length += item.value.byteLength; if (length > maximum) throw new Error("response too large"); chunks.push(item.value) } } finally { if (!done) await reader.cancel().catch(() => undefined); reader.releaseLock() } return new TextDecoder("utf-8", { fatal: true }).decode(join(chunks, length)) }
function join(chunks: Uint8Array[], length: number): Uint8Array { const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength } return result }
function gzipTar(path: string, contents: Uint8Array, mode: number): Uint8Array { const name = path.slice(1), nameBytes = new TextEncoder().encode(name); if (!path.startsWith("/") || !name || /\\|\/\/|(^|\/)\.{1,2}(\/|$)/.test(name) || nameBytes.byteLength !== name.length || nameBytes.byteLength > 100) throw new TypeError("Trusted file write is invalid"); const header = new Uint8Array(512); header.set(nameBytes); octal(header, 100, 8, mode); octal(header, 108, 8, 0); octal(header, 116, 8, 0); octal(header, 124, 12, contents.byteLength); octal(header, 136, 12, 0); header.fill(32, 148, 156); header[156] = 48; header.set(new TextEncoder().encode("ustar\0"), 257); header.set(new TextEncoder().encode("00"), 263); octal(header, 148, 8, checksum(header)); const padding = (512 - contents.byteLength % 512) % 512, tar = new Uint8Array(512 + contents.byteLength + padding + 1024); tar.set(header); tar.set(contents, 512); return gzipSync(tar) }
function octal(out: Uint8Array, start: number, length: number, value: number): void { out.set(new TextEncoder().encode(value.toString(8).padStart(length - 1, "0") + "\0"), start) }
function checksum(bytes: Uint8Array): number { return bytes.reduce((sum, value) => sum + value, 0) }
function quote(value: string): string { return `'${value.replaceAll("'", "'\"'\"'")}'` }
