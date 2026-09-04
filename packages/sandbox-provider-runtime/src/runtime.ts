import {
  BashJobObservationSchema,
  BashToolResultSchema,
  EditToolResultSchema,
  GlobToolResultSchema,
  GrepToolResultSchema,
  MAX_SECURE_CIPHERTEXT_BYTES,
  PatchToolResultSchema,
  ReadToolResultSchema,
  SecureTransferDeliveredSchema,
  SecureTransferInitiatedSchema,
  WriteToolResultSchema,
  type BashJobObservation,
  type SecureTransferDelivered,
  type SecureTransferInitiated,
  type ToolResultByName,
  type ToolName,
} from "@waterbox/contracts"
import {
  ProviderError,
  type ProviderCleanupBashJobInput,
  type ProviderConsumeSecureTransferInput,
  type ProviderCreateSandboxInput,
  type ProviderCreateSnapshotInput,
  type ProviderExecuteInput,
  type ProviderObserveBashJobInput,
  type ProviderOperationInput,
  type ProviderSandboxObservation,
  type ProviderSnapshotObservation,
  type ProviderSnapshotOperationInput,
  type SandboxProvider,
} from "@waterbox/core/provider"
import type { JsonValue as CoreJsonValue } from "@waterbox/core/records"
import { CliProtocolError, encodeInvocation, encodeSecureTransferInput } from "@waterbox/cli/protocol"
import { createHash } from "node:crypto"
import {
  DEFAULT_RUNTIME_PATH_PROVISIONER,
  FULL_LINUX_RUNTIME_PROFILE,
  MAX_COMMAND_OUTPUT_BYTES,
  assertCommandResult,
  quotePosixShellWord,
  type InfrastructureCommandResult,
  type FullLinuxRuntimeProfile,
  type JsonReference,
  type RuntimePathProvisioner,
  type SandboxInfrastructure,
} from "./index.ts"
import { validateSandboxRuntimeArtifact } from "./artifact.ts"

/** The caller-owned CLI bundle installed into a full-Linux sandbox. */
export interface SandboxRuntimeArtifact {
  bytes: Uint8Array
  sha256: string
  cliProtocolVersion: 2
  artifactVersion: string
}

export type RuntimeDiagnostic =
  | { type: "tool-command"; tool: ToolName; success: boolean; exitCode: number | null; timedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean; hasStderr: boolean }
  | { type: "tool-event-invalid"; tool: ToolName }
  | { type: "preparation"; stage: "verify" | "final-verify"; outcome: "complete" | "incomplete" | "ambiguous" | "failure" }
  | { type: "preparation"; stage: "upload" | "install"; outcome: "complete" | "ambiguous" | "failure" }

export interface RuntimeDependencies {
  artifact: SandboxRuntimeArtifact
  diagnostic?: (event: RuntimeDiagnostic) => void
  runtimeProfile?: FullLinuxRuntimeProfile
  pathProvisioner?: RuntimePathProvisioner
}

const BOOTSTRAP_TIMEOUT_MS = 120_000
// Keep the primitive contract's ten-minute ceiling without reading a cyclic
// re-export while this backend module is being initialized.
const TOOL_TIMEOUT_MS = 10 * 60 * 1_000
const HEALTH = JSON.stringify({ ok: true, protocolVersion: 2, tools: ["read", "write", "edit", "patch", "glob", "grep", "bash"] })
const VERSION = JSON.stringify({ protocolVersion: 2 })
const RESULT_SCHEMAS = { read: ReadToolResultSchema, write: WriteToolResultSchema, edit: EditToolResultSchema, patch: PatchToolResultSchema, glob: GlobToolResultSchema, grep: GrepToolResultSchema, bash: BashToolResultSchema } as const

/**
 * Product runtime composition over semantic infrastructure primitives. It has
 * no knowledge of provider transports, resource DTOs, or provider names.
 */
