import { describe, expect, test } from "bun:test"
import type { SandboxId, SnapshotId } from "@waterbox/contracts"
import {
  InMemoryIdempotencyRepository,
  InMemorySandboxRepository,
  InMemorySnapshotRepository,
} from "@waterbox/core/test-support"
import type { IdempotencyRecord, SandboxRecord, SnapshotRecord } from "@waterbox/core/records"

const timestamp = "2026-01-01T00:00:00.000Z"

describe("Dynamo-shaped in-memory repositories", () => {
  test("sandbox create/get/list/CAS are account scoped", async () => {
    const repository = new InMemorySandboxRepository()
    const id = "sbx_calm-cactus-a1" as SandboxId
    const alice = sandbox("alice", id)
    const bob = sandbox("bob", id)

    expect(await repository.createIfAbsent(alice)).toBe(true)
    expect(await repository.createIfAbsent(alice)).toBe(false)
    expect(await repository.createIfAbsent(bob)).toBe(true)
    expect((await repository.list({ accountId: "alice", limit: 10 })).items).toHaveLength(1)
    expect(await repository.compareAndSwap({ ...alice, state: "stopped", version: 2 }, 1)).toBe(true)
    expect(await repository.get("bob", id)).toEqual(bob)
  })

  test("snapshot create/get/list/CAS are account scoped", async () => {
    const repository = new InMemorySnapshotRepository()
    const id = "snap_silver-forest-a1" as SnapshotId
    const record = snapshot("alice", id)

    expect(await repository.createIfAbsent(record)).toBe(true)
    expect(await repository.createIfAbsent(record)).toBe(false)
    expect((await repository.list({ accountId: "bob", limit: 10 })).items).toHaveLength(0)
    expect(await repository.compareAndSwap({ ...record, state: "deleted", version: 2 }, 1)).toBe(true)
  })

  test("idempotency create/get/CAS use account, scope, and key", async () => {
    const repository = new InMemoryIdempotencyRepository()
    const record: IdempotencyRecord = {
      accountId: "alice",
      scope: "sandbox:create",
      key: "same",
      requestHash: "sha256:a",
      resourceId: "sbx_calm-cactus-a1",
      state: "in_progress",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp,
    }
    const other = { ...record, accountId: "bob" }

    expect(await repository.createIfAbsent(record)).toBe(true)
    expect(await repository.createIfAbsent(other)).toBe(true)
    expect(await repository.compareAndSwap({ ...record, state: "completed", version: 2 }, 1)).toBe(true)
    expect(await repository.get({ accountId: "bob", scope: other.scope, key: other.key })).toEqual(other)
  })
})

function sandbox(accountId: string, sandboxId: SandboxId): SandboxRecord {
  return {
    accountId,
    sandboxId,
    provider: "fake",
    providerRef: null,
    state: "running",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function snapshot(accountId: string, snapshotId: SnapshotId): SnapshotRecord {
  return {
    accountId,
    snapshotId,
    provider: "fake",
    providerRef: null,
    sourceSandboxId: "sbx_calm-cactus-a1",
    state: "ready",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}
