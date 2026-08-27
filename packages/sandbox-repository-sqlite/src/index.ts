import { Database } from "bun:sqlite"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import {
  ErrorCodeSchema,
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

const JsonValueSchema: z.ZodType<JsonValue> = z.json()
const ResourceErrorSchema = z.object({ code: ErrorCodeSchema, message: z.string() }).strict()
const BaseRecordSchema = z.object({
  accountId: z.string().min(1),
  provider: z.string().min(1),
  providerRef: JsonValueSchema,
  version: z.number().int().nonnegative(),
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
  name: z.string().optional(),
  description: z.string().optional(),
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
  version: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lastError: ResourceErrorSchema.optional(),
}).strict()

type ResourceDocumentRow = { account_id: string; resource_id: string; version: number; document: string }
type IdempotencyDocumentRow = {
  account_id: string
  scope: string
  idempotency_key: string
  version: number
  expires_at: string
  document: string
}
type CursorPayload = { v: 1; keys: string[] }
type CursorKind = "sandbox" | "snapshot" | "idempotency"

const CURSOR_FORMAT_VERSION = 1
const CURSOR_IV_BYTES = 12
const CURSOR_TAG_BYTES = 16

class CursorCodec {
  readonly #key: Buffer

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error("SQLite repository cursor key must be exactly 32 bytes")
    this.#key = Buffer.from(key)
  }

  encode(kind: CursorKind, accountId: string, keys: string[]): string {
    const iv = randomBytes(CURSOR_IV_BYTES)
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv)
    cipher.setAAD(this.#aad(kind, accountId))
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ v: CURSOR_FORMAT_VERSION, keys } satisfies CursorPayload), "utf8"),
      cipher.final(),
    ])
    return Buffer.concat([
      Buffer.from([CURSOR_FORMAT_VERSION]),
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]).toString("base64url")
  }

  decode(cursor: string | undefined, kind: CursorKind, accountId: string, keyCount: number): string[] | undefined {
    if (cursor === undefined) return undefined
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length % 4 === 1) throw new Error("Invalid encoding")
      const token = Buffer.from(cursor, "base64url")
      if (token.toString("base64url") !== cursor) throw new Error("Noncanonical encoding")
      const minimumLength = 1 + CURSOR_IV_BYTES + CURSOR_TAG_BYTES + 1
      if (token.length < minimumLength || token[0] !== CURSOR_FORMAT_VERSION) throw new Error("Invalid format")
      const ivStart = 1
      const tagStart = ivStart + CURSOR_IV_BYTES
      const ciphertextStart = tagStart + CURSOR_TAG_BYTES
      const decipher = createDecipheriv("aes-256-gcm", this.#key, token.subarray(ivStart, tagStart))
      decipher.setAAD(this.#aad(kind, accountId))
      decipher.setAuthTag(token.subarray(tagStart, ciphertextStart))
      const plaintext = Buffer.concat([decipher.update(token.subarray(ciphertextStart)), decipher.final()]).toString("utf8")
      const parsed = z.object({
        v: z.literal(CURSOR_FORMAT_VERSION),
        keys: z.array(z.string()).length(keyCount),
      }).strict().parse(JSON.parse(plaintext))
      return parsed.keys
    } catch {
      // Authentication, shape, partition, and key errors intentionally collapse to
      // one secret-free error at this public repository boundary.
      throw new Error("Invalid repository cursor")
    }
  }

  #aad(kind: CursorKind, accountId: string): Buffer {
    return Buffer.from(`${kind}\u0000${accountId}`, "utf8")
  }
}

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > SQLITE_REPOSITORY_MAX_PAGE_LIMIT) {
    throw new RangeError(`Repository page limit must be an integer from 1 to ${SQLITE_REPOSITORY_MAX_PAGE_LIMIT}`)
  }
  return limit
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
    && record.version === row.version
    && record.expiresAt === row.expires_at)
}

function serialize(value: unknown): string {
  return JSON.stringify(value)
}

export class SqliteSandboxRepository implements SandboxRepository {
  constructor(private readonly database: Database, private readonly cursors: CursorCodec) {}

  async createIfAbsent(record: SandboxRecord): Promise<boolean> {
    const result = this.database.query(`INSERT OR IGNORE INTO sandbox_documents
      (account_id, resource_id, version, document) VALUES (?, ?, ?, ?)`)
      .run(record.accountId, record.sandboxId, record.version, serialize(record))
    return result.changes === 1
  }

  async get(accountId: string, sandboxId: SandboxRecord["sandboxId"]): Promise<SandboxRecord | undefined> {
    const row = this.database.query<ResourceDocumentRow, [string, string]>(
      "SELECT account_id, resource_id, version, document FROM sandbox_documents WHERE account_id = ? AND resource_id = ?",
    ).get(accountId, sandboxId)
    return parseSandbox(row ?? undefined, accountId, sandboxId)
  }