export class WaterboxSandboxBackend implements SandboxProvider {
  readonly name: string
  readonly stopResume: SandboxProvider["stopResume"]
  readonly snapshots: SandboxProvider["snapshots"]
  readonly secureFileTransfer = {
    initiate: (input: ProviderOperationInput) => this.#initiateSecureFileTransfer(input),
    consume: (input: ProviderConsumeSecureTransferInput) => this.#consumeSecureFileTransfer(input),
  }
  readonly bashJobs = {
    observe: (input: ProviderObserveBashJobInput) => this.#observeBashJob(input),
    cleanup: (input: ProviderCleanupBashJobInput) => this.#cleanupBashJob(input),
  }
  readonly #infrastructure: SandboxInfrastructure
  readonly #artifact: SandboxRuntimeArtifact
  readonly #diagnostic?: (event: RuntimeDiagnostic) => void
  readonly #runtimeProfile: FullLinuxRuntimeProfile
  readonly #pathProvisioner: RuntimePathProvisioner

  constructor(infrastructure: SandboxInfrastructure, dependencies: RuntimeDependencies) {
    if (!infrastructure || typeof infrastructure.name !== "string" || typeof infrastructure.create !== "function" || typeof infrastructure.inspect !== "function" || typeof infrastructure.runCommand !== "function" || typeof infrastructure.writeFile !== "function" || typeof infrastructure.delete !== "function") throw new TypeError("Sandbox infrastructure is invalid")
    if (!dependencies || (dependencies.diagnostic !== undefined && typeof dependencies.diagnostic !== "function")) throw new TypeError("Runtime dependencies are invalid")
    this.#infrastructure = infrastructure
    this.#artifact = validateSandboxRuntimeArtifact(dependencies.artifact)
    this.#diagnostic = dependencies.diagnostic
    this.#runtimeProfile = validateRuntimeProfile(dependencies.runtimeProfile ?? FULL_LINUX_RUNTIME_PROFILE)
    this.#pathProvisioner = validatePathProvisioner(dependencies.pathProvisioner ?? DEFAULT_RUNTIME_PATH_PROVISIONER)
    this.name = infrastructure.name
    this.stopResume = infrastructure.stopResume === undefined ? undefined : {
      stop: async input => observation(await infrastructure.stopResume!.stop(primitiveInput(input))),
      resume: async input => observation(await infrastructure.stopResume!.resume(primitiveInput(input))),
    }
    this.snapshots = infrastructure.snapshots === undefined ? undefined : {
      create: async input => {
        const created = await infrastructure.snapshots!.create({ accountId: input.accountId, providerRef: reference(input.sandboxRef), snapshotId: input.snapshotId, expectedState: "running", signal: input.signal })
        return { ...snapshotObservation(created), ...(created.sourceSandbox === undefined ? {} : { sourceSandbox: observation(created.sourceSandbox) }) }
      },
      inspect: async input => snapshotObservation(await infrastructure.snapshots!.inspect({ accountId: input.accountId, snapshotId: input.snapshotId, providerRef: reference(input.providerRef), signal: input.signal })),
      delete: async input => snapshotObservation(await infrastructure.snapshots!.delete({ accountId: input.accountId, snapshotId: input.snapshotId, providerRef: reference(input.providerRef), signal: input.signal })),
    }
  }

  async createSandbox(input: ProviderCreateSandboxInput): Promise<ProviderSandboxObservation> {
    const created = await this.#infrastructure.create({ accountId: input.accountId, sandboxId: input.sandboxId, idempotencyKey: input.idempotencyKey, ...(input.sourceSnapshotRef === undefined ? {} : { sourceSnapshotRef: reference(input.sourceSnapshotRef) }), signal: input.signal })
    return observation(created)
  }

  async inspectSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    return observation(await this.#infrastructure.inspect(primitiveInput(input)))
  }

  async deleteSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    return observation(await this.#infrastructure.delete(primitiveInput(input)))
  }

  async prepareSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation> {
    const primitive = primitiveInput(input)
    await this.#prepareWorkspace(primitive)
    const first = await this.#verify(primitive, "verify")
    if (first === "complete") return { state: "running", providerRef: input.providerRef }
    try {
      await this.#infrastructure.writeFile({ ...primitive, path: artifactPath(this.#runtimeProfile, this.#artifact.sha256), contents: this.#artifact.bytes, mode: this.#runtimeProfile.artifactMode })
      this.#emit({ type: "preparation", stage: "upload", outcome: "complete" })
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error
      if (error instanceof ProviderError && error.kind !== "ambiguous_execution") {
        this.#emit({ type: "preparation", stage: "upload", outcome: "failure" })
        throw error
      }
      this.#emit({ type: "preparation", stage: "upload", outcome: "ambiguous" })
      // A lost upload acknowledgement is recovered only by the read-only final verification below.
      return this.#recoverPreparationAfterAmbiguity(primitive, input.providerRef)
    }
    const installed = await this.#install(primitive)
    if (!installed) return this.#recoverPreparationAfterAmbiguity(primitive, input.providerRef)
    const final = await this.#verify(primitive, "final-verify")
    if (final !== "complete") throw new ProviderError("ambiguous_execution", "Runtime preparation outcome is unknown")
    return { state: "running", providerRef: input.providerRef }
  }

