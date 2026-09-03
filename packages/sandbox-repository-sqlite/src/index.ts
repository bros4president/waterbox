import { existsSync } from "node:fs"
import { openRepositoryDatabase } from "@waterbox/repository-sqlite/database"
import type { RepositoryDatabase } from "./database.ts"
import {
  ErrorCodeSchema,
  ProviderNameSchema,
  ProviderConfigurationIdSchema,
  SandboxIdSchema,
  SandboxStateSchema,
  SnapshotIdSchema,
  SnapshotStateSchema,
} from "@waterbox/contracts"
import type {
  IdempotencyKey,
  IdempotencyRepository,
  ListRepositoryInput,
  RepositoryPage,
  SandboxCreationRepository,
  SandboxCreationReservation,
  SandboxRepository,
  SnapshotRepository,
} from "@waterbox/core/ports"
import type { IdempotencyRecord, JsonValue, SandboxRecord, SnapshotRecord } from "@waterbox/core/records"
import { z } from "zod"

export const SQLITE_REPOSITORY_MAX_PAGE_LIMIT = 100

export class MalformedRepositoryDocumentError extends Error {
  constructor(readonly table: string, readonly accountId: string, readonly resourceKey: string, cause?: unknown) {
    super(`Malformed ${table} repository document for account/resource key`, { cause })
    this.name = "MalformedRepositoryDocumentError"
  }
}

export class IncompatibleRepositorySchemaError extends Error {
  constructor(readonly filename: string) {
    super(
      `Incompatible Waterbox SQLite schema at ${filename}. Clean up remote resources using the prior Waterbox build and provider configuration, then move, remove, or reset this local database before starting the current build.`,
    )
    this.name = "IncompatibleRepositorySchemaError"
  }
}

const JsonValueSchema: z.ZodType<JsonValue> = z.json()
const ResourceErrorSchema = z.object({ code: ErrorCodeSchema, message: z.string().min(1).max(2_000) }).strict()
const BaseRecordSchema = z.object({
  accountId: z.string().min(1),
  provider: ProviderNameSchema,
  providerConfigurationId: ProviderConfigurationIdSchema,
  providerRef: JsonValueSchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastError: ResourceErrorSchema.optional(),
})
const SandboxRecordSchema = BaseRecordSchema.extend({
  sandboxId: SandboxIdSchema,
  state: SandboxStateSchema,
  sourceSnapshotId: SnapshotIdSchema.optional(),
}).strict()
const SnapshotRecordSchema = BaseRecordSchema.extend({
  snapshotId: SnapshotIdSchema,
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2_000).optional(),
  sourceSandboxId: SandboxIdSchema,
  state: SnapshotStateSchema,
}).strict()
const IdempotencyRecordSchema = z.object({
  accountId: z.string().min(1),
  scope: z.string().min(1),
  key: z.string().min(1),
  requestHash: z.string().min(1),
  resourceId: SandboxIdSchema,
  state: z.enum(["in_progress", "completed", "failed"]),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastError: ResourceErrorSchema.optional(),
}).strict()

type ResourceDocumentRow = { account_id: string; resource_id: string; version: number; document: string }
type IdempotencyDocumentRow = {
  account_id: string
  scope: string
  idempotency_key: string
  version: number
  document: string
}
type CursorPayload = { v: 1; after: string }
type TableColumnRow = { name: string; type: string; notnull: number | bigint; pk: number | bigint }
type TableListRow = { name: string; ncol: number | bigint; wr: number | bigint; strict: number | bigint }
type SchemaVersionRow = { singleton: number | bigint; schema_version: number | bigint }

const REPOSITORY_SCHEMA_VERSION = 1
const REPOSITORY_SCHEMA_TABLE = "waterbox_repository_schema"

const REPOSITORY_TABLE_COLUMNS = {
  [REPOSITORY_SCHEMA_TABLE]: [
    ["singleton", "INTEGER", 1, 1],
    ["schema_version", "INTEGER", 1, 0],
  ],
  sandbox_documents: [
    ["account_id", "TEXT", 1, 1],
    ["resource_id", "TEXT", 1, 2],
    ["version", "INTEGER", 1, 0],
    ["document", "TEXT", 1, 0],
  ],
  snapshot_documents: [
    ["account_id", "TEXT", 1, 1],
    ["resource_id", "TEXT", 1, 2],
    ["version", "INTEGER", 1, 0],
    ["document", "TEXT", 1, 0],
  ],
  idempotency_documents: [
    ["account_id", "TEXT", 1, 1],
    ["scope", "TEXT", 1, 2],
    ["idempotency_key", "TEXT", 1, 3],
    ["version", "INTEGER", 1, 0],
    ["document", "TEXT", 1, 0],
  ],
} as const

