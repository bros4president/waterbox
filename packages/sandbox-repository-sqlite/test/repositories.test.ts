import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IdempotencyRecord, SandboxRecord, SnapshotRecord } from "@waterbox/core/records"
import {
  MalformedRepositoryDocumentError,
  SQLITE_REPOSITORY_MAX_PAGE_LIMIT,
  SqliteRepositoryStore,
} from "../src/index.ts"

const stores: SqliteRepositoryStore[] = []
const directories: string[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

function store(filename = ":memory:"): SqliteRepositoryStore {
  const value = new SqliteRepositoryStore(filename)
  stores.push(value)
  return value
}

function sandbox(accountId = "acct-a", suffix = "1", version = 1): SandboxRecord {
  return {
    accountId,
    sandboxId: `sbx_calm-cactus-${suffix}`,
    provider: "fake",
    providerRef: { remote: suffix, nested: [true, null] },
    state: "running",
    version,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function snapshot(accountId = "acct-a", suffix = "1", version = 1): SnapshotRecord {
  return {
    accountId,
    snapshotId: `snap_silver-forest-${suffix}`,
    provider: "fake",
    providerRef: { remote: suffix },
    sourceSandboxId: `sbx_calm-cactus-${suffix}`,
    state: "ready",
    version,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function idempotency(accountId = "acct-a", suffix = "1", version = 1): IdempotencyRecord {
  return {
    accountId,
    scope: "sandbox:create",
    key: `request-${suffix}`,
    requestHash: `hash-${suffix}`,
    resourceId: `sbx_calm-cactus-${suffix}`,
    state: "completed",
    version,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
  }
}

describe("SQLite repository conformance", () => {
  test("sandbox port supports create, get, CAS, stale rejection, and list", async () => {
    const repository = store().sandboxes
    const initial = sandbox()
    expect(await repository.createIfAbsent(initial)).toBe(true)
    expect(await repository.createIfAbsent(initial)).toBe(false)
    expect(await repository.get(initial.accountId, initial.sandboxId)).toEqual(initial)

    const updated = { ...initial, state: "stopped" as const, version: 2, updatedAt: "2026-01-01T00:01:00.000Z" }
    expect(await repository.compareAndSwap(updated, 0)).toBe(false)
    expect(await repository.compareAndSwap(updated, 1)).toBe(true)
    expect(await repository.compareAndSwap({ ...updated, version: 3 }, 1)).toBe(false)
    expect((await repository.list({ accountId: "acct-a", limit: 10 })).items).toEqual([updated])
  })

  test("snapshot port supports create, get, CAS, and list", async () => {
    const repository = store().snapshots
    const initial = snapshot()
    expect(await repository.createIfAbsent(initial)).toBe(true)
    expect(await repository.createIfAbsent(initial)).toBe(false)
    const updated = { ...initial, state: "deleting" as const, version: 2 }
    expect(await repository.compareAndSwap(updated, 1)).toBe(true)
    expect(await repository.get("acct-a", initial.snapshotId)).toEqual(updated)
    expect((await repository.list({ accountId: "acct-a", limit: 1 })).items).toEqual([updated])
  })

  test("idempotency port persists expiry and supports create, get, and CAS", async () => {
    const repository = store().idempotency
    const initial = idempotency()
    const key = { accountId: initial.accountId, scope: initial.scope, key: initial.key }
    expect(await repository.createIfAbsent(initial)).toBe(true)
    expect(await repository.createIfAbsent(initial)).toBe(false)
    expect((await repository.get(key))?.expiresAt).toBe(initial.expiresAt)
    const updated = { ...initial, state: "failed" as const, version: 2, expiresAt: "2030-01-01T00:00:00.000Z" }
    expect(await repository.compareAndSwap(updated, 1)).toBe(true)
  })
})

describe("SQLite durability and isolation", () => {
  test("documents survive close and reopen and schema initialization is idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-sqlite-"))
    directories.push(directory)
    const filename = join(directory, "repository.sqlite")
    const first = store(filename)
    const record = sandbox()
    await first.sandboxes.createIfAbsent(record)
    first.close()
    stores.splice(stores.indexOf(first), 1)

    const second = store(filename)
    expect(await second.sandboxes.get(record.accountId, record.sandboxId)).toEqual(record)
    const thirdInitialization = new SqliteRepositoryStore(filename)
    thirdInitialization.close()
  })

  test("same resource keys coexist in isolated account partitions", async () => {
    const repositories = store()
    const first = sandbox("acct-a")
    const second = { ...sandbox("acct-b"), providerRef: { owner: "b" } }
    await repositories.sandboxes.createIfAbsent(first)
    await repositories.sandboxes.createIfAbsent(second)
    expect(await repositories.sandboxes.get("acct-a", first.sandboxId)).toEqual(first)
    expect(await repositories.sandboxes.get("acct-b", second.sandboxId)).toEqual(second)
    expect((await repositories.sandboxes.list({ accountId: "acct-a", limit: 10 })).items).toEqual([first])
    expect((await repositories.sandboxes.list({ accountId: "acct-b", limit: 10 })).items).toEqual([second])
  })
})

describe("SQLite pagination", () => {
  test("keyset pages have no duplicates or omissions over stable data", async () => {
    const repositories = store()
    const expected = ["1", "2", "3", "4", "5"].map((suffix) => sandbox("acct-a", suffix))
    for (const record of [...expected].reverse()) await repositories.sandboxes.createIfAbsent(record)

    const actual: SandboxRecord[] = []
    let cursor: string | undefined
    do {
      const page = await repositories.sandboxes.list({ accountId: "acct-a", limit: 2, ...(cursor ? { cursor } : {}) })
      actual.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    expect(actual).toEqual(expected)
    expect(new Set(actual.map((record) => record.sandboxId)).size).toBe(expected.length)
  })

  test("resource cursors contain only the canonical resource key and keep account filtering separate", async () => {
    const repositories = store()
    for (const suffix of ["1", "2"]) {
      await repositories.sandboxes.createIfAbsent(sandbox("acct-a", suffix))
      await repositories.snapshots.createIfAbsent(snapshot("acct-a", suffix))
      await repositories.sandboxes.createIfAbsent(sandbox("acct-b", suffix))
    }
    const pages = [
      await repositories.sandboxes.list({ accountId: "acct-a", limit: 1 }),
      await repositories.snapshots.list({ accountId: "acct-a", limit: 1 }),
    ]
    const continuationCalls = [
      (cursor: string) => repositories.sandboxes.list({ accountId: "acct-a", limit: 1, cursor }),
      (cursor: string) => repositories.snapshots.list({ accountId: "acct-a", limit: 1, cursor }),
    ]
    for (const [index, page] of pages.entries()) {
      expect(page.nextCursor).toBeString()
      const representation = Buffer.from(page.nextCursor!, "base64url").toString("utf8")
      expect(representation).toBe(JSON.stringify({ v: 1, after: index === 0 ? "sbx_calm-cactus-1" : "snap_silver-forest-1" }))
      expect((await continuationCalls[index]!(page.nextCursor!)).items).toHaveLength(1)
    }
    expect((await repositories.sandboxes.list({ accountId: "acct-b", limit: 1, cursor: pages[0]!.nextCursor })).items[0]?.accountId).toBe("acct-b")
    await expect(repositories.sandboxes.list({ accountId: "acct-a", limit: 1, cursor: "not-a-valid-cursor" })).rejects.toThrow("Invalid repository cursor")
    await expect(repositories.sandboxes.list({ accountId: "acct-a", limit: 1, cursor: pages[1]!.nextCursor })).rejects.toThrow("Invalid repository cursor")
    await expect(repositories.sandboxes.list({ accountId: "acct-a", limit: 0 })).rejects.toBeInstanceOf(RangeError)
    await expect(repositories.sandboxes.list({ accountId: "acct-a", limit: SQLITE_REPOSITORY_MAX_PAGE_LIMIT + 1 })).rejects.toBeInstanceOf(RangeError)
  })

  test("cursor decoding accepts only canonical unpadded base64url", async () => {
    const repositories = store()
    await repositories.sandboxes.createIfAbsent(sandbox("acct-a", "1"))
    await repositories.sandboxes.createIfAbsent(sandbox("acct-a", "2"))
    const canonical = (await repositories.sandboxes.list({ accountId: "acct-a", limit: 1 })).nextCursor!
    expect((await repositories.sandboxes.list({ accountId: "acct-a", limit: 1, cursor: canonical })).items).toHaveLength(1)

    for (const malformed of [
      `${canonical}!`,
      `${canonical} `,
      `${canonical}\n`,
      ` ${canonical}`,
      `${canonical}=`,
      `${canonical}==`,
    ]) {
      await expect(repositories.sandboxes.list({ accountId: "acct-a", limit: 1, cursor: malformed })).rejects.toThrow("Invalid repository cursor")
    }

    for (const payload of [
      { v: 1, after: "invalid" },
      { after: "sbx_calm-cactus-1", v: 1 },
      { v: 1, after: "sbx_calm-cactus-1", accountId: "acct-a" },
      { v: 2, after: "sbx_calm-cactus-1" },
    ]) {
      const malformed = Buffer.from(JSON.stringify(payload)).toString("base64url")
      await expect(repositories.sandboxes.list({ accountId: "acct-a", limit: 1, cursor: malformed })).rejects.toThrow("Invalid repository cursor")
    }

    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    if (canonical.length % 4 === 2 || canonical.length % 4 === 3) {
      const lastIndex = alphabet.indexOf(canonical.at(-1)!)
      const sameBytesAlias = `${canonical.slice(0, -1)}${alphabet[lastIndex | 1]}`
      expect(Buffer.from(sameBytesAlias, "base64url")).toEqual(Buffer.from(canonical, "base64url"))
      expect(sameBytesAlias).not.toBe(canonical)
      await expect(repositories.sandboxes.list({ accountId: "acct-a", limit: 1, cursor: sameBytesAlias })).rejects.toThrow("Invalid repository cursor")
    }
  })

  test("cursor continuation works after database close and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-sqlite-cursor-"))
    directories.push(directory)
    const filename = join(directory, "repository.sqlite")
    const first = store(filename)
    for (const suffix of ["1", "2", "3"]) await first.sandboxes.createIfAbsent(sandbox("acct-a", suffix))
    const firstPage = await first.sandboxes.list({ accountId: "acct-a", limit: 1 })
    first.close()
    stores.splice(stores.indexOf(first), 1)

    const reopened = store(filename)
    const secondPage = await reopened.sandboxes.list({ accountId: "acct-a", limit: 2, cursor: firstPage.nextCursor })
    expect(secondPage.items.map((record) => record.sandboxId)).toEqual(["sbx_calm-cactus-2", "sbx_calm-cactus-3"])
    expect(secondPage.nextCursor).toBeUndefined()
  })

})