  async #prepareWorkspace(input: ReturnType<typeof primitiveInput>): Promise<void> {
    if (this.#pathProvisioner.prepareWorkspace === undefined) return
    const script = this.#pathProvisioner.prepareWorkspace(this.#runtimeProfile)
    if (typeof script !== "string" || script.length === 0 || script.includes("\u0000")) throw new TypeError("Runtime path provisioner is invalid")
    const request = { ...input, script, cwd: "/", timeoutMs: BOOTSTRAP_TIMEOUT_MS, maxStdoutBytes: MAX_COMMAND_OUTPUT_BYTES, maxStderrBytes: MAX_COMMAND_OUTPUT_BYTES }
    const result = await this.#infrastructure.runCommand(request)
    assertCommandResult(result, request)
    if (uncertain(result)) throw new ProviderError("ambiguous_execution", "Runtime workspace preparation outcome is unknown")
    if (result.exitCode !== 0 || decoded(result.stdout) !== "" || decoded(result.stderr) !== "") throw new ProviderError("failure", "Runtime workspace preparation failed")
  }

  async #recoverPreparationAfterAmbiguity(input: ReturnType<typeof primitiveInput>, providerRef: CoreJsonValue): Promise<ProviderSandboxObservation> {
    const verified = await this.#verify(input, "final-verify")
    if (verified === "complete") return { state: "running", providerRef }
    throw new ProviderError("ambiguous_execution", "Runtime preparation outcome is unknown")
  }

  async #install(input: ReturnType<typeof primitiveInput>): Promise<boolean> {
    let result: InfrastructureCommandResult
    try { result = await this.#command(input, installCommand(this.#artifact, this.#runtimeProfile, this.#pathProvisioner), BOOTSTRAP_TIMEOUT_MS) }
    catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error
      if (error instanceof ProviderError && error.kind !== "ambiguous_execution") {
        this.#emit({ type: "preparation", stage: "install", outcome: "failure" })
        throw error
      }
      this.#emit({ type: "preparation", stage: "install", outcome: "ambiguous" })
      return false
    }
    if (uncertain(result)) { this.#emit({ type: "preparation", stage: "install", outcome: "ambiguous" }); return false }
    if (result.exitCode !== 0 || decoded(result.stderr) !== "" || decoded(result.stdout) !== "waterbox-bootstrap-installed\n") {
      this.#emit({ type: "preparation", stage: "install", outcome: "failure" })
      throw new ProviderError("failure", "Runtime preparation failed")
    }
    this.#emit({ type: "preparation", stage: "install", outcome: "complete" })
    return true
  }

  async #verify(input: ReturnType<typeof primitiveInput>, stage: "verify" | "final-verify"): Promise<"complete" | "incomplete"> {
    let result: InfrastructureCommandResult
    try { result = await this.#command(input, verifyCommand(this.#artifact, this.#runtimeProfile), BOOTSTRAP_TIMEOUT_MS) }
    catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error
      if (error instanceof ProviderError && error.kind !== "ambiguous_execution") {
        this.#emit({ type: "preparation", stage, outcome: "failure" })
        throw error
      }
      this.#emit({ type: "preparation", stage, outcome: "ambiguous" })
      throw new ProviderError("ambiguous_execution", "Runtime preparation outcome is unknown")
    }
    const stdout = decoded(result.stdout)
    if (uncertain(result) || decoded(result.stderr) !== "") { this.#emit({ type: "preparation", stage, outcome: "ambiguous" }); throw new ProviderError("ambiguous_execution", "Runtime preparation outcome is unknown") }
    if (result.exitCode !== 0) { this.#emit({ type: "preparation", stage, outcome: "failure" }); throw new ProviderError("failure", "Runtime preparation failed") }
    if (stdout === "waterbox-bootstrap-ok\n") { this.#emit({ type: "preparation", stage, outcome: "complete" }); return "complete" }
    if (stdout === "waterbox-bootstrap-incomplete\n") { this.#emit({ type: "preparation", stage, outcome: "incomplete" }); return "incomplete" }
    if (/^waterbox-bootstrap-failed-(health|version|node|rg)\n$/.test(stdout)) {
      this.#emit({ type: "preparation", stage, outcome: "failure" })
      throw new ProviderError("failure", "Runtime preparation failed")
    }
    this.#emit({ type: "preparation", stage, outcome: "ambiguous" })
    throw new ProviderError("ambiguous_execution", "Runtime preparation outcome is unknown")
  }

  async executeTool<N extends ToolName>(input: ProviderExecuteInput<N>): Promise<ToolResultByName[N]> {
    input.signal.throwIfAborted()
    let payload: string
    try { payload = encodeInvocation(input.toolName, input.arguments as never) }
    catch (error) { if (error instanceof CliProtocolError) throw new ProviderError("failure", "The tool invocation exceeds the runtime command limit"); throw error }
    const result = await this.#runUserCommand(primitiveInput(input), `${quotePosixShellWord(this.#runtimeProfile.persistentPaths.launcherPath)} run ${quotePosixShellWord(payload)}`, input.toolName)
    try { return RESULT_SCHEMAS[input.toolName].parse(oneJsonLine(result.stdout)) as ToolResultByName[N] }
    catch (_error) {
      this.#emit({ type: "tool-event-invalid", tool: input.toolName })
      throw new ProviderError("ambiguous_execution", "Tool execution outcome is unknown")
    }
  }

  async #initiateSecureFileTransfer(input: ProviderOperationInput): Promise<SecureTransferInitiated> {
    const result = await this.#command(primitiveInput(input), `${quotePosixShellWord(this.#runtimeProfile.persistentPaths.launcherPath)} transfer-initiate`, TOOL_TIMEOUT_MS)
    try { return SecureTransferInitiatedSchema.parse(this.#readOnlyJsonResult(result, "Secure transfer command failed")) }
    catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError("failure", "Secure transfer command failed") }
  }

  async #consumeSecureFileTransfer(input: ProviderConsumeSecureTransferInput): Promise<SecureTransferDelivered> {
    let ciphertext: Uint8Array
    try {
      const decodedCiphertext = Buffer.from(input.ciphertext, "base64")
      if (decodedCiphertext.byteLength > MAX_SECURE_CIPHERTEXT_BYTES || decodedCiphertext.toString("base64") !== input.ciphertext) throw new Error()
      ciphertext = Uint8Array.from(decodedCiphertext)
    } catch { throw new ProviderError("failure", "Secure transfer input is invalid") }
    const primitive = primitiveInput(input)
    const ciphertextPath = `${this.#runtimeProfile.ephemeralPaths.uploadStagingDirectory}/waterbox-transfer-${crypto.randomUUID()}.age`
    try { await this.#infrastructure.writeFile({ ...primitive, path: ciphertextPath, contents: ciphertext, mode: 0o600 }) }
    catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error
      if (error instanceof ProviderError && error.kind !== "ambiguous_execution") throw error
      throw new ProviderError("ambiguous_execution", "Secure transfer outcome is unknown")
    }
    let result: InfrastructureCommandResult
    try { result = await this.#command(primitive, `${quotePosixShellWord(this.#runtimeProfile.persistentPaths.launcherPath)} transfer-consume ${quotePosixShellWord(encodeSecureTransferInput({ transferId: input.transferId, targetPath: input.targetPath, ciphertextPath }))}`, TOOL_TIMEOUT_MS) }
    catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error
      if (error instanceof ProviderError && error.kind !== "ambiguous_execution") throw error
      throw new ProviderError("ambiguous_execution", "Secure transfer outcome is unknown")
    }
    const value = this.#mutatingJsonResult(result, "Secure transfer outcome is unknown")
    try {
      const delivered = SecureTransferDeliveredSchema.parse(value)
      if (delivered.transferId !== input.transferId || delivered.targetPath !== input.targetPath) throw new Error()
      return delivered
    } catch { throw new ProviderError("ambiguous_execution", "Secure transfer outcome is unknown") }
  }

  async #observeBashJob(input: ProviderObserveBashJobInput): Promise<BashJobObservation> {
    const result = await this.#command(primitiveInput(input), `${quotePosixShellWord(this.#runtimeProfile.persistentPaths.launcherPath)} __internal-bash-observe ${quotePosixShellWord(input.jobId)} ${quotePosixShellWord(String(input.offset))} ${quotePosixShellWord(String(input.maxBytes))}`, TOOL_TIMEOUT_MS)
    try {
      const value = BashJobObservationSchema.parse(this.#readOnlyJsonResult(result, "Bash job observation failed"))
      if (value.jobId !== input.jobId || value.nextOffset < input.offset || value.nextOffset > input.offset + input.maxBytes || value.outputSize < value.nextOffset || Buffer.from(value.chunkBase64, "base64").byteLength !== value.nextOffset - input.offset) throw new Error()
      return value
    } catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError("failure", "Bash job observation failed") }
  }

  async #cleanupBashJob(input: ProviderCleanupBashJobInput): Promise<void> {
    const result = await this.#command(primitiveInput(input), `${quotePosixShellWord(this.#runtimeProfile.persistentPaths.launcherPath)} __internal-bash-cleanup ${quotePosixShellWord(input.jobId)}`, TOOL_TIMEOUT_MS)
    const value = this.#readOnlyJsonResult(result, "Bash job cleanup failed")
    if (!isExactObject(value, ["jobId", "cleaned"]) || value.jobId !== input.jobId || value.cleaned !== true) throw new ProviderError("failure", "Bash job cleanup failed")
  }

  async #runUserCommand(input: ReturnType<typeof primitiveInput>, script: string, tool: ToolName): Promise<InfrastructureCommandResult> {
    let result: InfrastructureCommandResult
    try { result = await this.#command(input, script, TOOL_TIMEOUT_MS) }
    catch (error) {
      if (error instanceof ProviderError && error.kind === "ambiguous_execution") throw error
      if (error instanceof ProviderError && error.kind !== "ambiguous_execution") throw error
      throw new ProviderError("ambiguous_execution", "Tool execution outcome is unknown")
    }
    const stderr = decoded(result.stderr)
    this.#emit({ type: "tool-command", tool, success: result.exitCode === 0, exitCode: result.exitCode, timedOut: result.timedOut, stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated, hasStderr: stderr !== "" })
    if (uncertain(result) || stderr !== "") throw new ProviderError("ambiguous_execution", "Tool execution outcome is unknown")
    if (result.exitCode !== 0) {
      const rejected = cliError(decoded(result.stdout))
      if (rejected?.status !== undefined && rejected.status < 500) throw new ProviderError("failure", "The sandbox CLI rejected tool execution")
      throw new ProviderError("ambiguous_execution", "Tool execution outcome is unknown")
    }
    return result
  }

  #readOnlyJsonResult(result: InfrastructureCommandResult, message: string): unknown {
    if (uncertain(result) || decoded(result.stderr) !== "" || result.exitCode !== 0) throw new ProviderError("failure", message)
    try { return oneJsonLine(result.stdout) } catch { throw new ProviderError("failure", message) }
  }

  #mutatingJsonResult(result: InfrastructureCommandResult, message: string): unknown {
    if (uncertain(result) || decoded(result.stderr) !== "") throw new ProviderError("ambiguous_execution", message)
    if (result.exitCode !== 0) {
      const rejected = cliError(decoded(result.stdout))
      if (rejected?.code === "transfer_expired") throw new ProviderError("expired", "Secure transfer expired")
      if (rejected?.code === "transfer_consumed") throw new ProviderError("consumed", "Secure transfer was consumed")
      if (rejected?.status !== undefined && rejected.status < 500) throw new ProviderError("failure", "Secure transfer was rejected")
      throw new ProviderError("ambiguous_execution", message)
    }
    try { return oneJsonLine(result.stdout) } catch { throw new ProviderError("ambiguous_execution", message) }
  }

  async #command(input: ReturnType<typeof primitiveInput>, script: string, timeoutMs: number): Promise<InfrastructureCommandResult> {
    const request = { ...input, script, cwd: this.#runtimeProfile.workspacePath, timeoutMs, maxStdoutBytes: MAX_COMMAND_OUTPUT_BYTES, maxStderrBytes: MAX_COMMAND_OUTPUT_BYTES }
    const result = await this.#infrastructure.runCommand(request)
    assertCommandResult(result, request)
    return result
  }

  #emit(event: RuntimeDiagnostic): void { try { this.#diagnostic?.(event) } catch {} }
}

