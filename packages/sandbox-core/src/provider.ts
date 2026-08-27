import type {
  BashToolArguments,
  BashToolEvent,
  EditToolArguments,
  EditToolEvent,
  GlobToolArguments,
  GlobToolEvent,
  GrepToolArguments,
  GrepToolEvent,
  PatchToolArguments,
  PatchToolEvent,
  ReadToolArguments,
  ReadToolEvent,
  SandboxId,
  SandboxState,
  SnapshotId,
  SnapshotState,
  ToolName,
  WriteToolArguments,
  WriteToolEvent,
} from "@waterbox/contracts"
import type { JsonValue } from "./records.ts"

export interface ToolArgumentsByName {
  read: ReadToolArguments
  write: WriteToolArguments
  edit: EditToolArguments
  patch: PatchToolArguments
  glob: GlobToolArguments
  grep: GrepToolArguments
  bash: BashToolArguments
}

export interface ToolEventByName {
  read: ReadToolEvent
  write: WriteToolEvent
  edit: EditToolEvent
  patch: PatchToolEvent
  glob: GlobToolEvent
  grep: GrepToolEvent
  bash: BashToolEvent
}

export interface ProviderSandboxObservation {
  state: SandboxState
  providerRef: JsonValue
}

export interface ProviderSnapshotObservation {
  state: SnapshotState
  providerRef: JsonValue
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

export type ProviderErrorKind = "failure" | "limit" | "ambiguous_execution"

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
}