describe("SQLite storage safety", () => {
  test("malformed stored JSON and structurally invalid documents fail explicitly", async () => {
    const repositories = store()
    repositories.database.query("INSERT INTO sandbox_documents VALUES (?, ?, ?, ?)")
      .run("acct-a", "sbx_calm-cactus-bad", 1, "{not-json")
    await expect(repositories.sandboxes.get("acct-a", "sbx_calm-cactus-bad")).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)

    repositories.database.query("INSERT INTO snapshot_documents VALUES (?, ?, ?, ?)")
      .run("acct-a", "snap_silver-forest-bad", 1, JSON.stringify({ accountId: "acct-a" }))
    await expect(repositories.snapshots.list({ accountId: "acct-a", limit: 10 })).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
  })

  test("sandbox documents enforce canonical provider, version, and error invariants", async () => {
    const repositories = store()
    const original = sandbox()
    await repositories.sandboxes.createIfAbsent(original)

    for (const corrupted of [
      { ...original, provider: "Fake" },
      { ...original, version: 0 },
      { ...original, lastError: { code: "provider_failure" as const, message: "" } },
      { ...original, lastError: { code: "provider_failure" as const, message: "x".repeat(2_001) } },
    ]) {
      repositories.database.query("UPDATE sandbox_documents SET version = ?, document = ? WHERE account_id = ? AND resource_id = ?")
        .run(corrupted.version, JSON.stringify(corrupted), original.accountId, original.sandboxId)
      await expect(repositories.sandboxes.get(original.accountId, original.sandboxId)).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
    }
  })

  test("snapshot documents enforce canonical name and description bounds", async () => {
    const repositories = store()
    const original = snapshot()
    await repositories.snapshots.createIfAbsent(original)

    for (const corrupted of [
      { ...original, name: "" },
      { ...original, name: "x".repeat(129) },
      { ...original, description: "x".repeat(2_001) },
    ]) {
      repositories.database.query("UPDATE snapshot_documents SET document = ? WHERE account_id = ? AND resource_id = ?")
        .run(JSON.stringify(corrupted), original.accountId, original.snapshotId)
      await expect(repositories.snapshots.get(original.accountId, original.snapshotId)).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
    }
  })

  test("idempotency documents require positive versions", async () => {
    const repositories = store()
    const original = idempotency()
    const corrupted = { ...original, version: 0 }
    await repositories.idempotency.createIfAbsent(original)
    repositories.database.query(`UPDATE idempotency_documents SET version = ?, document = ?
      WHERE account_id = ? AND scope = ? AND idempotency_key = ?`)
      .run(0, JSON.stringify(corrupted), original.accountId, original.scope, original.key)

    await expect(repositories.idempotency.get({
      accountId: original.accountId,
      scope: original.scope,
      key: original.key,
    })).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
  })

  test("sandbox get and list reject every SQL/document identity or version mismatch", async () => {
    const repositories = store()
    const original = sandbox()
    await repositories.sandboxes.createIfAbsent(original)
    for (const corrupted of [
      { ...original, accountId: "acct-b" },
      { ...original, sandboxId: "sbx_wrong-resource-id" },
      { ...original, version: 2 },
    ]) {
      repositories.database.query("UPDATE sandbox_documents SET document = ? WHERE account_id = ? AND resource_id = ?")
        .run(JSON.stringify(corrupted), original.accountId, original.sandboxId)
      await expect(repositories.sandboxes.get(original.accountId, original.sandboxId)).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
      await expect(repositories.sandboxes.list({ accountId: original.accountId, limit: 10 })).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
    }
  })

  test("snapshot get and list reject every SQL/document identity or version mismatch", async () => {
    const repositories = store()
    const original = snapshot()
    await repositories.snapshots.createIfAbsent(original)
    for (const corrupted of [
      { ...original, accountId: "acct-b" },
      { ...original, snapshotId: "snap_wrong-resource-id" },
      { ...original, version: 2 },
    ]) {
      repositories.database.query("UPDATE snapshot_documents SET document = ? WHERE account_id = ? AND resource_id = ?")
        .run(JSON.stringify(corrupted), original.accountId, original.snapshotId)
      await expect(repositories.snapshots.get(original.accountId, original.snapshotId)).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
      await expect(repositories.snapshots.list({ accountId: original.accountId, limit: 10 })).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
    }
  })

  test("idempotency get rejects every SQL/document key, version, or expiry mismatch", async () => {
    const repositories = store()
    const original = idempotency()
    const key = { accountId: original.accountId, scope: original.scope, key: original.key }
    await repositories.idempotency.createIfAbsent(original)
    for (const corrupted of [
      { ...original, accountId: "acct-b" },
      { ...original, scope: "different:scope" },
      { ...original, key: "different-key" },
      { ...original, version: 2 },
      { ...original, expiresAt: "2030-01-01T00:00:00.000Z" },
    ]) {
      repositories.database.query(`UPDATE idempotency_documents SET document = ?
        WHERE account_id = ? AND scope = ? AND idempotency_key = ?`)
        .run(JSON.stringify(corrupted), original.accountId, original.scope, original.key)
      await expect(repositories.idempotency.get(key)).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
    }
  })

  test("list query plans use the account-leading primary key instead of a cross-account scan", () => {
    const repositories = store()
    for (const [table, ordering] of [
      ["sandbox_documents", "resource_id"],
      ["snapshot_documents", "resource_id"],
    ] as const) {
      const plan = repositories.database.query<{ detail: string }, [string, number]>(
        `EXPLAIN QUERY PLAN SELECT document FROM ${table} WHERE account_id = ? ORDER BY ${ordering} LIMIT ?`,
      ).all("acct-a", 10)
      expect(plan.map((row) => row.detail).join(" ")).toContain("PRIMARY KEY (account_id=?)")
      expect(plan.map((row) => row.detail).join(" ")).not.toContain("SCAN")
    }
  })

  test("store close is idempotent and disposal closes the database", () => {
    const repositories = store()
    repositories.close()
    repositories.close()
    expect(() => repositories.database.query("SELECT 1").get()).toThrow()
  })
})
