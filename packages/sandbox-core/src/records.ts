import type {
  ErrorCode,
  SandboxId,
  SandboxState,
  ProviderConfigurationId,
  SnapshotId,
  SnapshotState,
} from "@waterbox/contracts"

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface ResourceErrorRecord {
  code: ErrorCode
  message: string
}

export interface SandboxRecord {
  accountId: string
  sandboxId: SandboxId
  provider: string
  providerConfigurationId: ProviderConfigurationId
  providerRef: JsonValue
  state: SandboxState
  sourceSnapshotId?: SnapshotId
  version: number
  createdAt: string
  updatedAt: string
  lastError?: ResourceErrorRecord
}

export interface SnapshotRecord {
  accountId: string
  snapshotId: SnapshotId
  name?: string
  description?: string
  provider: string
  providerConfigurationId: ProviderConfigurationId
  providerRef: JsonValue
  sourceSandboxId: SandboxId
  state: SnapshotState
  version: number
  createdAt: string
  updatedAt: string
  lastError?: ResourceErrorRecord
}

export type IdempotencyState = "in_progress" | "completed" | "failed"

export interface IdempotencyRecord {
  accountId: string
  scope: string
  key: string
  requestHash: string
  resourceId: SandboxId
  state: IdempotencyState
  version: number
  createdAt: string
  updatedAt: string
  lastError?: ResourceErrorRecord
}
