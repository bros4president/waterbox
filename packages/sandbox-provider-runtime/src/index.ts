import { MAX_TOOL_RESULT_BYTES, type SandboxId, type SandboxState, type SnapshotId, type SnapshotState } from "@waterbox/contracts"

/** JSON stays opaque above an infrastructure adapter. */
export type JsonValue = null | JsonReference
export type JsonReference = boolean | number | string | readonly JsonReference[] | { readonly [key: string]: JsonReference }

/** The CLI's one-line JSON result must carry a worst-case escaped 1 MiB Bash output. */
export const MAX_COMMAND_OUTPUT_BYTES = MAX_TOOL_RESULT_BYTES
/**
 * Production command stdout is either a small bootstrap token or one bounded
 * Waterbox CLI JSON result; successful CLI stderr is empty. Enclosing that
 * already-serialized JSON can at most escape each backslash once more.
 */
export const MAX_COMMAND_RESPONSE_BYTES = MAX_COMMAND_OUTPUT_BYTES * 2 + 65_536
export const MAX_FILE_BYTES = 32 * 1_024 * 1_024
export const MAX_COMMAND_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_COMMAND_SCRIPT_BYTES = 65_536

export interface InfrastructureSandboxObservation {
  state: SandboxState
  providerRef: JsonReference
}

export interface InfrastructureSnapshotObservation {
  state: SnapshotState
  providerRef: JsonReference
  /** Optional exact source observation after a native snapshot dispatch. */
  sourceSandbox?: InfrastructureSandboxObservation
}

export interface InfrastructureSandboxInput {
  accountId: string
  providerRef: JsonReference
  signal: AbortSignal
}

export interface InfrastructureCreateInput {
  accountId: string
  sandboxId: SandboxId
  /** Stable identity for one provider mutation; adapters must not replay it after uncertainty. */
  idempotencyKey: string
  sourceSnapshotRef?: JsonReference
  signal: AbortSignal
}

/**
 * A script is the single common command representation. An adapter transports
 * it as one UTF-8 value to a fixed non-interactive shell, or as the sole value
 * in an argument-vector execution. It must never concatenate it into a
 * transport command. Shared callers quote every interpolated shell word with
 * `quotePosixShellWord`; adapters preserve the resulting bytes unchanged.
 */
export interface InfrastructureCommandInput extends InfrastructureSandboxInput {
  script: string
  cwd?: string
  environment?: Readonly<Record<string, string>>
  timeoutMs: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
}

