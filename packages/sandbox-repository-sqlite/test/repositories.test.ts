import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IdempotencyRecord, SandboxRecord, SnapshotRecord } from "@waterbox/core/records"
import type { RepositoryDatabase } from "../src/database.ts"
import {
  IncompatibleRepositorySchemaError,
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
    providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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
    providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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
  }
}

const LEGACY_TABLES = ["sandbox_documents", "snapshot_documents", "idempotency_documents"] as const
type LegacyTable = typeof LEGACY_TABLES[number]

function createPrePolishRepository(
  filename: string,
  populated: boolean,
  tables: readonly LegacyTable[] = LEGACY_TABLES,
): void {
  const database = new Database(filename, { create: true })
  if (tables.includes("sandbox_documents")) database.exec(`CREATE TABLE sandbox_documents (
      account_id TEXT NOT NULL, resource_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL,
      PRIMARY KEY (account_id, resource_id)
    ) WITHOUT ROWID;`)
  if (tables.includes("snapshot_documents")) database.exec(`CREATE TABLE snapshot_documents (
      account_id TEXT NOT NULL, resource_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL,
      PRIMARY KEY (account_id, resource_id)
    ) WITHOUT ROWID;`)
  if (tables.includes("idempotency_documents")) database.exec(`CREATE TABLE idempotency_documents (
      account_id TEXT NOT NULL, scope TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      version INTEGER NOT NULL, expires_at TEXT NOT NULL, document TEXT NOT NULL,
      PRIMARY KEY (account_id, scope, idempotency_key)
    ) WITHOUT ROWID;`)
  if (populated) {
    const legacySandbox = JSON.stringify({
      accountId: "acct-legacy",
      sandboxId: "sbx_legacy",
      provider: "box",
      providerRef: { id: "remote-reference-must-stay-local" },
    })
    if (tables.includes("sandbox_documents")) database.query(`INSERT INTO sandbox_documents
      (account_id, resource_id, version, document) VALUES (?, ?, ?, ?)`)
      .run("acct-legacy", "sbx_legacy", 1, legacySandbox)
    const legacySnapshot = JSON.stringify({
      accountId: "acct-legacy",
      snapshotId: "snap_legacy",
      provider: "box",
      providerRef: { id: "remote-snapshot-must-stay-local" },
      sourceSandboxId: "sbx_legacy",
    })
    if (tables.includes("snapshot_documents")) database.query(`INSERT INTO snapshot_documents
      (account_id, resource_id, version, document) VALUES (?, ?, ?, ?)`)
      .run("acct-legacy", "snap_legacy", 1, legacySnapshot)
    const legacyIdempotency = JSON.stringify({
      accountId: "acct-legacy",
      scope: "sandbox:create",
      key: "legacy-request",
      requestHash: "legacy-hash",
      resourceId: "sbx_legacy",
    })
    if (tables.includes("idempotency_documents")) database.query(`INSERT INTO idempotency_documents
      (account_id, scope, idempotency_key, version, expires_at, document) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("acct-legacy", "sandbox:create", "legacy-request", 1, "2026-01-01T00:00:00.000Z", legacyIdempotency)
  }
  database.close()
}

function userTableNames(database: Database | RepositoryDatabase): string[] {
  return (database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[]).map((row) => row.name)
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

  test("idempotency port supports create, get, and CAS", async () => {
    const repository = store().idempotency
    const initial = idempotency()
    const key = { accountId: initial.accountId, scope: initial.scope, key: initial.key }
    expect(await repository.createIfAbsent(initial)).toBe(true)
    expect(await repository.createIfAbsent(initial)).toBe(false)
    expect(await repository.get(key)).toEqual(initial)
    const updated = { ...initial, state: "failed" as const, version: 2 }
    expect(await repository.compareAndSwap(updated, 1)).toBe(true)
  })
})

describe("atomic sandbox creation reservations", () => {
  test("owns a new sandbox and idempotency key in one transaction", async () => {
    const repositories = store()
    const candidate = sandbox("acct-a", "atomic")
    const reservation = { ...idempotency("acct-a", "atomic"), resourceId: candidate.sandboxId, state: "in_progress" as const }

    expect(await repositories.sandboxCreations.reserve({ sandbox: candidate, idempotency: reservation })).toEqual({ outcome: "new", reservation })
    expect(await repositories.sandboxes.get(candidate.accountId, candidate.sandboxId)).toEqual(candidate)
    expect(await repositories.idempotency.get({ accountId: reservation.accountId, scope: reservation.scope, key: reservation.key })).toEqual(reservation)
  })

  test("never publishes a colliding candidate as an idempotent reservation", async () => {
    const repositories = store()
    const occupied = sandbox("acct-a", "occupied")
    await repositories.sandboxes.createIfAbsent(occupied)
    const reservation = { ...idempotency("acct-a", "collision"), resourceId: occupied.sandboxId, state: "in_progress" as const }

    expect(await repositories.sandboxCreations.reserve({ sandbox: occupied, idempotency: reservation })).toEqual({ outcome: "candidate_collision" })
    expect(await repositories.idempotency.get({ accountId: reservation.accountId, scope: reservation.scope, key: reservation.key })).toBeUndefined()
  })

  test("concurrent same-key requests converge and preserve account-scoped IDs", async () => {
    const repositories = store()
    const first = sandbox("acct-a", "shared")
    const second = sandbox("acct-a", "other")
    const reservation = { ...idempotency("acct-a", "shared"), resourceId: first.sandboxId, state: "in_progress" as const }
    const duplicate = { ...reservation, resourceId: second.sandboxId }
    const [created, replay] = await Promise.all([
      repositories.sandboxCreations.reserve({ sandbox: first, idempotency: reservation }),
      repositories.sandboxCreations.reserve({ sandbox: second, idempotency: duplicate }),
    ])
    expect([created.outcome, replay.outcome].sort()).toEqual(["existing_match", "new"])
    expect(await repositories.sandboxes.get("acct-a", second.sandboxId)).toBeUndefined()

    const sameIdElsewhere = sandbox("acct-b", "shared")
    expect((await repositories.sandboxCreations.reserve({ sandbox: sameIdElsewhere })).outcome).toBe("new")
  })

  test("rejects a same key with a different request without creating its candidate", async () => {
    const repositories = store()
    const first = sandbox("acct-a", "original")
    const reservation = { ...idempotency("acct-a", "request"), resourceId: first.sandboxId, requestHash: "request-a", state: "in_progress" as const }
    await repositories.sandboxCreations.reserve({ sandbox: first, idempotency: reservation })
    const rejected = sandbox("acct-a", "rejected")
    const different = { ...reservation, resourceId: rejected.sandboxId, requestHash: "request-b" }
    expect((await repositories.sandboxCreations.reserve({ sandbox: rejected, idempotency: different })).outcome).toBe("request_mismatch")
    expect(await repositories.sandboxes.get("acct-a", rejected.sandboxId)).toBeUndefined()
  })
})

describe("SQLite durability and isolation", () => {
  test("a fresh database receives and reopens with the current schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-sqlite-fresh-"))
    directories.push(directory)
    const filename = join(directory, "repository.sqlite")
    const first = store(filename)
    expect(userTableNames(first.database)).toEqual([...LEGACY_TABLES].sort())
    expect(first.database.prepare("PRAGMA table_info(idempotency_documents)").all()
      .map((column) => column.name)).toEqual(["account_id", "scope", "idempotency_key", "version", "document"])
    first.close()
    stores.splice(stores.indexOf(first), 1)
    const reopened = store(filename)
    expect(reopened.database.prepare("SELECT count(*) AS count FROM sandbox_documents").get()).toEqual({ count: 0 })
  })

  test("a complete database with the current table structure opens without a schema marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-sqlite-unversioned-"))
    directories.push(directory)
    const filename = join(directory, "repository.sqlite")
    const database = new Database(filename, { create: true })
    database.exec(`
      CREATE TABLE sandbox_documents (
        account_id TEXT NOT NULL, resource_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY (account_id, resource_id)
      ) WITHOUT ROWID;
      CREATE TABLE snapshot_documents (
        account_id TEXT NOT NULL, resource_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY (account_id, resource_id)
      ) WITHOUT ROWID;
      CREATE TABLE idempotency_documents (
        account_id TEXT NOT NULL, scope TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        version INTEGER NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY (account_id, scope, idempotency_key)
      ) WITHOUT ROWID;
    `)
    database.close()

    const reopened = store(filename)
    expect(userTableNames(reopened.database)).toEqual([...LEGACY_TABLES].sort())
  })

  test("a partial current schema fails unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-sqlite-invalid-versioned-"))
    directories.push(directory)
    const partialFilename = join(directory, "partial-current.sqlite")
    const partialStore = store(partialFilename)
    partialStore.close()
    stores.splice(stores.indexOf(partialStore), 1)
    const partial = new Database(partialFilename)
    partial.exec("DROP TABLE snapshot_documents")
    partial.close()

    expect(() => new SqliteRepositoryStore(partialFilename)).toThrow(IncompatibleRepositorySchemaError)
    const unchangedPartial = new Database(partialFilename, { readonly: true })
    expect(userTableNames(unchangedPartial)).not.toContain("snapshot_documents")
    unchangedPartial.close()
  })

  test("an empty pre-polish database fails closed with path-specific reset guidance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-sqlite-legacy-empty-"))
    directories.push(directory)
    const filename = join(directory, "repository.sqlite")
    createPrePolishRepository(filename, false)

    let startupError: unknown
    try {
      new SqliteRepositoryStore(filename)
    } catch (error) {
      startupError = error
    }
    expect(startupError).toBeInstanceOf(IncompatibleRepositorySchemaError)
    expect(String(startupError)).toContain(filename)
    expect(String(startupError)).toContain("Clean up remote resources using the prior Waterbox build and provider configuration")
    expect(String(startupError)).toContain("move, remove, or reset this local database")
    expect(() => new SqliteRepositoryStore(filename, { readonly: true, create: false }))
      .toThrow(IncompatibleRepositorySchemaError)

    const unchanged = new Database(filename, { readonly: true })
    const legacyColumns = unchanged.query("PRAGMA table_info(idempotency_documents)").all() as { name: string }[]
    expect(legacyColumns.map((column) => column.name)).toContain("expires_at")
    unchanged.close()
  })

  test("a populated pre-polish database fails before exposing unbound records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-sqlite-legacy-populated-"))
    directories.push(directory)
    const filename = join(directory, "repository.sqlite")
    createPrePolishRepository(filename, true)

    let startupError: unknown
    try {
      new SqliteRepositoryStore(filename)
    } catch (error) {
      startupError = error
    }
    expect(startupError).toBeInstanceOf(IncompatibleRepositorySchemaError)
    expect(String(startupError)).toContain(filename)
    expect(String(startupError)).not.toContain("remote-reference-must-stay-local")

    const unchanged = new Database(filename, { readonly: true })
    expect(unchanged.query("SELECT count(*) AS count FROM sandbox_documents").get()).toEqual({ count: 1 })
    unchanged.close()
  })

  test("a representative populated partial legacy schema fails before creating missing tables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-sqlite-legacy-partial-"))
    directories.push(directory)
    const filename = join(directory, "repository.sqlite")
    const selected = ["sandbox_documents", "idempotency_documents"] as const
    createPrePolishRepository(filename, true, selected)

    expect(() => new SqliteRepositoryStore(filename)).toThrow(IncompatibleRepositorySchemaError)
    const unchanged = new Database(filename, { readonly: true })
    expect(userTableNames(unchanged)).toEqual([...selected].sort())
    for (const table of selected) {
      expect(unchanged.query(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 1 })
    }
    unchanged.close()
  })

  test("create false rejects a missing file without creating it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-sqlite-create-"))
    directories.push(directory)
    const filename = join(directory, "missing.sqlite")

    expect(() => new SqliteRepositoryStore(filename, { create: false })).toThrow("does not exist")
    expect(existsSync(filename)).toBe(false)
  })

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

  test("reconstruction never observes a reservation without its sandbox", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-sqlite-atomic-"))
    directories.push(directory)
    const filename = join(directory, "state.sqlite")
    const first = store(filename)
    const candidate = sandbox("acct-a", "reconstructed")
    const reservation = { ...idempotency("acct-a", "reconstructed"), resourceId: candidate.sandboxId, state: "in_progress" as const }
    await first.sandboxCreations.reserve({ sandbox: candidate, idempotency: reservation })
    first.close()
    stores.splice(stores.indexOf(first), 1)
    const reopened = store(filename)
    expect(await reopened.sandboxes.get(candidate.accountId, candidate.sandboxId)).toEqual(candidate)
    expect(await reopened.idempotency.get({ accountId: reservation.accountId, scope: reservation.scope, key: reservation.key })).toEqual(reservation)
  })

  test("an existing database can be reopened read-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-sqlite-readonly-"))
    directories.push(directory)
    const filename = join(directory, "repository.sqlite")
    const record = sandbox()
    const writable = store(filename)
    await writable.sandboxes.createIfAbsent(record)
    writable.close()
    stores.splice(stores.indexOf(writable), 1)

    const readOnly = new SqliteRepositoryStore(filename, { readonly: true, create: false })
    stores.push(readOnly)
    expect(await readOnly.sandboxes.get(record.accountId, record.sandboxId)).toEqual(record)
    await expect(readOnly.sandboxes.createIfAbsent(sandbox("acct-a", "2"))).rejects.toThrow()
  })

  test("foreign-key enforcement remains disabled", () => {
    const repositories = store()
    repositories.database.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));
      INSERT INTO child (parent_id) VALUES (1);
    `)
    expect(repositories.database.prepare("SELECT parent_id FROM child").get()).toEqual({ parent_id: 1 })
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
  test("binding predicates are applied before keyset pagination for sandboxes and snapshots", async () => {
    const repositories = store()
    const active = "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as const
    const inactive = "pcfg_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as const
    await repositories.sandboxes.createIfAbsent({ ...sandbox("acct-a", "a"), providerConfigurationId: active })
    await repositories.sandboxes.createIfAbsent({ ...sandbox("acct-a", "b"), providerConfigurationId: inactive })
    await repositories.sandboxes.createIfAbsent({ ...sandbox("acct-a", "c"), providerConfigurationId: active })
    await repositories.snapshots.createIfAbsent({ ...snapshot("acct-a", "a"), providerConfigurationId: active })
    await repositories.snapshots.createIfAbsent({ ...snapshot("acct-a", "b"), providerConfigurationId: inactive })
    await repositories.snapshots.createIfAbsent({ ...snapshot("acct-a", "c"), providerConfigurationId: active })

    const sandboxFirst = await repositories.sandboxes.list({ accountId: "acct-a", provider: "fake", providerConfigurationId: active, limit: 1 })
    const sandboxSecond = await repositories.sandboxes.list({ accountId: "acct-a", provider: "fake", providerConfigurationId: active, cursor: sandboxFirst.nextCursor, limit: 1 })
    const snapshotFirst = await repositories.snapshots.list({ accountId: "acct-a", provider: "fake", providerConfigurationId: active, limit: 1 })
    const snapshotSecond = await repositories.snapshots.list({ accountId: "acct-a", provider: "fake", providerConfigurationId: active, cursor: snapshotFirst.nextCursor, limit: 1 })

    expect([sandboxFirst.items[0]?.sandboxId, sandboxSecond.items[0]?.sandboxId]).toEqual(["sbx_calm-cactus-a", "sbx_calm-cactus-c"])
    expect([snapshotFirst.items[0]?.snapshotId, snapshotSecond.items[0]?.snapshotId]).toEqual(["snap_silver-forest-a", "snap_silver-forest-c"])
    expect(sandboxSecond.nextCursor).toBeUndefined()
    expect(snapshotSecond.nextCursor).toBeUndefined()
  })

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
    repositories.database.prepare("INSERT INTO sandbox_documents VALUES (?, ?, ?, ?)")
      .run("acct-a", "sbx_calm-cactus-bad", 1, "{not-json")
    await expect(repositories.sandboxes.get("acct-a", "sbx_calm-cactus-bad")).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)

    repositories.database.prepare("INSERT INTO snapshot_documents VALUES (?, ?, ?, ?)")
      .run("acct-a", "snap_silver-forest-bad", 1, JSON.stringify({ accountId: "acct-a" }))
    await expect(repositories.snapshots.list({ accountId: "acct-a", limit: 10 })).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
  })

  test("sandbox documents enforce canonical provider, version, and error invariants", async () => {
    const repositories = store()
    const original = sandbox()
    await repositories.sandboxes.createIfAbsent(original)

    for (const corrupted of [
      { ...original, provider: "Fake" },
      (() => { const { providerConfigurationId: _binding, ...legacy } = original; return legacy })(),
      { ...original, version: 0 },
      { ...original, lastError: { code: "provider_failure" as const, message: "" } },
      { ...original, lastError: { code: "provider_failure" as const, message: "x".repeat(2_001) } },
    ]) {
      repositories.database.prepare("UPDATE sandbox_documents SET version = ?, document = ? WHERE account_id = ? AND resource_id = ?")
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
      repositories.database.prepare("UPDATE snapshot_documents SET document = ? WHERE account_id = ? AND resource_id = ?")
        .run(JSON.stringify(corrupted), original.accountId, original.snapshotId)
      await expect(repositories.snapshots.get(original.accountId, original.snapshotId)).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
    }
  })

  test("idempotency documents require positive versions", async () => {
    const repositories = store()
    const original = idempotency()
    const corrupted = { ...original, version: 0 }
    await repositories.idempotency.createIfAbsent(original)
    repositories.database.prepare(`UPDATE idempotency_documents SET version = ?, document = ?
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
      repositories.database.prepare("UPDATE sandbox_documents SET document = ? WHERE account_id = ? AND resource_id = ?")
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
      repositories.database.prepare("UPDATE snapshot_documents SET document = ? WHERE account_id = ? AND resource_id = ?")
        .run(JSON.stringify(corrupted), original.accountId, original.snapshotId)
      await expect(repositories.snapshots.get(original.accountId, original.snapshotId)).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
      await expect(repositories.snapshots.list({ accountId: original.accountId, limit: 10 })).rejects.toBeInstanceOf(MalformedRepositoryDocumentError)
    }
  })

  test("idempotency get rejects every SQL/document key or version mismatch", async () => {
    const repositories = store()
    const original = idempotency()
    const key = { accountId: original.accountId, scope: original.scope, key: original.key }
    await repositories.idempotency.createIfAbsent(original)
    for (const corrupted of [
      { ...original, accountId: "acct-b" },
      { ...original, scope: "different:scope" },
      { ...original, key: "different-key" },
      { ...original, version: 2 },
    ]) {
      repositories.database.prepare(`UPDATE idempotency_documents SET document = ?
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
      const plan = repositories.database.prepare(
        `EXPLAIN QUERY PLAN SELECT document FROM ${table} WHERE account_id = ? ORDER BY ${ordering} LIMIT ?`,
      ).all("acct-a", 10) as Array<{ detail: string }>
      expect(plan.map((row) => row.detail).join(" ")).toContain("PRIMARY KEY (account_id=?)")
      expect(plan.map((row) => row.detail).join(" ")).not.toContain("SCAN")
    }
  })

  test("store close is idempotent and disposal closes the database", () => {
    const repositories = store()
    repositories.close()
    repositories.close()
    expect(() => repositories.database.prepare("SELECT 1").get()).toThrow()
  })
})
