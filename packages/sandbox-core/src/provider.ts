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
  ToolEventByName,
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

export type ProviderErrorKind = "failure" | "limit" | "ambiguous_execution" | "expired" | "consumed"

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind

  constructor(kind: ProviderErrorKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ProviderError"
    this.kind = kind
  }
}

export interface SandboxProvider {
  readonly name: string
  createSandbox(input: ProviderCreateSandboxInput): Promise<ProviderSandboxObservation>
  prepareSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  inspectSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  deleteSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  executeTool<N extends ToolName>(input: ProviderExecuteInput<N>): AsyncIterable<ToolEventByName[N]>
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