  async list(input: ListRepositoryInput): Promise<RepositoryPage<SandboxRecord>> {
    const limit = boundedLimit(input.limit)
    const keys = this.cursors.decode(input.cursor, "sandbox", input.accountId, 1)
    const rows = keys === undefined
      ? this.database.query<ResourceDocumentRow, [string, number]>(
          "SELECT account_id, resource_id, version, document FROM sandbox_documents WHERE account_id = ? ORDER BY resource_id LIMIT ?",
        ).all(input.accountId, limit + 1)
      : this.database.query<ResourceDocumentRow, [string, string, number]>(
          "SELECT account_id, resource_id, version, document FROM sandbox_documents WHERE account_id = ? AND resource_id > ? ORDER BY resource_id LIMIT ?",
        ).all(input.accountId, keys[0]!, limit + 1)
    const pageRows = rows.slice(0, limit)
    const items = pageRows.map((row) => parseSandbox(row, input.accountId, row.resource_id)!)
    const last = pageRows.at(-1)
    return { items, ...(rows.length > limit && last ? { nextCursor: this.cursors.encode("sandbox", input.accountId, [last.resource_id]) } : {}) }
  }

  async compareAndSwap(record: SandboxRecord, expectedVersion: number): Promise<boolean> {
    if (record.version !== expectedVersion + 1) return false
    const result = this.database.query(`UPDATE sandbox_documents SET version = ?, document = ?
      WHERE account_id = ? AND resource_id = ? AND version = ?`)
      .run(record.version, serialize(record), record.accountId, record.sandboxId, expectedVersion)
    return result.changes === 1
  }

  async conditionalDelete(accountId: string, sandboxId: SandboxRecord["sandboxId"], expectedVersion: number): Promise<boolean> {
    return this.database.query(
      "DELETE FROM sandbox_documents WHERE account_id = ? AND resource_id = ? AND version = ?",
    ).run(accountId, sandboxId, expectedVersion).changes === 1
  }
}

export class SqliteSnapshotRepository implements SnapshotRepository {
  constructor(private readonly database: Database, private readonly cursors: CursorCodec) {}

  async createIfAbsent(record: SnapshotRecord): Promise<boolean> {
    return this.database.query(`INSERT OR IGNORE INTO snapshot_documents
      (account_id, resource_id, version, document) VALUES (?, ?, ?, ?)`)
      .run(record.accountId, record.snapshotId, record.version, serialize(record)).changes === 1
  }

  async get(accountId: string, snapshotId: SnapshotRecord["snapshotId"]): Promise<SnapshotRecord | undefined> {
    const row = this.database.query<ResourceDocumentRow, [string, string]>(
      "SELECT account_id, resource_id, version, document FROM snapshot_documents WHERE account_id = ? AND resource_id = ?",
    ).get(accountId, snapshotId)
    return parseSnapshot(row ?? undefined, accountId, snapshotId)
  }

  async list(input: ListRepositoryInput): Promise<RepositoryPage<SnapshotRecord>> {
    const limit = boundedLimit(input.limit)
    const keys = this.cursors.decode(input.cursor, "snapshot", input.accountId, 1)
    const rows = keys === undefined
      ? this.database.query<ResourceDocumentRow, [string, number]>(
          "SELECT account_id, resource_id, version, document FROM snapshot_documents WHERE account_id = ? ORDER BY resource_id LIMIT ?",
        ).all(input.accountId, limit + 1)
      : this.database.query<ResourceDocumentRow, [string, string, number]>(
          "SELECT account_id, resource_id, version, document FROM snapshot_documents WHERE account_id = ? AND resource_id > ? ORDER BY resource_id LIMIT ?",
        ).all(input.accountId, keys[0]!, limit + 1)
    const pageRows = rows.slice(0, limit)
    const items = pageRows.map((row) => parseSnapshot(row, input.accountId, row.resource_id)!)
    const last = pageRows.at(-1)
    return { items, ...(rows.length > limit && last ? { nextCursor: this.cursors.encode("snapshot", input.accountId, [last.resource_id]) } : {}) }
  }

  async compareAndSwap(record: SnapshotRecord, expectedVersion: number): Promise<boolean> {
    if (record.version !== expectedVersion + 1) return false
    return this.database.query(`UPDATE snapshot_documents SET version = ?, document = ?
      WHERE account_id = ? AND resource_id = ? AND version = ?`)
      .run(record.version, serialize(record), record.accountId, record.snapshotId, expectedVersion).changes === 1
  }

  async conditionalDelete(accountId: string, snapshotId: SnapshotRecord["snapshotId"], expectedVersion: number): Promise<boolean> {
    return this.database.query(
      "DELETE FROM snapshot_documents WHERE account_id = ? AND resource_id = ? AND version = ?",
    ).run(accountId, snapshotId, expectedVersion).changes === 1
  }
}

