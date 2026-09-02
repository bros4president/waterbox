import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { SandboxRecord } from "@waterbox/core/records"
import { SqliteRepositoryStore } from "../src/index.ts"

function sandbox(version = 1): SandboxRecord {
  return {
    accountId: "acct-node",
    sandboxId: "sbx_calm-cactus-node",
    provider: "fake",
    providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    providerRef: {},
    state: version === 1 ? "running" : "stopped",
    version,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

test("node:sqlite preserves repository semantics and file durability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "waterbox-node-sqlite-"))
  const filename = join(directory, "repository.sqlite")
  try {
    assert.throws(() => new SqliteRepositoryStore(filename, { create: false }), /does not exist/)
    assert.equal(existsSync(filename), false)

    const writable = new SqliteRepositoryStore(filename, { create: true })
    assert.equal(await writable.sandboxes.createIfAbsent(sandbox()), true)
    assert.equal(await writable.sandboxes.createIfAbsent(sandbox()), false)
    assert.equal(await writable.sandboxes.compareAndSwap(sandbox(2), 1), true)
    writable.database.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));
      INSERT INTO child (parent_id) VALUES (1);
    `)
    writable.close()
    writable.close()

    const readOnly = new SqliteRepositoryStore(filename, { readonly: true, create: false })
    assert.deepEqual(await readOnly.sandboxes.get("acct-node", "sbx_calm-cactus-node"), sandbox(2))
    await assert.rejects(readOnly.sandboxes.createIfAbsent({ ...sandbox(), sandboxId: "sbx_calm-cactus-other" }))
    readOnly.close()
    assert.throws(() => readOnly.database.prepare("SELECT 1").get())
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