const REPOSITORY_DOCUMENT_TABLES = new Set([
  "sandbox_documents",
  "snapshot_documents",
  "idempotency_documents",
])

const CURSOR_FORMAT_VERSION = 1
class CursorCodec {
  encode(after: string): string {
    return Buffer.from(JSON.stringify({ v: CURSOR_FORMAT_VERSION, after } satisfies CursorPayload), "utf8").toString("base64url")
  }

  decode(cursor: string | undefined, schema: z.ZodType<string>): string | undefined {
    if (cursor === undefined) return undefined
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length % 4 === 1) throw new Error("Invalid encoding")
      const token = Buffer.from(cursor, "base64url")
      if (token.toString("base64url") !== cursor) throw new Error("Noncanonical encoding")
      const plaintext = token.toString("utf8")
      const parsed = z.object({
        v: z.literal(CURSOR_FORMAT_VERSION),
        after: schema,
      }).strict().parse(JSON.parse(plaintext))
      if (JSON.stringify(parsed) !== plaintext) throw new Error("Noncanonical JSON")
      return parsed.after
    } catch {
      throw new Error("Invalid repository cursor")
    }
  }
}

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > SQLITE_REPOSITORY_MAX_PAGE_LIMIT) {
    throw new RangeError(`Repository page limit must be an integer from 1 to ${SQLITE_REPOSITORY_MAX_PAGE_LIMIT}`)
  }
  return limit
}

function bindingClause(input: ListRepositoryInput): { sql: string; values: string[] } {
  if (input.provider === undefined && input.providerConfigurationId === undefined) return { sql: "", values: [] }
  if (input.provider === undefined || input.providerConfigurationId === undefined) {
    throw new RangeError("Repository provider binding requires both provider and configuration ID")
  }
  return {
    sql: " AND json_extract(document, '$.provider') = ? AND json_extract(document, '$.providerConfigurationId') = ?",
    values: [input.provider, input.providerConfigurationId],
  }
}

function parseDocument<T>(
  schema: z.ZodType<T>,
  table: string,
  accountId: string,
  resourceKey: string,
  row: { document: string } | undefined,
  verify: (record: T) => boolean,
): T | undefined {
  if (row === undefined) return undefined
  try {
    const record = schema.parse(JSON.parse(row.document))
    if (!verify(record)) throw new Error("Document disagrees with authoritative storage columns")
    return structuredClone(record)
  } catch (error) {
    throw new MalformedRepositoryDocumentError(table, accountId, resourceKey, error)
  }
}

function parseSandbox(row: ResourceDocumentRow | undefined, accountId: string, sandboxId: string): SandboxRecord | undefined {
  return parseDocument(SandboxRecordSchema, "sandbox", accountId, sandboxId, row, (record) =>
    row !== undefined
    && row.account_id === accountId
    && row.resource_id === sandboxId
    && record.accountId === row.account_id
    && record.sandboxId === row.resource_id
    && record.version === row.version)
}

function parseSnapshot(row: ResourceDocumentRow | undefined, accountId: string, snapshotId: string): SnapshotRecord | undefined {
  return parseDocument(SnapshotRecordSchema, "snapshot", accountId, snapshotId, row, (record) =>
    row !== undefined
    && row.account_id === accountId
    && row.resource_id === snapshotId
    && record.accountId === row.account_id
    && record.snapshotId === row.resource_id
    && record.version === row.version)
}

function parseIdempotency(
  row: IdempotencyDocumentRow | undefined,
  accountId: string,
  scope: string,
  key: string,
): IdempotencyRecord | undefined {
  return parseDocument(IdempotencyRecordSchema, "idempotency", accountId, `${scope}/${key}`, row, (record) =>
    row !== undefined
    && row.account_id === accountId
    && row.scope === scope
    && row.idempotency_key === key
    && record.accountId === row.account_id
    && record.scope === row.scope
    && record.key === row.idempotency_key
    && record.version === row.version)
}

function serialize(value: unknown): string {
  return JSON.stringify(value)
}

