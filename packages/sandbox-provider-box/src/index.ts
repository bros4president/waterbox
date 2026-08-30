import {
  BashToolEventSchema, EditToolEventSchema, GlobToolEventSchema, GrepToolEventSchema, PatchToolEventSchema,
  ReadToolEventSchema, WriteToolEventSchema, MAX_SECURE_CIPHERTEXT_BYTES,
  SecureTransferDeliveredSchema, SecureTransferInitiatedSchema,
  type SandboxState, type SnapshotState, type ToolName,
} from "@waterbox/contracts"
import {
  ProviderError, type ProviderCreateSandboxInput, type ProviderCreateSnapshotInput,
  type ProviderConsumeSecureTransferInput, type ProviderExecuteInput, type ProviderOperationInput, type ProviderSandboxObservation,
  type ProviderSnapshotObservation, type ProviderSnapshotOperationInput,
  type SandboxProvider, type ToolEventByName,
} from "@waterbox/core/provider"
import type { JsonValue } from "@waterbox/core/records"
import { CliProtocolError, encodeInvocation, encodeSecureTransferInput } from "@waterbox/cli/protocol"

export interface BoxProviderClock { now(): Date; sleep(milliseconds: number, signal: AbortSignal): Promise<void> }
export interface BoxProviderConfig {
  apiBaseUrl: string; apiKey: string; systemTemplateRef: string
  polling: { intervalMs: number; timeoutMs: number }
}
export type BoxProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type BoxProviderDiagnostic =
  | { type: "tool-command"; tool: ToolName; success: boolean; exitCode: number | null; timedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean; hasStderr: boolean }
  | { type: "tool-event-invalid"; tool: ToolName }
  | { type: "tool-http-error"; status: number }
export interface BoxProviderDependencies { fetch?: BoxProviderFetch; clock: BoxProviderClock; diagnostic?: (event: BoxProviderDiagnostic) => void }

type BoxState = "init" | "provisioning" | "provisioned" | "cloning" | "ready" | "idle" | "running" | "archiving" | "archived" | "error"
interface BoxDto { id: string; state: BoxState }
interface SandboxRef { kind: "box-sandbox-v2"; boxId: string }
interface SnapshotRef { kind: "box-named-snapshot-v2"; name: string }
const BOX_STATES: readonly BoxState[] = ["init", "provisioning", "provisioned", "cloning", "ready", "idle", "running", "archiving", "archived", "error"]
const SNAPSHOT_STATES = ["saving", "ready", "failed"] as const
const READY = new Set<BoxState>(["ready", "idle"])
const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/
const DELETION_ID = /^bdop_[a-f0-9]{32}$/
const MAX_JSON_BYTES = 1_048_576
const MAX_COMMAND_JSON_BYTES = 8_388_608
const EVENT_SCHEMAS = { read: ReadToolEventSchema, write: WriteToolEventSchema, edit: EditToolEventSchema, patch: PatchToolEventSchema, glob: GlobToolEventSchema, grep: GrepToolEventSchema, bash: BashToolEventSchema }
class BoxHttpError extends ProviderError { constructor(readonly status: number) { super("failure", `Box request failed (${status})`) } }

