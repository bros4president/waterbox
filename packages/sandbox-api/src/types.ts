import type {
  CreateSandboxRequest,
  CreateSnapshotRequest,
  CursorPaginationRequest,
  Identity,
  Sandbox,
  SandboxId,
  SandboxPage,
  Snapshot,
  SnapshotId,
  SnapshotPage,
  ToolName,
} from "@waterbox/contracts"
import type { SandboxService } from "@waterbox/core"

export interface IdentityResolver {
  resolveBearer(credential: string, signal: AbortSignal): Promise<Identity | undefined>
}

/** The structural service surface used by the HTTP transport. */
export type WaterboxCore = Pick<SandboxService,
  | "createSandbox"
  | "getSandbox"
  | "listSandboxes"
  | "stopSandbox"
  | "resumeSandbox"
  | "deleteSandbox"
  | "createSnapshot"
  | "getSnapshot"
  | "listSnapshots"
  | "deleteSnapshot"
  | "initiateSecureFileTransfer"
  | "consumeSecureFileTransfer"
  | "executeTool"
>

export interface WaterboxApiDependencies {
  core: WaterboxCore
  identityResolver: IdentityResolver
  generateRequestId?: () => string
}

// Compile-time documentation of the service operations used above. These aliases keep
// transports from growing provider- or repository-specific dependencies.
export type CoreResourceTypes = {
  sandbox: Sandbox
  sandboxId: SandboxId
  sandboxes: SandboxPage
  snapshot: Snapshot
  snapshotId: SnapshotId
  snapshots: SnapshotPage
  createSandbox: CreateSandboxRequest
  createSnapshot: CreateSnapshotRequest
  pagination: CursorPaginationRequest
  toolName: ToolName
}