function primitiveInput(input: ProviderOperationInput): { accountId: string; providerRef: JsonReference; signal: AbortSignal } {
  return { accountId: input.accountId, providerRef: reference(input.providerRef), signal: input.signal }
}
function reference(value: CoreJsonValue): JsonReference {
  if (!isSafeJsonReference(value)) throw new ProviderError("failure", "The sandbox provider reference is invalid")
  // The core port intentionally uses mutable arrays while primitive references
  // are readonly. The recursive validation above establishes the shared JSON
  // value subset before crossing that type-only variance boundary.
  return value as unknown as JsonReference
}
function isSafeJsonReference(value: unknown): boolean {
  if (value === null) return false
  if (typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object") return false
  if (Array.isArray(value)) return value.every(isSafeJsonReference)
  return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(isSafeJsonReference)
}
function observation(value: { state: ProviderSandboxObservation["state"]; providerRef: JsonReference }): ProviderSandboxObservation { return { state: value.state, providerRef: value.providerRef as CoreJsonValue } }
function snapshotObservation(value: { state: ProviderSnapshotObservation["state"]; providerRef: JsonReference }): ProviderSnapshotObservation { return { state: value.state, providerRef: value.providerRef as CoreJsonValue } }
function uncertain(result: InfrastructureCommandResult): boolean { return result.timedOut || result.stdoutTruncated || result.stderrTruncated }
function decoded(bytes: Uint8Array): string { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { return "\u0000" } }
function oneJsonLine(bytes: Uint8Array): unknown {
  const value = decoded(bytes)
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n")) throw new Error("not one line")
  return JSON.parse(value.slice(0, -1))
}
function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function cliError(stdout: string): { status?: number; code?: string } | undefined {
  try { const value = JSON.parse(stdout.trim()); return isExactObject(value, ["protocolVersion", "type", "status", "code"]) && value.protocolVersion === 2 && value.type === "error" && Number.isInteger(value.status) && typeof value.code === "string" ? { status: value.status as number, code: value.code as string } : undefined } catch { return undefined }
}
function artifactPath(profile: FullLinuxRuntimeProfile, sha256: string): string { return `${profile.ephemeralPaths.uploadStagingDirectory}/waterbox-runtime-${sha256}.js` }
function manifest(artifact: SandboxRuntimeArtifact): string { return JSON.stringify({ schemaVersion: 1, artifactSha256: artifact.sha256, artifactVersion: artifact.artifactVersion, cliProtocolVersion: artifact.cliProtocolVersion, nodeMajor: 24 }) }
function installCommand(artifact: SandboxRuntimeArtifact, profile: FullLinuxRuntimeProfile, pathProvisioner: RuntimePathProvisioner): string {
  const upload = artifactPath(profile, artifact.sha256)
  const paths = profile.persistentPaths
  const provision = pathProvisioner.provision(profile)
  if (typeof provision !== "string" || provision.length === 0 || provision.includes("\u0000")) throw new TypeError("Runtime path provisioner is invalid")
  const launch = pathProvisioner.launch?.(profile) ?? `node ${quotePosixShellWord(paths.cliPath)} "$@"`
  if (typeof launch !== "string" || launch.length === 0 || launch.includes("\u0000")) throw new TypeError("Runtime path provisioner is invalid")
  const launcher = `#!/bin/sh\nset -eu\ntest -d ${quotePosixShellWord(profile.ephemeralPaths.jobsDirectory)}\ncd ${quotePosixShellWord(profile.workspacePath)}\nexec ${launch}\n`
  return [
    "set -eu", "node_bin=$(command -v node)", 'case "$($node_bin --version)" in v24.*) ;; *) exit 20 ;; esac',
    provision,
    `test "$(\"$node_bin\" -e ${quotePosixShellWord("const{createHash}=require('node:crypto'),{readFileSync}=require('node:fs');process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))")} ${quotePosixShellWord(upload)})" = ${quotePosixShellWord(artifact.sha256)}`,
    `tmp=$(mktemp ${quotePosixShellWord(`${paths.runtimeDirectory}/.cli.XXXXXX`)})`, `install -m 0644 ${quotePosixShellWord(upload)} "$tmp"`, `mv -f "$tmp" ${quotePosixShellWord(paths.cliPath)}`,
    `printf %s ${quotePosixShellWord(Buffer.from(launcher).toString("base64"))} | base64 -d > ${quotePosixShellWord(paths.launcherPath)}`, `chmod 0755 ${quotePosixShellWord(paths.launcherPath)}`,
    `printf %s ${quotePosixShellWord(Buffer.from(manifest(artifact)).toString("base64"))} | base64 -d > ${quotePosixShellWord(paths.manifestPath)}`, `chmod 0644 ${quotePosixShellWord(paths.manifestPath)}`,
    "printf '%s\\n' waterbox-bootstrap-installed",
  ].join("\n")
}
function verifyCommand(artifact: SandboxRuntimeArtifact, profile: FullLinuxRuntimeProfile): string {
  const hashScript = "const{createHash}=require('node:crypto'),{readFileSync}=require('node:fs');process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))"
  return [
    "set -eu", `if ! test -f ${quotePosixShellWord(profile.persistentPaths.manifestPath)} || ! test -f ${quotePosixShellWord(profile.persistentPaths.cliPath)} || ! test -x ${quotePosixShellWord(profile.persistentPaths.launcherPath)} || ! test -d ${quotePosixShellWord(profile.ephemeralPaths.jobsDirectory)} || ! test "$(cat ${quotePosixShellWord(profile.persistentPaths.manifestPath)})" = ${quotePosixShellWord(manifest(artifact))}; then printf '%s\\n' waterbox-bootstrap-incomplete`,
    `elif ! test "$(node -e ${quotePosixShellWord(hashScript)} ${quotePosixShellWord(profile.persistentPaths.cliPath)})" = ${quotePosixShellWord(artifact.sha256)}; then printf '%s\\n' waterbox-bootstrap-incomplete`,
    `elif ! test "$( ${quotePosixShellWord(profile.persistentPaths.launcherPath)} health)" = ${quotePosixShellWord(HEALTH)}; then printf '%s\\n' waterbox-bootstrap-failed-health`,
    `elif ! test "$( ${quotePosixShellWord(profile.persistentPaths.launcherPath)} version)" = ${quotePosixShellWord(VERSION)}; then printf '%s\\n' waterbox-bootstrap-failed-version`,
    "elif ! case \"$(node --version)\" in v24.*) true ;; *) false ;; esac; then printf '%s\\n' waterbox-bootstrap-failed-node",
    "elif ! case \"$(rg --version)\" in 'ripgrep '*) true ;; *) false ;; esac; then printf '%s\\n' waterbox-bootstrap-failed-rg",
    "else printf '%s\\n' waterbox-bootstrap-ok; fi",
  ].join("\n")
}
function validateRuntimeProfile(value: FullLinuxRuntimeProfile): FullLinuxRuntimeProfile {
  const persistent = value?.persistentPaths
  const ephemeral = value?.ephemeralPaths
  if (!isAbsolutePath(value?.workspacePath) || value.workspacePath !== persistent?.workspace
    || !persistent || !isAbsolutePath(persistent.runtimeDirectory) || !isAbsolutePath(persistent.cliPath) || !isAbsolutePath(persistent.launcherPath) || !isAbsolutePath(persistent.manifestPath)
    || !ephemeral || !isAbsolutePath(ephemeral.uploadStagingDirectory) || ephemeral.jobsDirectory !== "/run/waterbox/bash-jobs"
    || value.artifactMode !== 0o640) throw new TypeError("Runtime profile is invalid")
  return value
}
function validatePathProvisioner(value: RuntimePathProvisioner): RuntimePathProvisioner {
  if (!value || typeof value.provision !== "function" || (value.prepareWorkspace !== undefined && typeof value.prepareWorkspace !== "function")) throw new TypeError("Runtime path provisioner is invalid")
  return value
}
function isAbsolutePath(value: unknown): value is string { return typeof value === "string" && value.startsWith("/") && !value.includes("\u0000") && !value.includes("//") }