export class SystemBoxProviderClock implements BoxProviderClock {
  now(): Date { return new Date() }
  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted()
      const timer = setTimeout(done, milliseconds)
      function done() { signal.removeEventListener("abort", abort); resolve() }
      function abort() { clearTimeout(timer); reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")) }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}

export class BoxSandboxProvider implements SandboxProvider {
  readonly name = "box"
  readonly stopResume = {
    stop: (input: ProviderOperationInput) => this.#stopSandbox(input),
    resume: (input: ProviderOperationInput) => this.#resumeSandbox(input),
  }
  readonly snapshots = {
    create: (input: ProviderCreateSnapshotInput) => this.#createSnapshot(input),
    inspect: (input: ProviderSnapshotOperationInput) => this.#inspectSnapshot(input),
    delete: (input: ProviderSnapshotOperationInput) => this.#deleteSnapshot(input),
  }
  readonly secureFileTransfer = {
    initiate: (input: ProviderOperationInput) => this.#initiateSecureFileTransfer(input),
    consume: (input: ProviderConsumeSecureTransferInput) => this.#consumeSecureFileTransfer(input),
  }
  readonly #config: Readonly<BoxProviderConfig>
  readonly #fetch: BoxProviderFetch
  readonly #clock: BoxProviderClock
  readonly #diagnostic?: (event: BoxProviderDiagnostic) => void

  constructor(config: BoxProviderConfig, dependencies: BoxProviderDependencies) {
    if (!isExactObject(config, ["apiBaseUrl", "apiKey", "systemTemplateRef", "polling"]) || !isExactObject(config.polling, ["intervalMs", "timeoutMs"])) throw new TypeError("Box provider configuration is invalid")
    const apiBaseUrl = configurationUrl(config.apiBaseUrl)
    if (!strictNonempty(config.apiKey) || !strictNonempty(config.systemTemplateRef)) throw new TypeError("Box provider configuration is invalid")
    if (!Number.isInteger(config.polling.intervalMs) || config.polling.intervalMs <= 0 || !Number.isInteger(config.polling.timeoutMs) || config.polling.timeoutMs < config.polling.intervalMs) throw new TypeError("Box provider configuration is invalid")
    if (!isExactObject(dependencies, ["clock"], ["fetch", "diagnostic"]) || (dependencies.fetch !== undefined && typeof dependencies.fetch !== "function") || (dependencies.diagnostic !== undefined && typeof dependencies.diagnostic !== "function") || !isObject(dependencies.clock) || typeof dependencies.clock.now !== "function" || typeof dependencies.clock.sleep !== "function") throw new TypeError("Box provider dependencies are invalid")
    const now = dependencies.clock.now()
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("Box provider dependencies are invalid")
    this.#config = { apiBaseUrl, apiKey: config.apiKey, systemTemplateRef: config.systemTemplateRef, polling: { ...config.polling } }
    this.#fetch = dependencies.fetch ?? fetch
    this.#clock = dependencies.clock
    this.#diagnostic = dependencies.diagnostic
  }

  async createSandbox(input: ProviderCreateSandboxInput): Promise<ProviderSandboxObservation> {
    validateCreateSandboxInput(input)
    const sourceName = input.sourceSnapshotRef === undefined ? this.#config.systemTemplateRef : snapshotRef(input.sourceSnapshotRef).name
    const created = createdBox(await this.#boxJson("POST", "/boxes", input.signal, { body: { from: sourceName, noEnv: true, env: { WATERBOX_SANDBOX_ID: input.sandboxId } }, idempotencyKey: input.idempotencyKey, expectedStatuses: [202] }))
    const ready = await this.#waitForReady(created, input.signal)
    return { state: mapSandboxState(ready.state), providerRef: { kind: "box-sandbox-v2", boxId: ready.id } }
  }
  async inspectSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    validateOperationInput(input)
    const ref = sandboxRef(input.providerRef)
    try {
      const box = infoBox(await this.#boxJson("GET", `/boxes/${segment(ref.boxId)}`, input.signal, { expectedStatuses: [200] }), ref.boxId)
      return { state: mapSandboxState(box.state), providerRef: ref as unknown as JsonValue }
    } catch (error) {
      if (error instanceof BoxHttpError && error.status === 404) return { state: "terminated", providerRef: ref as unknown as JsonValue }
      throw error
    }
  }
  async #stopSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    validateOperationInput(input)
    const ref = sandboxRef(input.providerRef)
    const box = actionBox(await this.#boxJson("POST", `/boxes/${segment(ref.boxId)}/stop`, input.signal, { expectedStatuses: [202] }), ref.boxId, "box.stopping")
    return { state: mapSandboxState(box.state), providerRef: ref as unknown as JsonValue }
  }
  async #resumeSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    validateOperationInput(input)
    const ref = sandboxRef(input.providerRef)
    const resumed = actionBox(await this.#boxJson("POST", `/boxes/${segment(ref.boxId)}/resume`, input.signal, { expectedStatuses: [202] }), ref.boxId, "box.resuming")
    const ready = await this.#waitForReady(resumed, input.signal)
    return { state: mapSandboxState(ready.state), providerRef: ref as unknown as JsonValue }
  }
  async deleteSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    validateOperationInput(input)
    const ref = sandboxRef(input.providerRef)
    const operation = deletionOperation(await this.#boxJson("DELETE", `/boxes/${segment(ref.boxId)}`, input.signal, { headers: { "x-ascii-confirm-delete": ref.boxId }, expectedStatuses: [202] }), "box.deleting", ref.boxId)
    await this.#waitForDeletion(operation.id, ref.boxId, input.signal)
    return { state: "terminated", providerRef: ref as unknown as JsonValue }
  }
  async #createSnapshot(input: ProviderCreateSnapshotInput): Promise<ProviderSnapshotObservation> {
    validateCreateSnapshotInput(input)
    const ref = sandboxRef(input.sandboxRef)
    const name = await internalSnapshotName(input.accountId, input.snapshotId)
    try {
      const snapshot = namedSnapshot(await this.#boxJson("POST", "/named-snapshots", input.signal, { body: { boxId: ref.boxId, name }, expectedStatuses: [202] }), "snapshot.named.saving", name, ref.boxId)
      return { state: mapSnapshotState(snapshot.status), providerRef: { kind: "box-named-snapshot-v2", name } }
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error
      if (error instanceof ProviderError && error.kind === "limit") throw error
      if (error instanceof BoxHttpError && error.status < 500) throw error
      try {
        const snapshot = namedSnapshot(await this.#boxJson("GET", `/named-snapshots/${segment(name)}`, input.signal, { expectedStatuses: [200] }), "snapshot.named.info", name, ref.boxId)
        return { state: mapSnapshotState(snapshot.status), providerRef: { kind: "box-named-snapshot-v2", name } }
      } catch (lookupError) {
        if (input.signal.aborted) throw input.signal.reason ?? lookupError
        if (lookupError instanceof BoxHttpError && lookupError.status === 404) throw new ProviderError("ambiguous_execution", `Box snapshot save requires manual recovery for ${name}`)
        throw new ProviderError("ambiguous_execution", "Box snapshot save requires manual recovery")
      }
    }
  }
  async #inspectSnapshot(input: ProviderSnapshotOperationInput): Promise<ProviderSnapshotObservation> {
    validateSnapshotOperationInput(input)
    const ref = snapshotRef(input.providerRef)
    const snapshot = namedSnapshot(await this.#boxJson("GET", `/named-snapshots/${segment(ref.name)}`, input.signal, { expectedStatuses: [200] }), "snapshot.named.info", ref.name)
    return { state: mapSnapshotState(snapshot.status), providerRef: ref as unknown as JsonValue }
  }
  async #deleteSnapshot(input: ProviderSnapshotOperationInput): Promise<ProviderSnapshotObservation> {
    validateSnapshotOperationInput(input)
    const ref = snapshotRef(input.providerRef)
    namedSnapshotDeleted(await this.#boxJson("DELETE", `/named-snapshots/${segment(ref.name)}`, input.signal, { expectedStatuses: [200] }), ref.name)
    return { state: "deleted", providerRef: ref as unknown as JsonValue }
  }

  async #initiateSecureFileTransfer(input: ProviderOperationInput) {
    validateOperationInput(input)
    const ref = sandboxRef(input.providerRef)
    const command = commandResponse(await this.#toolCommand(ref.boxId, "/usr/local/bin/waterbox transfer-initiate", input.signal))
    return SecureTransferInitiatedSchema.parse(this.#secureCommandResult(command, false))
  }

  async #consumeSecureFileTransfer(input: ProviderConsumeSecureTransferInput) {
    validateConsumeSecureTransferInput(input)
    const ref = sandboxRef(input.providerRef)
    const ciphertext = Buffer.from(input.ciphertext, "base64")
    if (ciphertext.byteLength > MAX_SECURE_CIPHERTEXT_BYTES || ciphertext.toString("base64") !== input.ciphertext) invalidInput()
    const ciphertextPath = `/tmp/waterbox-transfer-${crypto.randomUUID()}.age`
    const uploaded = await this.#boxJson("PUT", `/boxes/${segment(ref.boxId)}/files`, input.signal, {
      body: { path: ciphertextPath, content: input.ciphertext, encoding: "base64" }, expectedStatuses: [200],
    })
    writtenFile(uploaded, ciphertextPath, ciphertext.byteLength)
    const payload = encodeSecureTransferInput({ transferId: input.transferId, targetPath: input.targetPath, ciphertextPath })
    const command = commandResponse(await this.#toolCommand(ref.boxId, `/usr/local/bin/waterbox transfer-consume ${payload}`, input.signal))
    const delivered = SecureTransferDeliveredSchema.parse(this.#secureCommandResult(command, true))
    if (delivered.transferId !== input.transferId || delivered.targetPath !== input.targetPath) throw ambiguous()
    return delivered
  }

  #secureCommandResult(command: ReturnType<typeof commandResponse>, mutating: boolean): unknown {
    const stderr = meaningfulCommandStderr(command.stderr)
    if (command.timedOut || command.stdoutTruncated || command.stderrTruncated || stderr !== "") throw mutating ? ambiguous() : new ProviderError("failure", "Secure transfer command failed")
    if (!command.success || command.exitCode !== 0) {
      const rejected = cliError(command.stdout)
      if (rejected?.code === "transfer_expired") throw new ProviderError("expired", "Secure transfer expired")
      if (rejected?.code === "transfer_consumed") throw new ProviderError("consumed", "Secure transfer was consumed")
      if (rejected?.status !== undefined && rejected.status < 500) throw new ProviderError("failure", "Secure transfer was rejected")
      throw mutating ? ambiguous() : new ProviderError("failure", "Secure transfer command failed")
    }
    try {
      if (!command.stdout.endsWith("\n") || command.stdout.slice(0, -1).includes("\n")) throw new Error()
      return JSON.parse(command.stdout.slice(0, -1))
    } catch { throw mutating ? ambiguous() : new ProviderError("failure", "Secure transfer command returned an invalid response") }
  }

  async *executeTool<N extends ToolName>(input: ProviderExecuteInput<N>): AsyncIterable<ToolEventByName[N]> {
    validateExecuteInput(input)
    const ref = sandboxRef(input.providerRef)
    let payload: string
    try { payload = encodeInvocation(input.toolName, input.arguments as never) }
    catch (error) { if (error instanceof CliProtocolError) throw new ProviderError("failure", "The tool invocation exceeds the Box command limit"); throw error }
    const raw = await this.#toolCommand(ref.boxId, `/usr/local/bin/waterbox run ${payload}`, input.signal)
    const command = commandResponse(raw)
    const stderr = meaningfulCommandStderr(command.stderr)
    this.#emitDiagnostic({ type: "tool-command", tool: input.toolName, success: command.success, exitCode: command.exitCode, timedOut: command.timedOut, stdoutTruncated: command.stdoutTruncated, stderrTruncated: command.stderrTruncated, hasStderr: stderr !== "" })
    if (command.timedOut || command.stdoutTruncated || command.stderrTruncated || stderr !== "") throw ambiguous()
    if (!command.success || command.exitCode !== 0) {
      const rejected = cliError(command.stdout)
      if (rejected?.status !== undefined && rejected.status < 500) throw new ProviderError("failure", "The sandbox CLI rejected tool execution")
      throw ambiguous()
    }
    try {
      if (!command.stdout.endsWith("\n") || command.stdout.slice(0, -1).includes("\n")) throw new Error()
      yield EVENT_SCHEMAS[input.toolName].parse(JSON.parse(command.stdout.slice(0, -1))) as ToolEventByName[N]
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error
      this.#emitDiagnostic({ type: "tool-event-invalid", tool: input.toolName })
      throw ambiguous()
    }
  }

  async #toolCommand(boxId: string, command: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    let response: Response
    try {
      response = await this.#fetch(`${this.#config.apiBaseUrl}/boxes/${segment(boxId)}/commands`, { method: "POST", headers: { authorization: `Bearer ${this.#config.apiKey}`, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ command, timeoutSeconds: 600 }), signal })
    } catch { throw ambiguous() }
    if (!response.ok) {
      this.#emitDiagnostic({ type: "tool-http-error", status: response.status })
      try { await safeBoxError(response, signal) } catch { throw ambiguous() }
      if (response.status >= 500) throw ambiguous()
      throw new BoxHttpError(response.status)
    }
    try { requireMediaType(response, "application/json"); return await boundedJson(response, signal, MAX_COMMAND_JSON_BYTES) }
    catch { throw ambiguous() }
  }
  #emitDiagnostic(event: BoxProviderDiagnostic): void { try { this.#diagnostic?.(event) } catch {} }
  async #waitForReady(initial: BoxDto, signal: AbortSignal): Promise<BoxDto> {
    let current = initial
    const deadline = this.#clockTime() + this.#config.polling.timeoutMs
    while (!READY.has(current.state)) {
      if (current.state === "error" || current.state === "archived") throw new ProviderError("failure", "Box could not become ready")
      if (this.#clockTime() >= deadline) throw new ProviderError("failure", "Box readiness timed out")
      await this.#clock.sleep(this.#config.polling.intervalMs, signal)
      current = infoBox(await this.#boxJson("GET", `/boxes/${segment(initial.id)}`, signal, { expectedStatuses: [200] }), initial.id)
    }
    return current
  }
  #clockTime(): number { const value = this.#clock.now(); if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ProviderError("failure", "Box provider clock is invalid"); return value.getTime() }
  async #waitForDeletion(operationId: string, targetId: string, signal: AbortSignal): Promise<void> {
    const deadline = this.#clockTime() + this.#config.polling.timeoutMs
    while (true) {
      const operation = deletionOperation(await this.#boxJson("GET", `/deletion-operations/${segment(operationId)}`, signal, { expectedStatuses: [200] }), "deletion.operation", targetId, operationId)
      if (operation.status === "completed") return
      try {
        infoBox(await this.#boxJson("GET", `/boxes/${segment(targetId)}`, signal, { expectedStatuses: [200] }), targetId)
      } catch (error) {
        if (error instanceof BoxHttpError && error.status === 404) return
        throw error
      }
      if (this.#clockTime() >= deadline) throw new ProviderError("failure", "Box deletion timed out")
      await this.#clock.sleep(this.#config.polling.intervalMs, signal)
    }
  }
  async #boxJson(method: string, path: string, signal: AbortSignal, options: { body?: unknown; idempotencyKey?: string; headers?: Record<string, string>; expectedStatuses?: number[] } = {}): Promise<unknown> {
    let response: Response
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${this.#config.apiKey}`, accept: "application/json" }
      if (options.body !== undefined) headers["content-type"] = "application/json"
      if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey
      Object.assign(headers, options.headers)
      response = await this.#fetch(`${this.#config.apiBaseUrl}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal })
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      throw new ProviderError("failure", "Box request failed")
    }
    if (!response.ok) {
      const failure = await safeBoxError(response, signal)
      signal.throwIfAborted()
      if (/(?:snapshot.*quota|quota.*snapshot|snapshot[_-]limit)/i.test(`${failure.code} ${failure.message}`)) throw new ProviderError("limit", "Box named snapshot limit reached")
      throw new BoxHttpError(response.status)
    }
    if (options.expectedStatuses && !options.expectedStatuses.includes(response.status)) { cancelStreamDetached(response.body); throw new ProviderError("failure", "Box returned an unexpected status") }
    if (response.status === 204) return undefined
    try { requireMediaType(response, "application/json"); return await boundedJson(response, signal, MAX_JSON_BYTES) }
    catch (error) { if (signal.aborted) throw signal.reason ?? error; throw new ProviderError("failure", "Box returned an invalid response") }
  }
}

function sandboxRef(value: JsonValue): SandboxRef {
  if (!isExactObject(value, ["kind", "boxId"]) || value.kind !== "box-sandbox-v2" || typeof value.boxId !== "string" || !BOX_ID.test(value.boxId)) throw new ProviderError("failure", "The Box sandbox reference is invalid")
  return { kind: "box-sandbox-v2", boxId: value.boxId }
}
function snapshotRef(value: JsonValue): SnapshotRef {
  if (!isExactObject(value, ["kind", "name"]) || value.kind !== "box-named-snapshot-v2" || !validSnapshotName(value.name)) throw new ProviderError("failure", "The Box snapshot reference is invalid")
  return { kind: "box-named-snapshot-v2", name: value.name }
}
function boxDto(value: unknown): BoxDto {
  if (!isObject(value) || !BOX_ID.test(String(value.id)) || typeof value.state !== "string" || !BOX_STATES.includes(value.state as BoxState)) throw new ProviderError("failure", "Box returned an invalid response")
  return { id: value.id as string, state: value.state as BoxState }
}
function correlatedBox(value: unknown, expectedId: string): BoxDto { const dto = boxDto(value); if (dto.id !== expectedId) throw new ProviderError("failure", "Box returned a mismatched response"); return dto }
function success(value: unknown, type: string): Record<string, unknown> { if (!isObject(value) || value.ok !== true || value.type !== type) throw new ProviderError("failure", "Box returned an invalid response"); return value }
function createdBox(value: unknown): BoxDto { const envelope = success(value, "box.created"); const box = boxDto(envelope.box); if (envelope.status !== "provisioning" && envelope.status !== box.state) throw new ProviderError("failure", "Box returned an invalid response"); return box }
function infoBox(value: unknown, id: string): BoxDto { const envelope = success(value, "box.info"); return correlatedBox(envelope.box, id) }
function actionBox(value: unknown, id: string, type: "box.stopping" | "box.resuming"): BoxDto { const status = type === "box.stopping" ? "archiving" : "resuming"; if (!isObject(value) || value.ok !== true || value.type !== type || value.id !== id || value.status !== status) throw new ProviderError("failure", "Box returned an invalid response"); return value.box == null ? { id, state: type === "box.stopping" ? "archiving" : "provisioning" } : correlatedBox(value.box, id) }
function namedSnapshot(value: unknown, type: "snapshot.named.saving" | "snapshot.named.info", name: string, sourceBoxId?: string): { name: string; status: typeof SNAPSHOT_STATES[number] } { if (!isObject(value) || value.ok !== true || value.type !== type || (type === "snapshot.named.saving" && value.status !== "saving") || !isObject(value.snapshot) || value.snapshot.name !== name || !BOX_ID.test(String(value.snapshot.sourceBoxId)) || (sourceBoxId !== undefined && value.snapshot.sourceBoxId !== sourceBoxId) || !SNAPSHOT_STATES.includes(value.snapshot.status as any) || (value.snapshot.status === "ready" && !strictNonempty(value.snapshot.snapshotId)) || (value.snapshot.snapshotId !== undefined && !strictNonempty(value.snapshot.snapshotId))) throw new ProviderError("failure", "Box returned an invalid response"); return { name, status: value.snapshot.status as any } }
function namedSnapshotDeleted(value: unknown, name: string): void { const envelope = success(value, "snapshot.named.deleted"); if (envelope.name !== name || envelope.status !== "deleted") throw new ProviderError("failure", "Box returned a mismatched response") }
function commandResponse(value: unknown): { success: boolean; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean } { if (!isObject(value) || value.ok !== true || value.type !== "command.finished" || typeof value.success !== "boolean" || !(typeof value.exitCode === "number" || value.exitCode === null) || typeof value.stdout !== "string" || typeof value.stderr !== "string" || typeof value.timedOut !== "boolean" || (value.stdoutTruncated !== undefined && typeof value.stdoutTruncated !== "boolean") || (value.stderrTruncated !== undefined && typeof value.stderrTruncated !== "boolean")) throw ambiguous(); return { success: value.success, exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr, timedOut: value.timedOut, stdoutTruncated: value.stdoutTruncated === true, stderrTruncated: value.stderrTruncated === true } }
function cliError(stdout: string): { status: number; code: string } | undefined { try { const value = JSON.parse(stdout.trim()); return isExactObject(value, ["protocolVersion", "type", "status", "code"]) && value.protocolVersion === 2 && value.type === "error" && Number.isInteger(value.status) && typeof value.code === "string" ? { status: Number(value.status), code: value.code } : undefined } catch { return undefined } }
function deletionOperation(value: unknown, type: "box.deleting" | "deletion.operation", targetId: string, operationId?: string): { id: string; status: "pending" | "processing" | "blocked" | "completed" } { if (!isObject(value) || value.ok !== true || value.type !== type || !isObject(value.operation)) throw new ProviderError("failure", "Box returned an invalid deletion response"); const op = value.operation; if (!DELETION_ID.test(String(op.id)) || (operationId !== undefined && op.id !== operationId) || op.kind !== "box" || op.targetId !== targetId || !["pending", "processing", "blocked", "completed"].includes(String(op.status))) throw new ProviderError("failure", "Box returned a mismatched deletion response"); return { id: op.id as string, status: op.status as any } }
function writtenFile(value: unknown, expectedPath: string, expectedSize: number): void { const envelope = success(value, "file.written"); if (envelope.success !== true || typeof envelope.path !== "string" || resolveBoxPath(envelope.path) !== expectedPath || envelope.encoding !== "base64" || envelope.size !== expectedSize) throw new ProviderError("failure", "Box returned an invalid file upload response") }
function resolveBoxPath(value: string): string { return new URL(value, "file:///home/user/").pathname }
function configurationUrl(value: unknown): string {
  if (!strictNonempty(value)) throw new TypeError("Box provider configuration is invalid")
  try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(); return url.href.replace(/\/+$/, "") }
  catch { throw new TypeError("Box provider configuration is invalid") }
}
function mapSandboxState(state: BoxState): SandboxState { if (READY.has(state) || state === "running") return "running"; if (["init", "provisioning", "provisioned", "cloning"].includes(state)) return "provisioning"; if (state === "archiving") return "stopping"; if (state === "archived") return "stopped"; return "failed" }
function mapSnapshotState(state: typeof SNAPSHOT_STATES[number]): SnapshotState { return state === "saving" ? "creating" : state }
function segment(value: string): string { return encodeURIComponent(value) }
function strictNonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value === value.trim() }
function validSnapshotName(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) && !new Set(["latest", "tree", "pull", "rm", "save", "current", "self", "new"]).has(value) }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function isExactObject(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> { if (!isObject(value)) return false; const allowed = new Set([...required, ...optional]); return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key)) }
function requireMediaType(response: Response, expected: string): void { if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== expected) throw new Error("invalid media type") }
function ambiguous(): ProviderError { return new ProviderError("ambiguous_execution", "Tool execution outcome is unknown") }
function meaningfulCommandStderr(value: string): string {
  return value.replace(/^sh: 0: getcwd\(\) failed: No such file or directory\n?/, "")
}
async function safeBoxError(response: Response, signal: AbortSignal): Promise<{ code: string; message: string }> {
  try { requireMediaType(response, "application/json"); const value = await boundedJson(response, signal, MAX_JSON_BYTES); return isObject(value) && value.ok === false && typeof value.code === "string" && typeof value.message === "string" ? { code: value.code, message: value.message } : isExactObject(value, ["code"], ["message"]) && typeof value.code === "string" && (value.message === undefined || typeof value.message === "string") ? { code: value.code, message: value.message ?? "" } : { code: "", message: "" } }
  catch (error) { if (signal.aborted) throw signal.reason ?? error; return { code: "", message: "" } }
}
async function boundedJson(response: Response, signal: AbortSignal, maximum: number): Promise<unknown> { if (!response.body) throw new Error("missing body"); const bytes = await readBounded(response.body, signal, maximum); return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
async function readBounded(stream: ReadableStream<Uint8Array>, signal: AbortSignal, maximum: number): Promise<Uint8Array> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let total = 0; let completed = false
  try { while (true) { const item = await abortableRead(reader, signal); if (item.done) { completed = true; break }; total += item.value.byteLength; if (total > maximum) throw new Error("response too large"); chunks.push(item.value) } }
  finally { if (!completed) cancelDetached(reader, signal.reason); else reader.releaseLock() }
  const output = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }; return output
}
async function abortableRead(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  signal.throwIfAborted(); let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const abort = () => { cancelDetached(reader, signal.reason); rejectAbort(signal.reason ?? new DOMException("The operation was aborted", "AbortError")) }
  signal.addEventListener("abort", abort, { once: true }); try { return await Promise.race([reader.read(), aborted]) } finally { signal.removeEventListener("abort", abort) }
}
function cancelDetached(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): void { try { void reader.cancel(reason).catch(() => undefined) } catch {} }
function cancelStreamDetached(stream: ReadableStream<Uint8Array> | null): void { if (!stream) return; try { void stream.cancel().catch(() => undefined) } catch {} }

