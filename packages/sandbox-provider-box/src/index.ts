import {
  BashToolEventSchema, EditToolEventSchema, GlobToolEventSchema, GrepToolEventSchema, PatchToolEventSchema,
  ReadToolEventSchema, WriteToolEventSchema, MAX_SECURE_CIPHERTEXT_BYTES,
  SecureTransferDeliveredSchema, SecureTransferInitiatedSchema,
  type SandboxState, type SnapshotState, type ToolName, type ToolEventByName, type BashJobObservation,
} from "@waterbox/contracts"
import {
  ProviderError, type ProviderCreateSandboxInput, type ProviderCreateSnapshotInput,
  type ProviderConsumeSecureTransferInput, type ProviderExecuteInput, type ProviderOperationInput, type ProviderSandboxObservation,
  type ProviderSnapshotObservation, type ProviderSnapshotOperationInput,
  type SandboxProvider, type ProviderObserveBashJobInput, type ProviderCleanupBashJobInput,
} from "@waterbox/core/provider"
import type { JsonValue } from "@waterbox/core/records"
import { CliProtocolError, encodeInvocation, encodeSecureTransferInput } from "@waterbox/cli/protocol"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

export interface BoxProviderClock { now(): Date; sleep(milliseconds: number, signal: AbortSignal): Promise<void> }
export interface BoxProviderConfig {
  apiBaseUrl: string; apiKey: string
  polling: { intervalMs: number; timeoutMs: number }
}
export interface SandboxRuntimeArtifact { bytes: Uint8Array; sha256: string; cliProtocolVersion: 2; artifactVersion: string }
export type BoxProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type BoxProviderDiagnostic =
  | { type: "tool-command"; tool: ToolName; success: boolean; exitCode: number | null; timedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean; hasStderr: boolean }
  | { type: "tool-event-invalid"; tool: ToolName }
  | { type: "tool-http-error"; status: number }
  | { type: "preparation"; stage: "verify" | "final-verify"; outcome: "complete" | "incomplete" | "ambiguous" | "failure" }
  | { type: "preparation"; stage: "upload"; outcome: "complete" | "ambiguous" | "failure" }
  | { type: "preparation"; stage: "install"; outcome: "complete" | "ambiguous" | "failure" }