export class SqliteIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly database: Database, private readonly cursors: CursorCodec) {}

  async createIfAbsent(record: IdempotencyRecord): Promise<boolean> {
    return this.database.query(`INSERT OR IGNORE INTO idempotency_documents
      (account_id, scope, idempotency_key, version, expires_at, document) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(record.accountId, record.scope, record.key, record.version, record.expiresAt, serialize(record)).changes === 1
  }

  async get(input: IdempotencyKey): Promise<IdempotencyRecord | undefined> {
    const row = this.database.query<IdempotencyDocumentRow, [string, string, string]>(
      `SELECT account_id, scope, idempotency_key, version, expires_at, document
       FROM idempotency_documents WHERE account_id = ? AND scope = ? AND idempotency_key = ?`,
    ).get(input.accountId, input.scope, input.key)
    return parseIdempotency(row ?? undefined, input.accountId, input.scope, input.key)
  }

  async list(input: ListRepositoryInput): Promise<RepositoryPage<IdempotencyRecord>> {
    const limit = boundedLimit(input.limit)
    const keys = this.cursors.decode(input.cursor, "idempotency", input.accountId, 2)
    const rows = keys === undefined
      ? this.database.query<IdempotencyDocumentRow, [string, number]>(
          `SELECT account_id, scope, idempotency_key, version, expires_at, document
           FROM idempotency_documents WHERE account_id = ? ORDER BY scope, idempotency_key LIMIT ?`,
        ).all(input.accountId, limit + 1)
      : this.database.query<IdempotencyDocumentRow, [string, string, string, string, number]>(
          `SELECT account_id, scope, idempotency_key, version, expires_at, document FROM idempotency_documents
           WHERE account_id = ? AND (scope > ? OR (scope = ? AND idempotency_key > ?))
           ORDER BY scope, idempotency_key LIMIT ?`,
        ).all(input.accountId, keys[0]!, keys[0]!, keys[1]!, limit + 1)
    const pageRows = rows.slice(0, limit)
    const items = pageRows.map((row) => parseIdempotency(row, input.accountId, row.scope, row.idempotency_key)!)
    const last = pageRows.at(-1)
    return { items, ...(rows.length > limit && last ? { nextCursor: this.cursors.encode("idempotency", input.accountId, [last.scope, last.idempotency_key]) } : {}) }
  }

  async compareAndSwap(record: IdempotencyRecord, expectedVersion: number): Promise<boolean> {
    if (record.version !== expectedVersion + 1) return false
    return this.database.query(`UPDATE idempotency_documents SET version = ?, expires_at = ?, document = ?
      WHERE account_id = ? AND scope = ? AND idempotency_key = ? AND version = ?`)
      .run(record.version, record.expiresAt, serialize(record), record.accountId, record.scope, record.key, expectedVersion).changes === 1
  }

  async conditionalDelete(input: IdempotencyKey, expectedVersion: number): Promise<boolean> {
    return this.database.query(`DELETE FROM idempotency_documents
      WHERE account_id = ? AND scope = ? AND idempotency_key = ? AND version = ?`)
      .run(input.accountId, input.scope, input.key, expectedVersion).changes === 1
  }
}

export interface SqliteRepositoryStoreOptions {
  cursorKey: Uint8Array
  readonly?: boolean
  create?: boolean
}

export class SqliteRepositoryStore {
  readonly database: Database
  readonly sandboxes: SqliteSandboxRepository
  readonly snapshots: SqliteSnapshotRepository
  readonly idempotency: SqliteIdempotencyRepository
  #closed = false

  constructor(filename: string, options: SqliteRepositoryStoreOptions) {
    const cursors = new CursorCodec(options.cursorKey)
    const databaseOptions = { ...(options.readonly === undefined ? {} : { readonly: options.readonly }), ...(options.create === undefined ? {} : { create: options.create }) }
    this.database = Object.keys(databaseOptions).length === 0 ? new Database(filename) : new Database(filename, databaseOptions)
    this.database.exec("PRAGMA foreign_keys = OFF")
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sandbox_documents (
        account_id TEXT NOT NULL, resource_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY (account_id, resource_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS snapshot_documents (
        account_id TEXT NOT NULL, resource_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY (account_id, resource_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS idempotency_documents (
        account_id TEXT NOT NULL, scope TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        version INTEGER NOT NULL, expires_at TEXT NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY (account_id, scope, idempotency_key)
      ) WITHOUT ROWID;
    `)
    this.sandboxes = new SqliteSandboxRepository(this.database, cursors)
    this.snapshots = new SqliteSnapshotRepository(this.database, cursors)
    this.idempotency = new SqliteIdempotencyRepository(this.database, cursors)
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
