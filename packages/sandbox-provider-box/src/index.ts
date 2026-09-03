import { createHash } from "node:crypto"
import { type SandboxState, type SnapshotState } from "@waterbox/contracts"
import { ProviderError, type SandboxProvider } from "@waterbox/core/provider"
import type { JsonValue } from "@waterbox/core/records"
import {
  WaterboxSandboxBackend,
  assertCommandInput,
  assertCreateInput,
  assertWriteFileInput,
  quotePosixShellWord,
  type InfrastructureCommandInput,
  type InfrastructureCommandResult,
  type InfrastructureCreateInput,
  type InfrastructureCreateSnapshotInput,
  type InfrastructureSandboxInput,
  type InfrastructureSandboxObservation,
  type InfrastructureSnapshotInput,
  type InfrastructureSnapshotObservation,
  type InfrastructureWriteFileInput,
  type RuntimeDiagnostic,
  type FullLinuxRuntimeProfile,
  type RuntimePathProvisioner,
  type SandboxInfrastructure,
  type SandboxRuntimeArtifact,
} from "@waterbox/provider-runtime"

export interface BoxProviderClock { now(): Date; sleep(milliseconds: number, signal: AbortSignal): Promise<void> }
export interface BoxProviderConfig { apiBaseUrl: string; apiKey: string; polling: { intervalMs: number; timeoutMs: number }; automaticStopMs?: number }
export type { SandboxRuntimeArtifact } from "@waterbox/provider-runtime"
export type BoxProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type BoxProviderDiagnostic = RuntimeDiagnostic | { type: "tool-http-error"; status: number }
export interface BoxInfrastructureDependencies { fetch?: BoxProviderFetch; clock: BoxProviderClock; diagnostic?: (event: BoxProviderDiagnostic) => void }
export interface BoxProviderDependencies extends BoxInfrastructureDependencies { artifact: SandboxRuntimeArtifact }

type BoxState = "init" | "provisioning" | "provisioned" | "cloning" | "ready" | "idle" | "running" | "archiving" | "archived" | "error"
type SnapshotStatus = "saving" | "ready" | "failed"
type SandboxRef = { kind: "box-sandbox-v2"; boxId: string }
type SnapshotRef = { kind: "box-named-snapshot-v2"; name: string }
const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/
const DELETION_ID = /^bdop_[a-f0-9]{32}$/
const BOX_STATES = new Set<BoxState>(["init", "provisioning", "provisioned", "cloning", "ready", "idle", "running", "archiving", "archived", "error"])
const READY = new Set<BoxState>(["ready", "idle"])
const MAX_JSON_BYTES = 1_048_576
const MAX_COMMAND_JSON_BYTES = 8_388_608

/** Box snapshots retain /home/user; runtime files stay outside the user workspace. */
export const BOX_RUNTIME_PROFILE: FullLinuxRuntimeProfile = {
  workspacePath: "/home/user/workspace",
  artifactMode: 0o640,
  persistentPaths: {
    runtimeDirectory: "/usr/local/lib",
    cliPath: "/usr/local/lib/waterbox-cli.js",
    launcherPath: "/usr/local/bin/waterbox",
    manifestPath: "/usr/local/lib/waterbox-bootstrap.json",
    workspace: "/home/user/workspace",
  },
  ephemeralPaths: { uploadStagingDirectory: "/tmp", jobsDirectory: "/run/waterbox/bash-jobs" },
  requires: ["node-24", "rg", "absolute-workspace", "persistent-files", "detached-jobs"],
  executableDiscovery: "PATH then adapter-validated absolute executable",
  privilegeStrategy: "adapter-provided non-interactive capability",
}