export interface BoxProviderDependencies { fetch?: BoxProviderFetch; clock: BoxProviderClock; artifact: SandboxRuntimeArtifact; diagnostic?: (event: BoxProviderDiagnostic) => void }

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
const BOOTSTRAP_VERSION = 1
const BOOTSTRAP_COMMAND_TIMEOUT_SECONDS = 120
const HEALTH = JSON.stringify({ ok: true, protocolVersion: 2, tools: ["read", "write", "edit", "patch", "glob", "grep", "bash"] })
const VERSION = JSON.stringify({ protocolVersion: 2 })
const LAUNCHER = `#!/bin/sh
set -eu
sudo -n install -d -m 0755 -o "$(id -u)" -g "$(id -g)" /workspace
sudo -n install -d -m 0700 /run/waterbox/bash-jobs
cd /workspace
exec sudo -n env WORKSPACE_ROOT=/workspace /usr/local/bin/node /usr/local/lib/waterbox-cli.js "$@"
`
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
  readonly bashJobs = {
    observe: (input: ProviderObserveBashJobInput) => this.#observeBashJob(input),
    cleanup: (input: ProviderCleanupBashJobInput) => this.#cleanupBashJob(input),
  }
  readonly #config: Readonly<BoxProviderConfig>
  readonly #fetch: BoxProviderFetch
  readonly #clock: BoxProviderClock
  readonly #artifact: SandboxRuntimeArtifact
  readonly #diagnostic?: (event: BoxProviderDiagnostic) => void

  constructor(config: BoxProviderConfig, dependencies: BoxProviderDependencies) {
    if (!isExactObject(config, ["apiBaseUrl", "apiKey", "polling"]) || !isExactObject(config.polling, ["intervalMs", "timeoutMs"])) throw new TypeError("Box provider configuration is invalid")
    const apiBaseUrl = configurationUrl(config.apiBaseUrl)
    if (!strictNonempty(config.apiKey)) throw new TypeError("Box provider configuration is invalid")
    if (!Number.isInteger(config.polling.intervalMs) || config.polling.intervalMs <= 0 || !Number.isInteger(config.polling.timeoutMs) || config.polling.timeoutMs < config.polling.intervalMs) throw new TypeError("Box provider configuration is invalid")
    if (!isExactObject(dependencies, ["clock", "artifact"], ["fetch", "diagnostic"]) || (dependencies.fetch !== undefined && typeof dependencies.fetch !== "function") || (dependencies.diagnostic !== undefined && typeof dependencies.diagnostic !== "function") || !isObject(dependencies.clock) || typeof dependencies.clock.now !== "function" || typeof dependencies.clock.sleep !== "function") throw new TypeError("Box provider dependencies are invalid")
    const now = dependencies.clock.now()
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("Box provider dependencies are invalid")
    this.#config = { apiBaseUrl, apiKey: config.apiKey, polling: { ...config.polling } }
    this.#artifact = validateArtifact(dependencies.artifact)
    this.#fetch = dependencies.fetch ?? fetch
    this.#clock = dependencies.clock
    this.#diagnostic = dependencies.diagnostic
  }

  async createSandbox(input: ProviderCreateSandboxInput): Promise<ProviderSandboxObservation> {
    validateCreateSandboxInput(input)
    const source = input.sourceSnapshotRef === undefined ? {} : { from: snapshotRef(input.sourceSnapshotRef).name }
    const created = createdBox(await this.#boxJson("POST", "/boxes", input.signal, { body: { ...source, noEnv: true, env: { WATERBOX_SANDBOX_ID: input.sandboxId } }, idempotencyKey: input.idempotencyKey, expectedStatuses: [202] }))
    const ready = await this.#waitForReady(created, input.signal)
    return { state: mapSandboxState(ready.state), providerRef: { kind: "box-sandbox-v2", boxId: ready.id } }
  }
  async prepareSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    validateOperationInput(input)
    const ref = sandboxRef(input.providerRef)
    const state = await this.#reconcileRuntime(ref.boxId, input.signal, "verify")
    if (state === "incomplete") {
      await this.#uploadRuntime(ref.boxId, input.signal)
      await this.#installRuntime(ref.boxId, input.signal)
      if (await this.#reconcileRuntime(ref.boxId, input.signal, "final-verify") !== "complete") throw bootstrapAmbiguous()
    }
    return { state: "running", providerRef: ref as unknown as JsonValue }
  }
  async #uploadRuntime(boxId: string, signal: AbortSignal): Promise<void> {
    const path = artifactPath(this.#artifact.sha256)
    const body = { path, content: Buffer.from(this.#artifact.bytes).toString("base64"), encoding: "base64" }
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#config.polling.timeoutMs)])
      let response: Response
      try { response = await this.#fetch(`${this.#config.apiBaseUrl}/boxes/${segment(boxId)}/files`, { method: "PUT", headers: { authorization: `Bearer ${this.#config.apiKey}`, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body), signal: requestSignal }) }
      catch (error) { if (signal.aborted) throw signal.reason ?? error; throw bootstrapAmbiguous() }
      if (!response.ok) {
        try { await safeBoxError(response, requestSignal) } catch { throw bootstrapAmbiguous() }
        if (response.status >= 500) throw bootstrapAmbiguous()
        throw new BoxHttpError(response.status)
      }
      if (response.status !== 200) { cancelStreamDetached(response.body); throw bootstrapFailure() }
      let value: unknown
      try { requireMediaType(response, "application/json"); value = await boundedJson(response, requestSignal, MAX_JSON_BYTES) }
      catch (error) { if (signal.aborted) throw signal.reason ?? error; throw bootstrapAmbiguous() }
      writtenFile(value, path, this.#artifact.bytes.byteLength)
      this.#emitDiagnostic({ type: "preparation", stage: "upload", outcome: "complete" })
    } catch (error) {
      if (signal.aborted) { this.#emitDiagnostic({ type: "preparation", stage: "upload", outcome: "ambiguous" }); throw signal.reason ?? error }
      if (error instanceof ProviderError && error.kind === "failure") { this.#emitDiagnostic({ type: "preparation", stage: "upload", outcome: "failure" }); throw error }
      this.#emitDiagnostic({ type: "preparation", stage: "upload", outcome: "ambiguous" })
      throw bootstrapAmbiguous()
    }
  }
  async #installRuntime(boxId: string, signal: AbortSignal): Promise<void> {
    try {
      const command = commandResponse(await this.#bootstrapCommand(boxId, installCommand(this.#artifact), signal))
      if (uncertainCommand(command)) throw bootstrapAmbiguous()
      if (!command.success || command.exitCode !== 0 || command.stdout !== "waterbox-bootstrap-installed\n" || meaningfulCommandStderr(command.stderr) !== "") throw bootstrapFailure()
      this.#emitDiagnostic({ type: "preparation", stage: "install", outcome: "complete" })
    } catch (error) {
      if (signal.aborted) { this.#emitDiagnostic({ type: "preparation", stage: "install", outcome: "ambiguous" }); throw signal.reason ?? error }
      if (error instanceof ProviderError && error.kind === "failure") { this.#emitDiagnostic({ type: "preparation", stage: "install", outcome: "failure" }); throw error }
      this.#emitDiagnostic({ type: "preparation", stage: "install", outcome: "ambiguous" }); throw bootstrapAmbiguous()
    }
  }
  async #reconcileRuntime(boxId: string, signal: AbortSignal, stage: "verify" | "final-verify"): Promise<"complete" | "incomplete"> {
    let command
    try { command = commandResponse(await this.#bootstrapCommand(boxId, verifyCommand(this.#artifact), signal)) }
    catch (error) {
      if (signal.aborted) { this.#emitDiagnostic({ type: "preparation", stage, outcome: "ambiguous" }); throw signal.reason ?? error }
      if (error instanceof ProviderError && error.kind === "failure") { this.#emitDiagnostic({ type: "preparation", stage, outcome: "failure" }); throw error }
      this.#emitDiagnostic({ type: "preparation", stage, outcome: "ambiguous" }); throw bootstrapAmbiguous()
    }
    if (uncertainCommand(command) || meaningfulCommandStderr(command.stderr) !== "") { this.#emitDiagnostic({ type: "preparation", stage, outcome: "ambiguous" }); throw bootstrapAmbiguous() }
    if (!command.success || command.exitCode !== 0) { this.#emitDiagnostic({ type: "preparation", stage, outcome: "failure" }); throw bootstrapFailure() }
    if (command.stdout === "waterbox-bootstrap-ok\n") { this.#emitDiagnostic({ type: "preparation", stage, outcome: "complete" }); return "complete" }
    if (command.stdout === "waterbox-bootstrap-incomplete\n") { this.#emitDiagnostic({ type: "preparation", stage, outcome: "incomplete" }); return "incomplete" }
    const failed = /^waterbox-bootstrap-failed-(health|version|node|rg)\n$/.exec(command.stdout)
    if (failed) { this.#emitDiagnostic({ type: "preparation", stage, outcome: "failure" }); throw bootstrapFailure() }
    this.#emitDiagnostic({ type: "preparation", stage, outcome: "ambiguous" })
    throw bootstrapAmbiguous()
  }
  async #bootstrapCommand(boxId: string, command: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    let response: Response
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#config.polling.timeoutMs)])
    try { response = await this.#fetch(`${this.#config.apiBaseUrl}/boxes/${segment(boxId)}/commands`, { method: "POST", headers: { authorization: `Bearer ${this.#config.apiKey}`, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ command, timeoutSeconds: BOOTSTRAP_COMMAND_TIMEOUT_SECONDS }), signal: requestSignal }) }
    catch (error) { if (signal.aborted) throw signal.reason ?? error; throw bootstrapAmbiguous() }
    if (!response.ok) {
      try { await safeBoxError(response, requestSignal) } catch { throw bootstrapAmbiguous() }
      if (response.status >= 500) throw bootstrapAmbiguous()
      throw bootstrapFailure()
    }
    try { requireMediaType(response, "application/json"); return await boundedJson(response, requestSignal, MAX_COMMAND_JSON_BYTES) }
    catch (error) { if (signal.aborted) throw signal.reason ?? error; throw bootstrapAmbiguous() }
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

  async #observeBashJob(input: ProviderObserveBashJobInput): Promise<BashJobObservation> {
    validateBashJobInput(input, true)
    const ref = sandboxRef(input.providerRef)
    const command = commandResponse(await this.#toolCommand(ref.boxId, `/usr/local/bin/waterbox __internal-bash-observe ${input.jobId} ${input.offset} ${input.maxBytes}`, input.signal))
    return bashJobObservation(this.#internalBashJobResult(command), input.jobId, input.offset, input.maxBytes)
  }

  async #cleanupBashJob(input: ProviderCleanupBashJobInput): Promise<void> {
    validateBashJobInput(input, false)
    const ref = sandboxRef(input.providerRef)
    const command = commandResponse(await this.#toolCommand(ref.boxId, `/usr/local/bin/waterbox __internal-bash-cleanup ${input.jobId}`, input.signal))
    const value = this.#internalBashJobResult(command)
    if (!isExactObject(value, ["jobId", "cleaned"]) || value.jobId !== input.jobId || value.cleaned !== true) throw new ProviderError("failure", "Bash job cleanup failed")
  }

  #internalBashJobResult(command: ReturnType<typeof commandResponse>): unknown {
    if (command.timedOut || command.stdoutTruncated || command.stderrTruncated || meaningfulCommandStderr(command.stderr) !== "" || !command.success || command.exitCode !== 0) throw new ProviderError("failure", "Bash job observation failed")
    try {
      if (!command.stdout.endsWith("\n") || command.stdout.slice(0, -1).includes("\n")) throw new Error()
      return JSON.parse(command.stdout.slice(0, -1))
    } catch { throw new ProviderError("failure", "Bash job observation failed") }
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
function bashJobObservation(value: unknown, jobId: string, offset: number, maxBytes: number): BashJobObservation {
  if (!isExactObject(value, ["jobId", "state", "chunkBase64", "nextOffset", "outputSize"], ["exitCode", "signal", "timedOut", "durationMs", "error"])
    || value.jobId !== jobId || !["starting", "running", "completed", "failed"].includes(String(value.state))
    || typeof value.chunkBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.chunkBase64)
    || !Number.isSafeInteger(value.nextOffset) || !Number.isSafeInteger(value.outputSize)
    || Number(value.nextOffset) < offset || Number(value.nextOffset) > offset + maxBytes || Number(value.outputSize) < Number(value.nextOffset)
    || (value.exitCode !== undefined && value.exitCode !== null && !Number.isInteger(value.exitCode))
    || (value.signal !== undefined && value.signal !== null && typeof value.signal !== "string")
    || (value.timedOut !== undefined && typeof value.timedOut !== "boolean") || (value.durationMs !== undefined && (typeof value.durationMs !== "number" || value.durationMs < 0))
    || (value.error !== undefined && value.error !== "spawn_failed" && value.error !== "worker_failed")) throw new ProviderError("failure", "Bash job observation failed")
  const chunk = Buffer.from(value.chunkBase64, "base64")
  if (chunk.toString("base64") !== value.chunkBase64 || chunk.byteLength !== Number(value.nextOffset) - offset) throw new ProviderError("failure", "Bash job observation failed")
  return value as unknown as BashJobObservation
}
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
function bootstrapAmbiguous(): ProviderError { return new ProviderError("ambiguous_execution", "Box runtime preparation outcome is unknown") }
function bootstrapFailure(): ProviderError { return new ProviderError("failure", "Box runtime preparation failed") }
function uncertainCommand(value: ReturnType<typeof commandResponse>): boolean { return value.timedOut || value.stdoutTruncated || value.stderrTruncated }
function artifactPath(sha256: string): string { return `/tmp/waterbox-cli-${sha256}.js` }
function manifest(artifact: SandboxRuntimeArtifact): string { return JSON.stringify({ schemaVersion: 1, artifactSha256: artifact.sha256, artifactVersion: artifact.artifactVersion, cliProtocolVersion: artifact.cliProtocolVersion, nodeMajor: 24, bootstrapVersion: BOOTSTRAP_VERSION }) }
function shellLiteral(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
const NODE_SHA256_SCRIPT = "const{createHash}=require('node:crypto'),{createReadStream}=require('node:fs'),h=createHash('sha256'),s=createReadStream(process.argv[1]);s.on('data',b=>h.update(b));s.on('end',()=>process.stdout.write(h.digest('hex')));s.on('error',()=>{process.exitCode=1})"
function nodeSha256(path: string, variable = false, nodePath = "/usr/local/bin/node"): string { return `sudo -n ${shellLiteral(nodePath)} -e ${shellLiteral(NODE_SHA256_SCRIPT)} ${variable ? `"${path}"` : shellLiteral(path)}` }
interface BootstrapVerifyLayout { manifestPath: string; cliPath: string; waterboxPath: string; nodePath: string; rgPath: string }
const BOOTSTRAP_VERIFY_LAYOUT: BootstrapVerifyLayout = { manifestPath: "/usr/local/lib/waterbox-bootstrap.json", cliPath: "/usr/local/lib/waterbox-cli.js", waterboxPath: "/usr/local/bin/waterbox", nodePath: "/usr/local/bin/node", rgPath: "rg" }
function verificationChecks(artifact: SandboxRuntimeArtifact, override?: BootstrapVerifyLayout): Readonly<Record<"installedDigest" | "health" | "version" | "node" | "rg", string>> {
  const layout = override ?? BOOTSTRAP_VERIFY_LAYOUT
  return {
    installedDigest: `test "$(${nodeSha256(layout.cliPath, false, layout.nodePath)})" = ${artifact.sha256}`,
    health: `test "$(${shellLiteral(layout.waterboxPath)} health)" = ${shellLiteral(HEALTH)}`,
    version: `test "$(${shellLiteral(layout.waterboxPath)} version)" = ${shellLiteral(VERSION)}`,
    node: `case "$(${shellLiteral(layout.nodePath)} --version)" in v24.*) true ;; *) false ;; esac`,
    rg: `case "$(${shellLiteral(layout.rgPath)} --version)" in 'ripgrep '*) true ;; *) false ;; esac`,
  }
}
function verifyCommand(artifact: SandboxRuntimeArtifact, override?: BootstrapVerifyLayout): string {
  const layout = override ?? BOOTSTRAP_VERIFY_LAYOUT
  const expectedManifest = shellLiteral(manifest(artifact))
  const checks = verificationChecks(artifact, layout)
  return [
    "set -eu",
    `if ! test -f ${shellLiteral(layout.manifestPath)} || ! test "$(sudo -n cat ${shellLiteral(layout.manifestPath)})" = ${expectedManifest}; then`,
    "  printf '%s\\n' waterbox-bootstrap-incomplete",
    `elif ! ${checks.installedDigest}; then`,
    "  printf '%s\\n' waterbox-bootstrap-incomplete",
    `elif ! ${checks.health}; then`,
    "  printf '%s\\n' waterbox-bootstrap-failed-health",
    `elif ! ${checks.version}; then`,
    "  printf '%s\\n' waterbox-bootstrap-failed-version",
    `elif ! ${checks.node}; then`,
    "  printf '%s\\n' waterbox-bootstrap-failed-node",
    `elif ! ${checks.rg}; then`,
    "  printf '%s\\n' waterbox-bootstrap-failed-rg",
    "else",
    "  printf '%s\\n' waterbox-bootstrap-ok",
    "fi",
  ].join("\n")
}
interface BootstrapInstallLayout {
  uploadPath: string; libraryDirectory: string; binaryDirectory: string; workspaceDirectory: string; jobsDirectory: string
  cliPath: string; launcherPath: string; manifestPath: string; nodePath: string
}
const BOOTSTRAP_INSTALL_LAYOUT: BootstrapInstallLayout = {
  uploadPath: "", libraryDirectory: "/usr/local/lib", binaryDirectory: "/usr/local/bin", workspaceDirectory: "/workspace", jobsDirectory: "/run/waterbox/bash-jobs",
  cliPath: "/usr/local/lib/waterbox-cli.js", launcherPath: "/usr/local/bin/waterbox", manifestPath: "/usr/local/lib/waterbox-bootstrap.json", nodePath: "/usr/local/bin/node",
}
function installCommand(artifact: SandboxRuntimeArtifact, override?: BootstrapInstallLayout): string {
  const digest = artifact.sha256
  const layout = override ?? { ...BOOTSTRAP_INSTALL_LAYOUT, uploadPath: artifactPath(digest) }
  const cliTemplate = `${layout.libraryDirectory}/.waterbox-cli.${digest}.XXXXXX`
  const launcherTemplate = `${layout.binaryDirectory}/.waterbox.XXXXXX`
  const manifestTemplate = `${layout.libraryDirectory}/.waterbox-bootstrap.XXXXXX`
  return [
    "set -eu",
    "uid=$(id -u); gid=$(id -g)",
    "sudo -n true",
    `sudo -n install -d -m 0755 ${shellLiteral(layout.libraryDirectory)} ${shellLiteral(layout.binaryDirectory)}`,
    `sudo -n install -d -m 0755 -o "$uid" -g "$gid" ${shellLiteral(layout.workspaceDirectory)}`,
    `sudo -n install -d -m 0700 ${shellLiteral(layout.jobsDirectory)}`,
    "cli=; launcher=; manifest=",
    "cleanup() { [ -z \"$cli\" ] || sudo -n rm -f -- \"$cli\"; [ -z \"$launcher\" ] || sudo -n rm -f -- \"$launcher\"; [ -z \"$manifest\" ] || sudo -n rm -f -- \"$manifest\"; }",
    "trap cleanup EXIT HUP INT TERM",
    `cli=$(sudo -n mktemp ${shellLiteral(cliTemplate)})`,
    `launcher=$(sudo -n mktemp ${shellLiteral(launcherTemplate)})`,
    `manifest=$(sudo -n mktemp ${shellLiteral(manifestTemplate)})`,
    `sudo -n install -m 0600 ${shellLiteral(layout.uploadPath)} "$cli"`,
    `test "$(${nodeSha256("$cli", true, layout.nodePath)})" = ${digest}`,
    "sudo -n chmod 0644 \"$cli\"",
    `printf %s ${shellLiteral(Buffer.from(LAUNCHER).toString("base64"))} | base64 -d | sudo -n tee \"$launcher\" >/dev/null`,
    "sudo -n chmod 0755 \"$launcher\"",
    `printf %s ${shellLiteral(Buffer.from(manifest(artifact)).toString("base64"))} | base64 -d | sudo -n tee \"$manifest\" >/dev/null`,
    "sudo -n chmod 0644 \"$manifest\"",
    `sudo -n mv -f "$launcher" ${shellLiteral(layout.launcherPath)}`,
    `sudo -n mv -f "$cli" ${shellLiteral(layout.cliPath)}`,
    `sudo -n mv -f "$manifest" ${shellLiteral(layout.manifestPath)}`,
    "trap - EXIT HUP INT TERM",
    "printf '%s\\n' waterbox-bootstrap-installed",
  ].join("\n")
}
function validateArtifact(value: unknown): SandboxRuntimeArtifact {
  if (!isExactObject(value, ["bytes", "sha256", "cliProtocolVersion", "artifactVersion"]) || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength < 1 || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || value.cliProtocolVersion !== 2 || typeof value.artifactVersion !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(value.artifactVersion)) throw new TypeError("Box runtime artifact is invalid")
  const bytes = Uint8Array.from(value.bytes)
  if (createHash("sha256").update(bytes).digest("hex") !== value.sha256) throw new TypeError("Box runtime artifact is invalid")
  let text: string
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { throw new TypeError("Box runtime artifact is invalid") }
  if (!text.startsWith("#!/usr/bin/env node\n")) throw new TypeError("Box runtime artifact is invalid")
  return { bytes, sha256: value.sha256, cliProtocolVersion: 2, artifactVersion: value.artifactVersion }
}
export async function loadSandboxRuntimeArtifact(url: URL, artifactVersion: string): Promise<SandboxRuntimeArtifact> {
  if (!(url instanceof URL) || url.protocol !== "file:") throw new TypeError("Box runtime artifact location is invalid")
  let bytes: Uint8Array
  try { bytes = await readFile(url) } catch { throw new TypeError("Box runtime artifact could not be loaded") }
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  return validateArtifact({ bytes, sha256, cliProtocolVersion: 2, artifactVersion })
}
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
function validateBashJobInput(value: unknown, observation: boolean): asserts value is ProviderObserveBashJobInput | ProviderCleanupBashJobInput {
  if (!isObject(value) || !isAbortSignal(value.signal) || typeof value.jobId !== "string" || !/^job_[0-9a-f]{32}$/.test(value.jobId)) invalidInput()
  if (observation && (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0 || !Number.isSafeInteger(value.maxBytes) || Number(value.maxBytes) < 1 || Number(value.maxBytes) > 65_536)) invalidInput()
  value.signal.throwIfAborted()
  sandboxRef(value.providerRef as JsonValue)
}
function isAbortSignal(value: unknown): value is AbortSignal { return value instanceof AbortSignal && typeof value.throwIfAborted === "function" }
function invalidInput(): never { throw new ProviderError("failure", "The Box provider input is invalid") }
async function internalSnapshotName(accountId: string, snapshotId: string): Promise<string> { const [a, s] = await Promise.all([shortHash(accountId), shortHash(snapshotId)]); return `waterbox-${slug(accountId)}-${a}-${slug(snapshotId)}-${s}` }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 8) || "id" }
async function shortHash(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest).slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("") }
export const __testing = { BOOTSTRAP_INSTALL_LAYOUT, BOOTSTRAP_VERIFY_LAYOUT, LAUNCHER, internalSnapshotName, artifactPath, installCommand, manifest, nodeSha256, verificationChecks, verifyCommand }
