import type { SandboxId, SnapshotId } from "@waterbox/contracts"
import type { IdempotencyRecord, SandboxRecord, SnapshotRecord } from "./records.ts"

export type OpaqueCursor = string

export interface RepositoryPage<T> {
  items: T[]
  nextCursor?: OpaqueCursor
}

export interface ListRepositoryInput {
  accountId: string
  cursor?: OpaqueCursor
  limit: number
}

export interface SandboxRepository {
  createIfAbsent(record: SandboxRecord): Promise<boolean>
  get(accountId: string, sandboxId: SandboxId): Promise<SandboxRecord | undefined>
  list(input: ListRepositoryInput): Promise<RepositoryPage<SandboxRecord>>
  compareAndSwap(record: SandboxRecord, expectedVersion: number): Promise<boolean>
}

export interface SnapshotRepository {
  createIfAbsent(record: SnapshotRecord): Promise<boolean>
  get(accountId: string, snapshotId: SnapshotId): Promise<SnapshotRecord | undefined>
  list(input: ListRepositoryInput): Promise<RepositoryPage<SnapshotRecord>>
  compareAndSwap(record: SnapshotRecord, expectedVersion: number): Promise<boolean>
}

export interface IdempotencyKey {
  accountId: string
  scope: string
  key: string
}

export interface IdempotencyRepository {
  createIfAbsent(record: IdempotencyRecord): Promise<boolean>
  get(input: IdempotencyKey): Promise<IdempotencyRecord | undefined>
  compareAndSwap(record: IdempotencyRecord, expectedVersion: number): Promise<boolean>
}

export interface Clock {
  now(): Date
}

export interface ReadableIdGenerator {
  sandboxId(): string
  snapshotId(): string
}