function validateCreateSandboxInput(value: unknown): asserts value is ProviderCreateSandboxInput {
  if (!isObject(value) || !isAbortSignal(value.signal)) invalidInput()
  value.signal.throwIfAborted()
  if (value.sourceSnapshotRef !== undefined) snapshotRef(value.sourceSnapshotRef as JsonValue)
}
function validateOperationInput(value: unknown): asserts value is ProviderOperationInput {
  if (!isObject(value) || !isAbortSignal(value.signal)) invalidInput()
  value.signal.throwIfAborted()
  sandboxRef(value.providerRef as JsonValue)
}
function validateCreateSnapshotInput(value: unknown): asserts value is ProviderCreateSnapshotInput {
  if (!isObject(value) || !isAbortSignal(value.signal)) invalidInput()
  value.signal.throwIfAborted()
  sandboxRef(value.sandboxRef as JsonValue)
}
function validateSnapshotOperationInput(value: unknown): asserts value is ProviderSnapshotOperationInput {
  if (!isObject(value) || !isAbortSignal(value.signal)) invalidInput()
  value.signal.throwIfAborted()
  snapshotRef(value.providerRef as JsonValue)
}
function validateExecuteInput(value: unknown): asserts value is ProviderExecuteInput {
  if (!isObject(value) || !isAbortSignal(value.signal)) invalidInput()
  value.signal.throwIfAborted()
  sandboxRef(value.providerRef as JsonValue)
}
function validateConsumeSecureTransferInput(value: unknown): asserts value is ProviderConsumeSecureTransferInput {
  if (!isObject(value) || !isAbortSignal(value.signal) || typeof value.transferId !== "string" || typeof value.targetPath !== "string" || typeof value.ciphertext !== "string") invalidInput()
  value.signal.throwIfAborted()
  sandboxRef(value.providerRef as JsonValue)
}
function isAbortSignal(value: unknown): value is AbortSignal { return value instanceof AbortSignal && typeof value.throwIfAborted === "function" }
function invalidInput(): never { throw new ProviderError("failure", "The Box provider input is invalid") }
async function internalSnapshotName(accountId: string, snapshotId: string): Promise<string> { const [a, s] = await Promise.all([shortHash(accountId), shortHash(snapshotId)]); return `waterbox-${slug(accountId)}-${a}-${slug(snapshotId)}-${s}` }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 8) || "id" }
async function shortHash(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest).slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("") }
export const __testing = { internalSnapshotName }
