import { describe, expect, test } from "bun:test"
import {
  IdentitySchema,
  type Sandbox,
  SandboxIdSchema,
  SandboxSchema,
  SandboxStateSchema,
  SnapshotIdSchema,
  SnapshotSchema,
  SnapshotStateSchema,
  type Snapshot,
} from "../src/index.ts"

const timestamps = {
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:01:00.000Z",
}

describe("identity and resource IDs", () => {
  test("accepts identity and readable canonical IDs", () => {
    expect(IdentitySchema.parse({ accountId: "acct_development:1" })).toEqual({ accountId: "acct_development:1" })
    expect(SandboxIdSchema.safeParse("sbx_calm-cactus-7k3m").success).toBe(true)
    expect(SnapshotIdSchema.safeParse("snap_silver-forest-2p9x").success).toBe(true)
  })

  test("rejects malformed identities, prefixes, casing, and ID shapes", () => {
    for (const value of ["sbx_calm-cactus", "sbx_Calm-cactus-7k3m", "snap_calm-cactus-7k3m"]) {
      expect(SandboxIdSchema.safeParse(value).success).toBe(false)
    }
    expect(SnapshotIdSchema.safeParse("sbx_silver-forest-2p9x").success).toBe(false)
    expect(IdentitySchema.safeParse({ accountId: "", role: "admin" }).success).toBe(false)
  })
})

describe("public resources", () => {
  const sandbox: Sandbox = {
    sandboxId: "sbx_calm-cactus-7k3m",
    provider: "box",
    state: "running",
    sourceSnapshotId: "snap_silver-forest-2p9x",
    version: 2,
    ...timestamps,
  }
  const snapshot: Snapshot = {
    snapshotId: "snap_silver-forest-2p9x",
    name: "checkpoint",
    description: "Known-good state",
    provider: "box",
    sourceSandboxId: "sbx_calm-cactus-7k3m",
    state: "ready",
    version: 1,
    ...timestamps,
  }

  test("accepts all canonical states", () => {
    expect(SandboxStateSchema.options).toEqual(["provisioning", "preparing", "running", "stopping", "stopped", "resuming", "terminating", "terminated", "failed"])
    expect(SnapshotStateSchema.options).toEqual(["creating", "ready", "failed", "deleting", "deleted"])
  })

  test("accepts complete public sandbox and snapshot DTOs", () => {
    expect(SandboxSchema.parse(sandbox)).toEqual(sandbox)
    expect(SnapshotSchema.parse(snapshot)).toEqual(snapshot)
  })

  test("public DTOs reject ownership and provider-internal data", () => {
    for (const forbidden of ["accountId", "providerRef", "providerSecrets", "protectedUrl", "token"]) {
      expect(SandboxSchema.safeParse({ ...sandbox, [forbidden]: "secret" }).success).toBe(false)
      expect(SnapshotSchema.safeParse({ ...snapshot, [forbidden]: "secret" }).success).toBe(false)
    }
  })

  test("rejects provider-native states and invalid versions or timestamps", () => {
    expect(SandboxSchema.safeParse({ ...sandbox, state: "idle" }).success).toBe(false)
    expect(SnapshotSchema.safeParse({ ...snapshot, state: "completed" }).success).toBe(false)
    expect(SandboxSchema.safeParse({ ...sandbox, version: 0 }).success).toBe(false)
    expect(SnapshotSchema.safeParse({ ...snapshot, createdAt: "yesterday" }).success).toBe(false)
  })

  test("resource errors use only stable canonical error codes", () => {
    expect(SandboxSchema.safeParse({ ...sandbox, lastError: { code: "provider_failure", message: "Provisioning failed" } }).success).toBe(true)
    expect(SandboxSchema.safeParse({ ...sandbox, lastError: { code: "box_direct_failed", message: "Provisioning failed" } }).success).toBe(false)
    expect(SnapshotSchema.safeParse({ ...snapshot, lastError: { code: "aws_error", message: "Capture failed" } }).success).toBe(false)
  })
})