/** Box's validated non-interactive full-Linux privilege mechanics. */
export const BOX_RUNTIME_PATH_PROVISIONER: RuntimePathProvisioner = {
  provision(profile) {
    return [
      "uid=$(id -u); gid=$(id -g)",
      "sudo -n true",
      `sudo -n install -d -m 0755 -o "$uid" -g "$gid" ${quotePosixShellWord(profile.workspacePath)}`,
      `sudo -n install -d -m 0755 -o "$uid" -g "$gid" ${quotePosixShellWord(profile.persistentPaths.runtimeDirectory)}`,
      "sudo -n install -d -m 0755 -o \"$uid\" -g \"$gid\" '/usr/local/bin'",
      `sudo -n install -d -m 0700 ${quotePosixShellWord(profile.ephemeralPaths.jobsDirectory)}`,
    ].join("\n")
  },
  launch(profile) {
    return `sudo -n env WORKSPACE_ROOT=${quotePosixShellWord(profile.workspacePath)} /usr/local/bin/node ${quotePosixShellWord(profile.persistentPaths.cliPath)} "$@"`
  },
}

class BoxHttpError extends ProviderError { constructor(readonly status: number) { super("failure", `Box request failed (${status})`) } }

export class SystemBoxProviderClock implements BoxProviderClock {
  now(): Date { return new Date() }
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

/** Native Box HTTP mechanics only. */
export class BoxSandboxInfrastructure implements SandboxInfrastructure {
  readonly name = "box"
  readonly stopResume = {
    stop: (input: InfrastructureSandboxInput) => this.#stop(input),
    resume: (input: InfrastructureSandboxInput) => this.#resume(input),
  }
  readonly snapshots = {
    create: (input: InfrastructureCreateSnapshotInput) => this.#createSnapshot(input),
    inspect: (input: InfrastructureSnapshotInput) => this.#inspectSnapshot(input),
    delete: (input: InfrastructureSnapshotInput) => this.#deleteSnapshot(input),
  }
  readonly #config: Readonly<BoxProviderConfig>
  readonly #fetch: BoxProviderFetch
  readonly #clock: BoxProviderClock
  readonly #diagnostic?: (event: BoxProviderDiagnostic) => void

  constructor(config: BoxProviderConfig, dependencies: BoxInfrastructureDependencies) {
    if (!exact(config, ["apiBaseUrl", "apiKey", "polling"], ["automaticStopMs"]) || !exact(config.polling, ["intervalMs", "timeoutMs"]) || !nonempty(config.apiKey) || !Number.isInteger(config.polling.intervalMs) || config.polling.intervalMs < 1 || !Number.isInteger(config.polling.timeoutMs) || config.polling.timeoutMs < config.polling.intervalMs || config.automaticStopMs !== undefined && !automaticStopMilliseconds(config.automaticStopMs)) throw new TypeError("Box provider configuration is invalid")
    if (!exact(dependencies, ["clock"], ["fetch", "diagnostic"]) || !dependencies.clock || typeof dependencies.clock.now !== "function" || typeof dependencies.clock.sleep !== "function" || (dependencies.fetch !== undefined && typeof dependencies.fetch !== "function") || (dependencies.diagnostic !== undefined && typeof dependencies.diagnostic !== "function")) throw new TypeError("Box provider dependencies are invalid")
    const now = dependencies.clock.now()
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("Box provider dependencies are invalid")
    this.#config = { apiBaseUrl: url(config.apiBaseUrl), apiKey: config.apiKey, polling: { ...config.polling }, ...(config.automaticStopMs === undefined ? {} : { automaticStopMs: config.automaticStopMs }) }
    this.#fetch = dependencies.fetch ?? fetch
    this.#clock = dependencies.clock
    this.#diagnostic = dependencies.diagnostic
  }

  async create(input: InfrastructureCreateInput): Promise<InfrastructureSandboxObservation> {
    assertCreateInput(input); input.signal.throwIfAborted()
    const source = input.sourceSnapshotRef === undefined ? {} : { from: snapshotRef(input.sourceSnapshotRef).name }
    const ready = await this.#dispatchedLifecycleMutation(input.signal, async () => this.#waitReady(createdBox(await this.#json("POST", "/boxes", input.signal, { body: { ...source, noEnv: true, env: { WATERBOX_SANDBOX_ID: input.sandboxId }, ...(this.#config.automaticStopMs === undefined ? {} : { ttlSeconds: this.#config.automaticStopMs / 1_000 }) }, idempotencyKey: input.idempotencyKey, statuses: [202], dispatchedMutation: true })), input.signal))
    return observation(mapSandboxState(ready.state), { kind: "box-sandbox-v2", boxId: ready.id })
  }