export interface InfrastructureCommandResult {
  exitCode: number | null
  stdout: Uint8Array
  stderr: Uint8Array
  timedOut: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export interface InfrastructureWriteFileInput extends InfrastructureSandboxInput {
  path: string
  contents: Uint8Array
  mode?: number
}

export interface InfrastructureCreateSnapshotInput extends InfrastructureSandboxInput {
  snapshotId: SnapshotId
  /** The adapter must perform an exact, side-effect-free running revalidation immediately before dispatch. */
  expectedState: "running"
}

export interface InfrastructureSnapshotInput {
  accountId: string
  snapshotId: SnapshotId
  providerRef: JsonReference
  signal: AbortSignal
}

export interface InfrastructureInventoryInput {
  accountId: string
  signal: AbortSignal
  pageSize: number
}

/**
 * Provider-native infrastructure only. Implementations validate exact identity,
 * bound I/O/polls, and never replay a dispatched mutation after transport loss.
 */
export interface SandboxInfrastructure {
  readonly name: string
  create(input: InfrastructureCreateInput): Promise<InfrastructureSandboxObservation>
  /** Exact and side-effect free: no resume, repair, install, or recreation. */
  inspect(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation>
  runCommand(input: InfrastructureCommandInput): Promise<InfrastructureCommandResult>
  writeFile(input: InfrastructureWriteFileInput): Promise<void>
  delete(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation>
  readonly stopResume?: {
    stop(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation>
    resume(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation>
  }
  readonly snapshots?: {
    create(input: InfrastructureCreateSnapshotInput): Promise<InfrastructureSnapshotObservation>
    inspect(input: InfrastructureSnapshotInput): Promise<InfrastructureSnapshotObservation>
    delete(input: InfrastructureSnapshotInput): Promise<InfrastructureSnapshotObservation>
  }
  readonly inventory?: {
    listSandboxes(input: InfrastructureInventoryInput): AsyncIterable<InfrastructureSandboxObservation>
    listSnapshots(input: InfrastructureInventoryInput): AsyncIterable<InfrastructureSnapshotObservation>
  }
}

/** Concrete shared runtime locations; provider transport remains below this profile. */
export interface FullLinuxRuntimeProfile {
  workspacePath: string
  artifactMode: 0o640
  persistentPaths: {
    runtimeDirectory: string
    cliPath: string
    launcherPath: string
    manifestPath: string
    workspace: string
  }
  ephemeralPaths: {
    uploadStagingDirectory: string
    jobsDirectory: string
  }
  requires: readonly ["node-24", "rg", "absolute-workspace", "persistent-files", "detached-jobs"]
  executableDiscovery: "PATH then adapter-validated absolute executable"
  privilegeStrategy: "adapter-provided non-interactive capability"
}

export interface RuntimePathProvisioner {
  /**
   * Optional trusted fragment that establishes the workspace before any
   * cwd-bound runtime verification or tool command. The shared runtime runs
   * this fragment from the explicit filesystem root; providers must make it
   * idempotent.
   */
  prepareWorkspace?(paths: Pick<FullLinuxRuntimeProfile, "workspacePath" | "persistentPaths" | "ephemeralPaths">): string
  /**
   * Returns the non-interactive command fragment that creates the supplied
   * persistent runtime and ephemeral detached-job roots. A provider can supply
   * its own privilege mechanics here without exposing provider behavior to the
   * shared backend.
   */
  provision(paths: Pick<FullLinuxRuntimeProfile, "workspacePath" | "persistentPaths" | "ephemeralPaths">): string
  /**
   * Optional provider-supplied non-interactive launcher command. The shared
   * runtime supplies the CLI path and keeps the launcher protocol common;
   * adapters may only provide proven privilege/executable mechanics.
   */
  launch?(paths: Pick<FullLinuxRuntimeProfile, "workspacePath" | "persistentPaths" | "ephemeralPaths">): string
}

/**
 * The profile deliberately does not prescribe a node binary, sudo invocation,
 * archive encoding, or provider-specific transport. The detached-job root is
 * the sandbox CLI's actual stable root, not an adapter-local substitute.
 */
export const FULL_LINUX_RUNTIME_PROFILE: FullLinuxRuntimeProfile = {
  workspacePath: "/workspace",
  artifactMode: 0o640,
  persistentPaths: {
    runtimeDirectory: "/workspace/.waterbox",
    cliPath: "/workspace/.waterbox/waterbox-cli.js",
    launcherPath: "/workspace/.waterbox/waterbox",
    manifestPath: "/workspace/.waterbox/manifest.json",
    workspace: "/workspace",
  },
  ephemeralPaths: {
    uploadStagingDirectory: "/tmp",
    jobsDirectory: "/run/waterbox/bash-jobs",
  },
  requires: ["node-24", "rg", "absolute-workspace", "persistent-files", "detached-jobs"],
  executableDiscovery: "PATH then adapter-validated absolute executable",
  privilegeStrategy: "adapter-provided non-interactive capability",
}

/** Safe default for full-Linux images where the command user owns these roots. */
export const DEFAULT_RUNTIME_PATH_PROVISIONER: RuntimePathProvisioner = {
  provision(profile) {
    return [
      `install -d -m 0755 ${quotePosixShellWord(profile.persistentPaths.runtimeDirectory)}`,
      `install -d -m 0700 ${quotePosixShellWord(profile.ephemeralPaths.jobsDirectory)}`,
      `test -d ${quotePosixShellWord(profile.workspacePath)}`,
    ].join("\n")
  },
  launch(profile) {
    return `node ${quotePosixShellWord(profile.persistentPaths.cliPath)} "$@"`
  },
}

export function isJsonReference(value: JsonValue): value is JsonReference {
  if (value === null) return false
  if (typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object") return false
  if (Array.isArray(value)) return value.every(isJsonReference)
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  return Object.values(value).every(isJsonReference)
}

export function assertJsonReference(value: JsonValue): asserts value is JsonReference {
  if (!isJsonReference(value)) throw new TypeError("Provider reference must be non-null JSON")
}

export function assertCreateInput(input: InfrastructureCreateInput): void {
  if (input.sourceSnapshotRef !== undefined) assertJsonReference(input.sourceSnapshotRef)
  if (input.idempotencyKey.length === 0 || input.idempotencyKey.includes("\u0000")) throw new TypeError("Create identity is invalid")
}

/** Quote one interpolated POSIX shell word without relying on provider transport escaping. */
export function quotePosixShellWord(value: string): string {
  if (value.includes("\u0000")) throw new TypeError("Shell word is invalid")
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function assertCommandInput(input: InfrastructureCommandInput): void {
  assertJsonReference(input.providerRef)
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_COMMAND_TIMEOUT_MS) throw new TypeError("Command timeout must be bounded")
  if (input.script.length === 0 || new TextEncoder().encode(input.script).byteLength > MAX_COMMAND_SCRIPT_BYTES || input.script.includes("\u0000")) throw new TypeError("Command script is invalid")
  if (input.cwd !== undefined && (!input.cwd.startsWith("/") || input.cwd.includes("\u0000"))) throw new TypeError("Command working directory is invalid")
  for (const [name, value] of Object.entries(input.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\u0000")) throw new TypeError("Command environment is invalid")
  }
  for (const limit of [input.maxStdoutBytes, input.maxStderrBytes]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_COMMAND_OUTPUT_BYTES)) {
      throw new TypeError("Command output limit is invalid")
    }
  }
}

export function assertCommandResult(result: InfrastructureCommandResult, input: InfrastructureCommandInput): void {
  const stdoutLimit = input.maxStdoutBytes ?? MAX_COMMAND_OUTPUT_BYTES
  const stderrLimit = input.maxStderrBytes ?? MAX_COMMAND_OUTPUT_BYTES
  if (!(result.stdout instanceof Uint8Array) || !(result.stderr instanceof Uint8Array)
    || typeof result.timedOut !== "boolean" || typeof result.stdoutTruncated !== "boolean" || typeof result.stderrTruncated !== "boolean"
    || (result.exitCode !== null && (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0))
    || result.stdout.byteLength > stdoutLimit || result.stderr.byteLength > stderrLimit) {
    throw new TypeError("Command result is not bounded")
  }
}

export function assertWriteFileInput(input: InfrastructureWriteFileInput): void {
  assertJsonReference(input.providerRef)
  if (!(input.contents instanceof Uint8Array) || !input.path.startsWith("/") || input.path.includes("\u0000") || input.contents.byteLength > MAX_FILE_BYTES) {
    throw new TypeError("Trusted file write is invalid")
  }
  if (input.mode !== undefined && (!Number.isSafeInteger(input.mode) || input.mode < 0 || input.mode > 0o777)) {
    throw new TypeError("File mode is invalid")
  }
}

export { assertTerminalCommandConformance, assertTrustedWriteConformance, collectOwnedInventory, exerciseInfrastructureLifecycle } from "./conformance.ts"
export {
  WaterboxSandboxBackend,
  type RuntimeDiagnostic,
  type RuntimeDependencies,
  type SandboxRuntimeArtifact,
} from "./runtime.ts"
export { loadSandboxRuntimeArtifact, validateSandboxRuntimeArtifact } from "./artifact.ts"