function hasCurrentRepositorySchema(database: RepositoryDatabase): boolean {
  const waterboxTables = waterboxTableNames(database)
  if (waterboxTables.size !== Object.keys(REPOSITORY_TABLE_COLUMNS).length
    || !Object.keys(REPOSITORY_TABLE_COLUMNS).every((table) => waterboxTables.has(table))) {
    return false
  }

  const tableList = database.prepare("PRAGMA table_list").all() as TableListRow[]
  const hasCurrentTables = Object.entries(REPOSITORY_TABLE_COLUMNS).every(([table, expected]) => {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as TableColumnRow[]
    if (columns.length !== expected.length) return false
    const definition = tableList.find((candidate) => candidate.name === table)
    if (definition === undefined
      || Number(definition.ncol) !== expected.length
      || Number(definition.wr) !== 1
      || Number(definition.strict) !== 0) return false
    return columns.every((column, index) => {
      const expectedColumn = expected[index]
      return expectedColumn !== undefined
        && column.name === expectedColumn[0]
        && column.type.toUpperCase() === expectedColumn[1]
        && Number(column.notnull) === expectedColumn[2]
        && Number(column.pk) === expectedColumn[3]
    })
  })
  if (!hasCurrentTables) return false

  const versions = database.prepare(
    `SELECT singleton, schema_version FROM ${REPOSITORY_SCHEMA_TABLE}`,
  ).all() as SchemaVersionRow[]
  return versions.length === 1
    && Number(versions[0]?.singleton) === 1
    && Number(versions[0]?.schema_version) === REPOSITORY_SCHEMA_VERSION
}

function waterboxTableNames(database: RepositoryDatabase): Set<string> {
  const rows = database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as { name: string }[]
  return new Set(rows
    .map((row) => row.name)
    .filter((name) => REPOSITORY_DOCUMENT_TABLES.has(name) || name.startsWith("waterbox_")))
}