  async inspect(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation> {
    input.signal.throwIfAborted()
    const ref = sandboxRef(input.providerRef)
    try { return observation(mapSandboxState(infoBox(await this.#json("GET", `/boxes/${segment(ref.boxId)}`, input.signal, { statuses: [200] }), ref.boxId).state), ref) }
    catch (error) { if (error instanceof BoxHttpError && error.status === 404) return observation("terminated", ref); throw error }
  }

  async runCommand(input: InfrastructureCommandInput): Promise<InfrastructureCommandResult> {
    assertCommandInput(input)
    const ref = sandboxRef(input.providerRef)
    const requestSignal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs + this.#config.polling.timeoutMs)])
    let response: Response
    try {
      response = await this.#fetch(`${this.#config.apiBaseUrl}/boxes/${segment(ref.boxId)}/commands`, { method: "POST", headers: this.#headers(true), body: JSON.stringify({ command: input.script, timeoutSeconds: Math.ceil(input.timeoutMs / 1000) }), signal: requestSignal })
    } catch (error) { if (input.signal.aborted) throw input.signal.reason ?? error; throw ambiguous() }
    if (!response.ok) {
      this.#emit({ type: "tool-http-error", status: response.status })
      await safeError(response, requestSignal)
      if (input.signal.aborted) throw input.signal.reason
      if (response.status >= 500) throw ambiguous()
      throw new BoxHttpError(response.status)
    }
    try {
      media(response)
      const result = commandResult(await json(response, requestSignal, MAX_COMMAND_JSON_BYTES))
      const stdout = new TextEncoder().encode(result.stdout)
      const stderr = new TextEncoder().encode(meaningfulStderr(result.stderr))
      if (stdout.byteLength > (input.maxStdoutBytes ?? MAX_JSON_BYTES) || stderr.byteLength > (input.maxStderrBytes ?? MAX_JSON_BYTES)) throw ambiguous()
      return { exitCode: result.exitCode, stdout, stderr, timedOut: result.timedOut, stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated }
    } catch (error) { if (input.signal.aborted) throw input.signal.reason ?? error; if (error instanceof ProviderError) throw error; throw ambiguous() }
  }

  async writeFile(input: InfrastructureWriteFileInput): Promise<void> {
    assertWriteFileInput(input); input.signal.throwIfAborted()
    const ref = sandboxRef(input.providerRef)
    try {
      const value = await this.#json("PUT", `/boxes/${segment(ref.boxId)}/files`, input.signal, { body: { path: input.path, content: Buffer.from(input.contents).toString("base64"), encoding: "base64" }, statuses: [200], dispatchedMutation: true })
      writtenFile(value, input.path, input.contents.byteLength)
    } catch (error) {
      if (error instanceof BoxHttpError) throw error
      throw new ProviderError("ambiguous_execution", "Box file write outcome is unknown")
    }
  }

  async #stop(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation> {
    input.signal.throwIfAborted()
    const ref = sandboxRef(input.providerRef)
    const state = await this.#dispatchedLifecycleMutation(input.signal, async () => actionBox(await this.#json("POST", `/boxes/${segment(ref.boxId)}/stop`, input.signal, { statuses: [202], dispatchedMutation: true }), ref.boxId, "box.stopping"))
    return observation(mapSandboxState(state.state), ref)
  }
  async #resume(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation> {
    input.signal.throwIfAborted()
    const ref = sandboxRef(input.providerRef)
    const state = await this.#dispatchedLifecycleMutation(input.signal, async () => this.#waitReady(actionBox(await this.#json("POST", `/boxes/${segment(ref.boxId)}/resume`, input.signal, { statuses: [202], dispatchedMutation: true }), ref.boxId, "box.resuming"), input.signal))
    return observation(mapSandboxState(state.state), ref)
  }
  async delete(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation> {
    input.signal.throwIfAborted()
    const ref = sandboxRef(input.providerRef)
    let operation: { id: string; status: string }
    try {
      operation = await this.#dispatchedLifecycleMutation(input.signal, async () => deletion(await this.#json("DELETE", `/boxes/${segment(ref.boxId)}`, input.signal, { headers: { "x-ascii-confirm-delete": ref.boxId }, statuses: [202], dispatchedMutation: true }), "box.deleting", ref.boxId))
    } catch (error) { if (error instanceof BoxHttpError && error.status === 404) return observation("terminated", ref); throw error }
    try { await this.#waitDeletion(operation.id, ref.boxId, input.signal) }
    catch (error) { if (error instanceof ProviderError && error.kind === "ambiguous_execution") throw error; throw ambiguousMutation() }
    return observation("terminated", ref)
  }
  async #createSnapshot(input: InfrastructureCreateSnapshotInput): Promise<InfrastructureSnapshotObservation> {
    const sandbox = sandboxRef(input.providerRef)
    const name = snapshotName(input.accountId, input.snapshotId)
    const source = infoBox(await this.#json("GET", `/boxes/${segment(sandbox.boxId)}`, input.signal, { statuses: [200] }), sandbox.boxId)
    if (mapSandboxState(source.state) !== "running") throw new ProviderError("failure", "The snapshot source is not running")
    try {
      const value = namedSnapshot(await this.#json("POST", "/named-snapshots", input.signal, { body: { boxId: sandbox.boxId, name }, statuses: [202], dispatchedMutation: true }), "snapshot.named.saving", name, sandbox.boxId)
      return snapshotObservation(mapSnapshotState(value.status), { kind: "box-named-snapshot-v2", name })
    } catch (error) {
      if (input.signal.aborted) {
        if (error instanceof ProviderError && error.kind === "ambiguous_execution") throw error
        throw input.signal.reason ?? error
      }
      if (error instanceof ProviderError && (error.kind === "limit" || error instanceof BoxHttpError && error.status < 500)) throw error
      try {
        const value = namedSnapshot(await this.#json("GET", `/named-snapshots/${segment(name)}`, input.signal, { statuses: [200] }), "snapshot.named.info", name, sandbox.boxId)
        return snapshotObservation(mapSnapshotState(value.status), { kind: "box-named-snapshot-v2", name })
      } catch { throw new ProviderError("ambiguous_execution", "Box snapshot save requires manual recovery") }
    }
  }
  async #inspectSnapshot(input: InfrastructureSnapshotInput): Promise<InfrastructureSnapshotObservation> {
    const ref = snapshotRef(input.providerRef)
    try {
      const value = namedSnapshot(await this.#json("GET", `/named-snapshots/${segment(ref.name)}`, input.signal, { statuses: [200] }), "snapshot.named.info", ref.name)
      return snapshotObservation(mapSnapshotState(value.status), ref)
    } catch (error) { if (error instanceof BoxHttpError && error.status === 404) return snapshotObservation("deleted", ref); throw error }
  }
  async #deleteSnapshot(input: InfrastructureSnapshotInput): Promise<InfrastructureSnapshotObservation> {
    input.signal.throwIfAborted()
    const ref = snapshotRef(input.providerRef)
    try {
      deletedSnapshot(await this.#json("DELETE", `/named-snapshots/${segment(ref.name)}`, input.signal, { statuses: [200], dispatchedMutation: true }), ref.name)
      return snapshotObservation("deleted", ref)
    } catch (error) { if (error instanceof BoxHttpError && error.status === 404) return snapshotObservation("deleted", ref); throw error }
  }

  async #waitReady(initial: BoxDto, signal: AbortSignal): Promise<BoxDto> {
    let current = initial
    const deadline = this.#now() + this.#config.polling.timeoutMs
    while (!READY.has(current.state)) {
      if (current.state === "error" || current.state === "archived" || this.#now() >= deadline) throw new ProviderError("failure", "Box could not become ready")
      await this.#clock.sleep(this.#config.polling.intervalMs, signal)
      current = infoBox(await this.#json("GET", `/boxes/${segment(initial.id)}`, signal, { statuses: [200] }), initial.id)
    }
    return current
  }
  async #waitDeletion(operationId: string, boxId: string, signal: AbortSignal): Promise<void> {
    const deadline = this.#now() + this.#config.polling.timeoutMs
    while (true) {
      if (deletion(await this.#json("GET", `/deletion-operations/${segment(operationId)}`, signal, { statuses: [200] }), "deletion.operation", boxId, operationId).status === "completed") return
      try { await this.#json("GET", `/boxes/${segment(boxId)}`, signal, { statuses: [200] }) } catch (error) { if (error instanceof BoxHttpError && error.status === 404) return; throw error }
      if (this.#now() >= deadline) throw new ProviderError("failure", "Box deletion timed out")
      await this.#clock.sleep(this.#config.polling.intervalMs, signal)
    }
  }
  #now(): number { const value = this.#clock.now(); if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ProviderError("failure", "Box provider clock is invalid"); return value.getTime() }
  #headers(jsonBody = false): Record<string, string> { return { authorization: `Bearer ${this.#config.apiKey}`, accept: "application/json", ...(jsonBody ? { "content-type": "application/json" } : {}) } }
  async #dispatchedLifecycleMutation<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    try { return await operation() }
    catch (error) {
      if (error instanceof BoxHttpError || error instanceof ProviderError && error.kind !== "failure") throw error
      if (error instanceof ProviderError) throw ambiguousMutation()
      throw ambiguousMutation()
    }
  }
  async #json(method: string, path: string, signal: AbortSignal, options: { body?: unknown; headers?: Record<string, string>; idempotencyKey?: string; statuses?: number[]; dispatchedMutation?: boolean } = {}): Promise<unknown> {
    let response: Response
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#config.polling.timeoutMs)])
    try { response = await this.#fetch(`${this.#config.apiBaseUrl}${path}`, { method, headers: { ...this.#headers(options.body !== undefined), ...(options.idempotencyKey === undefined ? {} : { "idempotency-key": options.idempotencyKey }), ...options.headers }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: requestSignal }) }
    catch (error) {
      if (options.dispatchedMutation) throw ambiguousMutation()
      if (signal.aborted) throw signal.reason ?? error
      throw new ProviderError("failure", "Box request failed")
    }
    if (!response.ok) {
      const failure = await safeError(response, requestSignal)
      if (/(?:snapshot.*quota|quota.*snapshot|snapshot[_-]limit)/i.test(`${failure.code} ${failure.message}`)) throw new ProviderError("limit", "Box named snapshot limit reached")
      if (options.dispatchedMutation && response.status >= 500) throw ambiguousMutation()
      throw new BoxHttpError(response.status)
    }
    if (options.statuses && !options.statuses.includes(response.status)) throw new ProviderError("failure", "Box returned an unexpected status")
    if (response.status === 204) return undefined
    try { media(response); return await json(response, requestSignal, MAX_JSON_BYTES) } catch (error) { if (options.dispatchedMutation) throw ambiguousMutation(); if (signal.aborted) throw signal.reason ?? error; throw new ProviderError("failure", "Box returned an invalid response") }
  }
  #emit(event: BoxProviderDiagnostic): void { try { this.#diagnostic?.(event) } catch {} }
}

/** Existing composition surface; all product runtime behavior is delegated once. */
export class BoxSandboxProvider implements SandboxProvider {
  readonly #backend: WaterboxSandboxBackend
  readonly name: string
  readonly stopResume: SandboxProvider["stopResume"]
  readonly snapshots: SandboxProvider["snapshots"]
  readonly secureFileTransfer: NonNullable<SandboxProvider["secureFileTransfer"]>
  readonly bashJobs: NonNullable<SandboxProvider["bashJobs"]>
  constructor(config: BoxProviderConfig, dependencies: BoxProviderDependencies) {
    if (!exact(dependencies, ["clock", "artifact"], ["fetch", "diagnostic"])) throw new TypeError("Box provider dependencies are invalid")
    const infrastructure = new BoxSandboxInfrastructure(config, { clock: dependencies.clock, ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }), ...(dependencies.diagnostic === undefined ? {} : { diagnostic: dependencies.diagnostic }) })
    try { this.#backend = new WaterboxSandboxBackend(infrastructure, { artifact: dependencies.artifact, runtimeProfile: BOX_RUNTIME_PROFILE, pathProvisioner: BOX_RUNTIME_PATH_PROVISIONER, ...(dependencies.diagnostic === undefined ? {} : { diagnostic: event => dependencies.diagnostic!(event) }) }) }
    catch (error) { if (error instanceof TypeError) throw new TypeError("Box runtime artifact is invalid"); throw error }
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

interface BoxDto { id: string; state: BoxState }
function sandboxRef(value: unknown): SandboxRef { if (!exact(value, ["kind", "boxId"]) || value.kind !== "box-sandbox-v2" || typeof value.boxId !== "string" || !BOX_ID.test(value.boxId)) throw new ProviderError("failure", "The Box sandbox reference is invalid"); return { kind: "box-sandbox-v2", boxId: value.boxId } }
function snapshotRef(value: unknown): SnapshotRef { if (!exact(value, ["kind", "name"]) || value.kind !== "box-named-snapshot-v2" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(value.name))) throw new ProviderError("failure", "The Box snapshot reference is invalid"); return { kind: "box-named-snapshot-v2", name: value.name } }
function box(value: unknown): BoxDto { if (!object(value) || typeof value.id !== "string" || !BOX_ID.test(value.id) || typeof value.state !== "string" || !BOX_STATES.has(value.state as BoxState)) throw new ProviderError("failure", "Box returned an invalid response"); return { id: value.id, state: value.state as BoxState } }
function envelope(value: unknown, type: string): Record<string, unknown> { if (!object(value) || value.ok !== true || value.type !== type) throw new ProviderError("failure", "Box returned an invalid response"); return value }
function createdBox(value: unknown): BoxDto { const result = envelope(value, "box.created"); const resultBox = box(result.box); if (result.status !== "provisioning" && result.status !== resultBox.state) throw new ProviderError("failure", "Box returned an invalid response"); return resultBox }
function infoBox(value: unknown, id: string): BoxDto { const result = box(envelope(value, "box.info").box); if (result.id !== id) throw new ProviderError("failure", "Box returned a mismatched response"); return result }
function actionBox(value: unknown, id: string, type: "box.stopping" | "box.resuming"): BoxDto { const status = type === "box.stopping" ? "archiving" : "resuming"; if (!object(value) || value.ok !== true || value.type !== type || value.id !== id || value.status !== status) throw new ProviderError("failure", "Box returned an invalid response"); return value.box === undefined ? { id, state: type === "box.stopping" ? "archiving" : "provisioning" } : infoBox({ ok: true, type: "box.info", box: value.box }, id) }
function namedSnapshot(value: unknown, type: "snapshot.named.saving" | "snapshot.named.info", name: string, source?: string): { status: SnapshotStatus } { const result = envelope(value, type); if (!object(result.snapshot) || (type === "snapshot.named.saving" && result.status !== "saving") || result.snapshot.name !== name || typeof result.snapshot.sourceBoxId !== "string" || !BOX_ID.test(result.snapshot.sourceBoxId) || typeof result.snapshot.status !== "string" || !["saving", "ready", "failed"].includes(result.snapshot.status) || (result.snapshot.status === "ready" && !nonempty(result.snapshot.snapshotId)) || (result.snapshot.snapshotId !== undefined && !nonempty(result.snapshot.snapshotId)) || (source !== undefined && result.snapshot.sourceBoxId !== source)) throw new ProviderError("failure", "Box returned an invalid response"); return { status: result.snapshot.status as SnapshotStatus } }
function deletedSnapshot(value: unknown, name: string): void { const result = envelope(value, "snapshot.named.deleted"); if (result.name !== name || result.status !== "deleted") throw new ProviderError("failure", "Box returned a mismatched response") }
function deletion(value: unknown, type: string, target: string, expected?: string): { id: string; status: string } { const result = envelope(value, type); if (!object(result.operation) || typeof result.operation.id !== "string" || !DELETION_ID.test(result.operation.id) || result.operation.kind !== "box" || result.operation.targetId !== target || (expected !== undefined && result.operation.id !== expected) || !["pending", "processing", "blocked", "completed"].includes(String(result.operation.status))) throw new ProviderError("failure", "Box returned an invalid deletion response"); return { id: result.operation.id, status: String(result.operation.status) } }
function commandResult(value: unknown): { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean } { if (!object(value) || value.ok !== true || value.type !== "command.finished" || typeof value.success !== "boolean" || (typeof value.exitCode !== "number" && value.exitCode !== null) || (value.success !== (value.exitCode === 0)) || typeof value.stdout !== "string" || typeof value.stderr !== "string" || typeof value.timedOut !== "boolean" || (value.stdoutTruncated !== undefined && typeof value.stdoutTruncated !== "boolean") || (value.stderrTruncated !== undefined && typeof value.stderrTruncated !== "boolean")) throw ambiguous(); return { exitCode: value.exitCode as number | null, stdout: value.stdout, stderr: value.stderr, timedOut: value.timedOut, stdoutTruncated: value.stdoutTruncated === true, stderrTruncated: value.stderrTruncated === true } }
function writtenFile(value: unknown, path: string, size: number): void { const result = envelope(value, "file.written"); if (result.success !== true || typeof result.path !== "string" || new URL(result.path, "file:///home/user/").pathname !== path || result.encoding !== "base64" || result.size !== size) throw new ProviderError("failure", "Box returned an invalid file upload response") }
function observation(state: SandboxState, providerRef: SandboxRef): InfrastructureSandboxObservation { return { state, providerRef } }
function snapshotObservation(state: SnapshotState, providerRef: SnapshotRef): InfrastructureSnapshotObservation { return { state, providerRef } }
function mapSandboxState(state: BoxState): SandboxState { return READY.has(state) || state === "running" ? "running" : ["init", "provisioning", "provisioned", "cloning"].includes(state) ? "provisioning" : state === "archiving" ? "stopping" : state === "archived" ? "stopped" : "failed" }
function mapSnapshotState(state: SnapshotStatus): SnapshotState { return state === "saving" ? "creating" : state }
function ambiguous(): ProviderError { return new ProviderError("ambiguous_execution", "Box command outcome is unknown") }
function ambiguousMutation(): ProviderError { return new ProviderError("ambiguous_execution", "Box mutation outcome is unknown") }
function meaningfulStderr(value: string): string { return value.replace(/^sh: 0: getcwd\(\) failed: No such file or directory\n?/, "") }
function segment(value: string): string { return encodeURIComponent(value) }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value === value.trim() }
function url(value: unknown): string { if (!nonempty(value)) throw new TypeError("Box provider configuration is invalid"); try { const parsed = new URL(value); if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(); return parsed.href.replace(/\/+$/, "") } catch { throw new TypeError("Box provider configuration is invalid") } }
function automaticStopMilliseconds(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value % 60_000 === 0 }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, any> { return object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)) }
function media(response: Response): void { if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("invalid media type") }
async function safeError(response: Response, signal: AbortSignal): Promise<{ code: string; message: string }> { try { media(response); const value = await json(response, signal, MAX_JSON_BYTES); return object(value) && typeof value.code === "string" ? { code: value.code, message: typeof value.message === "string" ? value.message : "" } : { code: "", message: "" } } catch { return { code: "", message: "" } } }
async function json(response: Response, signal: AbortSignal, maximum: number): Promise<unknown> { if (!response.body) throw new Error("missing body"); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0, done = false; try { while (true) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) { done = true; break } length += next.value.byteLength; if (length > maximum) throw new Error("response too large"); chunks.push(next.value) } } finally { if (!done) await reader.cancel().catch(() => undefined); reader.releaseLock() } const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength } return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
function snapshotName(accountId: string, snapshotId: string): string {
  const hint = snapshotId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 12) || "snapshot"
  const digest = createHash("sha256").update(accountId).update("\u0000").update(snapshotId).digest("hex").slice(0, 32)
  return `waterbox-${hint}-${digest}`
}
export { loadSandboxRuntimeArtifact } from "@waterbox/provider-runtime"
