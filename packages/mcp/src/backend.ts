import type {
  CreateSandboxRequest,
  CreateSnapshotRequest,
  CursorPaginationRequest,
  Sandbox,
  SandboxId,
  Snapshot,
  SnapshotId,
  SnapshotPage,
  SecureTransferConsumeRequest,
  SecureTransferDelivered,
  SecureTransferId,
  SecureTransferInitiated,
  ToolName,
} from "@waterbox/contracts"
import type { ToolArgumentsByName, ToolEventByName } from "@waterbox/core/provider"
import type { BashJobObservation } from "@waterbox/core/provider"

export interface McpBackend {
  createSandbox(request: CreateSandboxRequest, idempotencyKey: string, signal: AbortSignal): Promise<Sandbox>
  probeSandbox(sandboxId: SandboxId, signal: AbortSignal): Promise<Sandbox>
  deleteSandbox(sandboxId: SandboxId, signal: AbortSignal): Promise<Sandbox>
  listSnapshots(request: CursorPaginationRequest, signal: AbortSignal): Promise<SnapshotPage>
  createSnapshot(sandboxId: SandboxId, request: CreateSnapshotRequest, signal: AbortSignal): Promise<Snapshot>
  deleteSnapshot(snapshotId: SnapshotId, signal: AbortSignal): Promise<Snapshot>
  initiateSecureFileTransfer(sandboxId: SandboxId, signal: AbortSignal): Promise<SecureTransferInitiated>
  consumeSecureFileTransfer(sandboxId: SandboxId, transferId: SecureTransferId, request: SecureTransferConsumeRequest, signal: AbortSignal): Promise<SecureTransferDelivered>
  executeTool<N extends ToolName>(
    sandboxId: SandboxId,
    toolName: N,
    arguments_: ToolArgumentsByName[N],
    signal: AbortSignal,
  ): Promise<AsyncIterable<ToolEventByName[N]>>
  observeBashJob?(sandboxId: SandboxId, jobId: string, offset: number, maxBytes: number, signal: AbortSignal): Promise<BashJobObservation>
  cleanupBashJob?(sandboxId: SandboxId, jobId: string, signal: AbortSignal): Promise<void>
  close(): Promise<void>
}