function initializeFreshRepositorySchema(database: RepositoryDatabase): boolean {
  database.exec("BEGIN IMMEDIATE")
  try {
    // Reinspect while holding the write lock: another process may have initialized
    // the file after the constructor's first read.
    if (waterboxTableNames(database).size !== 0) {
      const current = hasCurrentRepositorySchema(database)
      database.exec("ROLLBACK")
      return current
    }
    database.exec(`
      CREATE TABLE ${REPOSITORY_SCHEMA_TABLE} (
        singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO ${REPOSITORY_SCHEMA_TABLE} (singleton, schema_version)
        VALUES (1, ${REPOSITORY_SCHEMA_VERSION});
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
    if (!hasCurrentRepositorySchema(database)) throw new Error("Failed to initialize Waterbox SQLite schema")
    database.exec("COMMIT")
    return true
  } catch (error) {
    try { database.exec("ROLLBACK") } catch {}
    throw error
  }
}

function ensureCurrentRepositorySchema(database: RepositoryDatabase): boolean {
  return waterboxTableNames(database).size === 0
    ? initializeFreshRepositorySchema(database)
    : hasCurrentRepositorySchema(database)
}

export class SqliteSandboxRepository implements SandboxRepository {
  constructor(private readonly database: RepositoryDatabase, private readonly cursors: CursorCodec) {}

  async createIfAbsent(record: SandboxRecord): Promise<boolean> {
    const result = this.database.prepare(`INSERT OR IGNORE INTO sandbox_documents
      (account_id, resource_id, version, document) VALUES (?, ?, ?, ?)`)
      .run(record.accountId, record.sandboxId, record.version, serialize(record))
    return result.changes === 1
  }

  async get(accountId: string, sandboxId: SandboxRecord["sandboxId"]): Promise<SandboxRecord | undefined> {
    const row = this.database.prepare(
      "SELECT account_id, resource_id, version, document FROM sandbox_documents WHERE account_id = ? AND resource_id = ?",
    ).get(accountId, sandboxId) as ResourceDocumentRow | undefined
    return parseSandbox(row ?? undefined, accountId, sandboxId)
  }

  async list(input: ListRepositoryInput): Promise<RepositoryPage<SandboxRecord>> {
    const limit = boundedLimit(input.limit)
    const after = this.cursors.decode(input.cursor, SandboxIdSchema)
    const binding = bindingClause(input)
    const rows = after === undefined
      ? this.database.prepare(
          `SELECT account_id, resource_id, version, document FROM sandbox_documents WHERE account_id = ?${binding.sql} ORDER BY resource_id LIMIT ?`,
        ).all(input.accountId, ...binding.values, limit + 1) as ResourceDocumentRow[]
      : this.database.prepare(
          `SELECT account_id, resource_id, version, document FROM sandbox_documents WHERE account_id = ?${binding.sql} AND resource_id > ? ORDER BY resource_id LIMIT ?`,
        ).all(input.accountId, ...binding.values, after, limit + 1) as ResourceDocumentRow[]
    const pageRows = rows.slice(0, limit)
    const items = pageRows.map((row) => parseSandbox(row, input.accountId, row.resource_id)!)
    const last = pageRows.at(-1)
    return { items, ...(rows.length > limit && last ? { nextCursor: this.cursors.encode(last.resource_id) } : {}) }
  }

  async compareAndSwap(record: SandboxRecord, expectedVersion: number): Promise<boolean> {
    if (record.version !== expectedVersion + 1) return false
    const result = this.database.prepare(`UPDATE sandbox_documents SET version = ?, document = ?
      WHERE account_id = ? AND resource_id = ? AND version = ?`)
      .run(record.version, serialize(record), record.accountId, record.sandboxId, expectedVersion)
    return result.changes === 1
  }

}

export class SqliteSnapshotRepository implements SnapshotRepository {
  constructor(private readonly database: RepositoryDatabase, private readonly cursors: CursorCodec) {}

  async createIfAbsent(record: SnapshotRecord): Promise<boolean> {
    return this.database.prepare(`INSERT OR IGNORE INTO snapshot_documents
      (account_id, resource_id, version, document) VALUES (?, ?, ?, ?)`)
      .run(record.accountId, record.snapshotId, record.version, serialize(record)).changes === 1
  }

  async get(accountId: string, snapshotId: SnapshotRecord["snapshotId"]): Promise<SnapshotRecord | undefined> {
    const row = this.database.prepare(
      "SELECT account_id, resource_id, version, document FROM snapshot_documents WHERE account_id = ? AND resource_id = ?",
    ).get(accountId, snapshotId) as ResourceDocumentRow | undefined
    return parseSnapshot(row ?? undefined, accountId, snapshotId)
  }

  async list(input: ListRepositoryInput): Promise<RepositoryPage<SnapshotRecord>> {
    const limit = boundedLimit(input.limit)
    const after = this.cursors.decode(input.cursor, SnapshotIdSchema)
    const binding = bindingClause(input)
    const rows = after === undefined
      ? this.database.prepare(
          `SELECT account_id, resource_id, version, document FROM snapshot_documents WHERE account_id = ?${binding.sql} ORDER BY resource_id LIMIT ?`,
        ).all(input.accountId, ...binding.values, limit + 1) as ResourceDocumentRow[]
      : this.database.prepare(
          `SELECT account_id, resource_id, version, document FROM snapshot_documents WHERE account_id = ?${binding.sql} AND resource_id > ? ORDER BY resource_id LIMIT ?`,
        ).all(input.accountId, ...binding.values, after, limit + 1) as ResourceDocumentRow[]
    const pageRows = rows.slice(0, limit)
    const items = pageRows.map((row) => parseSnapshot(row, input.accountId, row.resource_id)!)
    const last = pageRows.at(-1)
    return { items, ...(rows.length > limit && last ? { nextCursor: this.cursors.encode(last.resource_id) } : {}) }
  }

  async compareAndSwap(record: SnapshotRecord, expectedVersion: number): Promise<boolean> {
    if (record.version !== expectedVersion + 1) return false
    return this.database.prepare(`UPDATE snapshot_documents SET version = ?, document = ?
      WHERE account_id = ? AND resource_id = ? AND version = ?`)
      .run(record.version, serialize(record), record.accountId, record.snapshotId, expectedVersion).changes === 1
  }

}

export class SqliteIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async createIfAbsent(record: IdempotencyRecord): Promise<boolean> {
    return this.database.prepare(`INSERT OR IGNORE INTO idempotency_documents
      (account_id, scope, idempotency_key, version, document) VALUES (?, ?, ?, ?, ?)`)
      .run(record.accountId, record.scope, record.key, record.version, serialize(record)).changes === 1
  }

  async get(input: IdempotencyKey): Promise<IdempotencyRecord | undefined> {
    const row = this.database.prepare(
      `SELECT account_id, scope, idempotency_key, version, document
       FROM idempotency_documents WHERE account_id = ? AND scope = ? AND idempotency_key = ?`,
    ).get(input.accountId, input.scope, input.key) as IdempotencyDocumentRow | undefined
    return parseIdempotency(row ?? undefined, input.accountId, input.scope, input.key)
  }

  async compareAndSwap(record: IdempotencyRecord, expectedVersion: number): Promise<boolean> {
    if (record.version !== expectedVersion + 1) return false
    return this.database.prepare(`UPDATE idempotency_documents SET version = ?, document = ?
      WHERE account_id = ? AND scope = ? AND idempotency_key = ? AND version = ?`)
      .run(record.version, serialize(record), record.accountId, record.scope, record.key, expectedVersion).changes === 1
  }

}

/** SQLite's synchronous driver keeps this transaction free of provider I/O. */
export class SqliteSandboxCreationRepository implements SandboxCreationRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async reserve(input: { sandbox: SandboxRecord; idempotency?: IdempotencyRecord }): Promise<SandboxCreationReservation> {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      if (input.idempotency !== undefined) {
        const key = input.idempotency
        const row = this.database.prepare(
          "SELECT account_id, scope, idempotency_key, version, document FROM idempotency_documents WHERE account_id = ? AND scope = ? AND idempotency_key = ?",
        ).get(key.accountId, key.scope, key.key) as IdempotencyDocumentRow | undefined
        const existing = parseIdempotency(row ?? undefined, key.accountId, key.scope, key.key)
        if (existing !== undefined) {
          this.database.exec("COMMIT")
          return existing.requestHash === key.requestHash
            ? { outcome: "existing_match", reservation: existing }
            : { outcome: "request_mismatch", reservation: existing }
        }
      }
      const inserted = this.database.prepare(`INSERT OR IGNORE INTO sandbox_documents
        (account_id, resource_id, version, document) VALUES (?, ?, ?, ?)`)
        .run(input.sandbox.accountId, input.sandbox.sandboxId, input.sandbox.version, serialize(input.sandbox)).changes === 1
      if (!inserted) {
        this.database.exec("COMMIT")
        return { outcome: "candidate_collision" }
      }
      if (input.idempotency !== undefined) {
        const record = input.idempotency
        const insertedReservation = this.database.prepare(`INSERT OR ABORT INTO idempotency_documents
          (account_id, scope, idempotency_key, version, document) VALUES (?, ?, ?, ?, ?)`)
          .run(record.accountId, record.scope, record.key, record.version, serialize(record)).changes === 1
        if (!insertedReservation) throw new Error("Failed to reserve idempotency record")
      }
      this.database.exec("COMMIT")
      return { outcome: "new", ...(input.idempotency === undefined ? {} : { reservation: input.idempotency }) }
    } catch (error) {
      try { this.database.exec("ROLLBACK") } catch {}
      throw error
    }
  }
}

export interface SqliteRepositoryStoreOptions {
  readonly?: boolean
  create?: boolean
}

export class SqliteRepositoryStore {
  readonly database: RepositoryDatabase
  readonly sandboxes: SqliteSandboxRepository
  readonly snapshots: SqliteSnapshotRepository
  readonly idempotency: SqliteIdempotencyRepository
  readonly sandboxCreations: SqliteSandboxCreationRepository
  #closed = false

  constructor(filename: string, options: SqliteRepositoryStoreOptions = {}) {
    if (filename !== ":memory:" && options.create === false && !existsSync(filename)) {
      throw new Error(`SQLite database does not exist: ${filename}`)
    }

    const cursors = new CursorCodec()
    this.database = openRepositoryDatabase(filename, {
      readOnly: options.readonly,
    })
    this.database.exec("PRAGMA foreign_keys = OFF")
    if (!ensureCurrentRepositorySchema(this.database)) {
      this.database.close()
      this.#closed = true
      throw new IncompatibleRepositorySchemaError(filename)
    }
    this.sandboxes = new SqliteSandboxRepository(this.database, cursors)
    this.snapshots = new SqliteSnapshotRepository(this.database, cursors)
    this.idempotency = new SqliteIdempotencyRepository(this.database)
    this.sandboxCreations = new SqliteSandboxCreationRepository(this.database)
  }

  close(): void {
    if (this.#closed) return
    this.database.close()
    this.#closed = true
  }

  [Symbol.dispose](): void {
    this.close()
  }
}
