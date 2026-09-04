import type {
  BashJobObservation,
  SecureTransferConsumeRequest,
  SecureTransferDelivered,
  SecureTransferId,
  SecureTransferInitiated,
  SandboxId,
  SandboxState,
  SnapshotId,
  SnapshotState,
  ToolName,
  ToolArgumentsByName,
  ToolResultByName,
} from "@waterbox/contracts"
import type { JsonValue } from "./records.ts"

export interface ProviderSandboxObservation {
  state: SandboxState
  providerRef: JsonValue
}

export interface ProviderSnapshotObservation {
  state: SnapshotState
  providerRef: JsonValue
  /** Optional exact source observation after native snapshot dispatch. */
  sourceSandbox?: ProviderSandboxObservation
}

/**
 * A provider may attach an exact, resource-scoped observation to a rejected
 * operation.  This deliberately carries no transport status or response body:
 * adapters translate those details before crossing the provider boundary.
 */
export type ProviderKnownObservation =
  | { resource: "sandbox"; observation: ProviderSandboxObservation }
  | { resource: "snapshot"; observation: ProviderSnapshotObservation }

export interface ProviderOperationInput {
  accountId: string
  providerRef: JsonValue
  signal: AbortSignal
}

export interface ProviderCreateSandboxInput {
  accountId: string
  sandboxId: SandboxId
  sourceSnapshotRef?: JsonValue
  idempotencyKey: string
  signal: AbortSignal
}

export interface ProviderCreateSnapshotInput {
  accountId: string
  snapshotId: SnapshotId
  sandboxRef: JsonValue
  signal: AbortSignal
}

export interface ProviderSnapshotOperationInput extends ProviderOperationInput {
  snapshotId: SnapshotId
}

export interface ProviderExecuteInput<N extends ToolName = ToolName> extends ProviderOperationInput {
  toolName: N
  arguments: ToolArgumentsByName[N]
}

export interface ProviderObserveBashJobInput extends ProviderOperationInput {
  jobId: string
  offset: number
  maxBytes: number
}

export interface ProviderCleanupBashJobInput extends ProviderOperationInput {
  jobId: string
}

export interface ProviderConsumeSecureTransferInput extends ProviderOperationInput, SecureTransferConsumeRequest {
  transferId: SecureTransferId
}

/**
 * Existing-resource lifecycle adapters use `failure` and `limit` only when
 * they can prove that the requested mutation did not execute. Any transport
 * loss, 5xx response, or invalid result after dispatch is
 * `ambiguous_execution`. `known_state` and `exact_absence` communicate an
 * exact observation, but do not by themselves establish dispatch certainty.
 */
export type ProviderErrorKind = "failure" | "limit" | "ambiguous_execution" | "expired" | "consumed" | "known_state" | "exact_absence"

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly knownObservation?: ProviderKnownObservation

  constructor(kind: ProviderErrorKind, message: string, options?: ErrorOptions & { knownObservation?: ProviderKnownObservation }) {
    super(message, options)
    this.name = "ProviderError"
    this.kind = kind
    this.knownObservation = options?.knownObservation
  }
}

export interface SandboxProvider {
  readonly name: string
  createSandbox(input: ProviderCreateSandboxInput): Promise<ProviderSandboxObservation>
  prepareSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  inspectSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  deleteSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  executeTool<N extends ToolName>(input: ProviderExecuteInput<N>): Promise<ToolResultByName[N]>
  readonly stopResume?: {
    stop(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
    resume(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  }
  readonly snapshots?: {
    create(input: ProviderCreateSnapshotInput): Promise<ProviderSnapshotObservation>
    inspect(input: ProviderSnapshotOperationInput): Promise<ProviderSnapshotObservation>
    delete(input: ProviderSnapshotOperationInput): Promise<ProviderSnapshotObservation>
  }
  readonly secureFileTransfer?: {
    initiate(input: ProviderOperationInput): Promise<SecureTransferInitiated>
    consume(input: ProviderConsumeSecureTransferInput): Promise<SecureTransferDelivered>
  }
  readonly bashJobs?: {
    observe(input: ProviderObserveBashJobInput): Promise<BashJobObservation>
    cleanup(input: ProviderCleanupBashJobInput): Promise<void>
  }
}
