import { describe, expect, test } from "bun:test"
import type { z } from "zod"
import {
  BashToolArgumentsSchema,
  BashJobObservationRequestSchema,
  CreateSandboxHeadersSchema,
  CreateSandboxRequestSchema,
  CreateSnapshotRequestSchema,
  EditToolArgumentsSchema,
  GlobToolArgumentsSchema,
  GrepToolArgumentsSchema,
  IdempotencyKeySchema,
  ListSandboxesRequestSchema,
  ListSnapshotsRequestSchema,
  PatchToolArgumentsSchema,
  ReadToolArgumentsSchema,
  SandboxPathRequestSchema,
  SecureTransferConsumeRequestSchema,
  SnapshotPathRequestSchema,
  ToolPathRequestSchema,
  WriteToolArgumentsSchema,
} from "../src/index.ts"

type RequestCase = {
  name: string
  schema: z.ZodType
  valid: unknown[]
  invalid: unknown[]
}

const cases: RequestCase[] = [
  {
    name: "create sandbox",
    schema: CreateSandboxRequestSchema,
    valid: [{}, { sourceSnapshotId: "snap_silver-forest-2p9x" }],
    invalid: [{ sourceSnapshotId: "snapshot-1" }, { provider: "box" }, null],
  },
  {
    name: "create snapshot",
    schema: CreateSnapshotRequestSchema,
    valid: [{}, { name: "checkpoint", description: "Before refactoring" }],
    invalid: [{ name: "" }, { description: 42 }, { name: "checkpoint", providerRef: {} }],
  },
  {
    name: "sandbox path",
    schema: SandboxPathRequestSchema,
    valid: [{ sandboxId: "sbx_calm-cactus-7k3m" }],
    invalid: [{ sandboxId: "sbx_invalid" }, {}, { sandboxId: "sbx_calm-cactus-7k3m", accountId: "acct" }],
  },
  {
    name: "snapshot path",
    schema: SnapshotPathRequestSchema,
    valid: [{ snapshotId: "snap_silver-forest-2p9x" }],
    invalid: [{ snapshotId: "snap_invalid" }, {}, { snapshotId: "snap_silver-forest-2p9x", extra: true }],
  },
  {
    name: "tool path",
    schema: ToolPathRequestSchema,
    valid: [{ sandboxId: "sbx_calm-cactus-7k3m", toolName: "bash" }, { sandboxId: "sbx_calm-cactus-7k3m", toolName: "read" }],
    invalid: [
      { sandboxId: "sbx_calm-cactus-7k3m", toolName: "shell" },
      { sandboxId: 42, toolName: "read" },
      { sandboxId: "sbx_calm-cactus-7k3m", toolName: 42 },
      { sandboxId: "sandbox-1", toolName: "read" },
      { sandboxId: "sbx_calm-cactus-7k3m", toolName: "read", accountId: "acct" },
    ],
  },
  {
    name: "create sandbox wire headers",
    schema: CreateSandboxHeadersSchema,
    valid: [{}, { "Idempotency-Key": "create-client-42" }],
    invalid: [
      { "Idempotency-Key": "" },
      { "Idempotency-Key": "x".repeat(256) },
      { "Idempotency-Key": 42 },
      { idempotencyKey: "key" },
      { "Idempotency-Key": "key", authorization: "secret" },
    ],
  },
  {
    name: "list sandboxes",
    schema: ListSandboxesRequestSchema,
    valid: [{}, { cursor: "opaque-value", limit: "25" }],
    invalid: [{ cursor: "" }, { limit: 0 }, { limit: 101 }, { state: "running" }],
  },
  {
    name: "list snapshots",
    schema: ListSnapshotsRequestSchema,
    valid: [{}, { cursor: "next-page", limit: 100 }],
    invalid: [{ limit: 1.5 }, { limit: "many" }, { provider: "box" }],
  },
  {
    name: "consume secure file transfer",
    schema: SecureTransferConsumeRequestSchema,
    valid: [{ targetPath: "/root/.aws/credentials", ciphertext: "Y2lwaGVy" }],
    invalid: [
      { targetPath: "", ciphertext: "Y2lwaGVy" },
      { targetPath: "secret", ciphertext: "not base64" },
      { targetPath: "secret", ciphertext: "YQ=" },
      { targetPath: "secret", ciphertext: "YQ==", accountId: "acct" },
    ],
  },
  {
    name: "read tool",
    schema: ReadToolArgumentsSchema,
    valid: [{ filePath: "src/index.ts" }, { filePath: ".", offset: 1, limit: 2000 }],
    invalid: [{}, { filePath: "" }, { filePath: "a", offset: 0 }, { filePath: "a", extra: true }],
  },
  {
    name: "write tool",
    schema: WriteToolArgumentsSchema,
    valid: [{ filePath: "notes.txt", content: "" }],
    invalid: [{ filePath: "notes.txt" }, { filePath: "", content: "text" }, { filePath: "notes.txt", content: "x", mode: 0o644 }],
  },
  {
    name: "edit tool",
    schema: EditToolArgumentsSchema,
    valid: [{ filePath: "a.ts", oldString: "old", newString: "new" }, { filePath: "a.ts", oldString: "", newString: "x", replaceAll: true }],
    invalid: [{ filePath: "a.ts", oldString: "old" }, { filePath: "a.ts", oldString: "old", newString: "new", replaceAll: "yes" }],
  },
  {
    name: "patch tool",
    schema: PatchToolArgumentsSchema,
    valid: [{ patchText: "*** Begin Patch\n*** End Patch" }],
    invalid: [{ patchText: "" }, {}, { patchText: "patch", dryRun: true }],
  },
  {
    name: "glob tool",
    schema: GlobToolArgumentsSchema,
    valid: [{ pattern: "**/*.ts" }, { pattern: "*.md", path: "docs" }],
    invalid: [{ pattern: "" }, { pattern: "*.ts", path: "" }, { pattern: "*", limit: 10 }],
  },
  {
    name: "grep tool",
    schema: GrepToolArgumentsSchema,
    valid: [{ pattern: "TODO" }, { pattern: "export\\s", path: "src", include: "*.ts" }],
    invalid: [{ pattern: "" }, { pattern: "x", include: "" }, { pattern: "x", caseSensitive: true }],
  },
  {
    name: "bash tool",
    schema: BashToolArgumentsSchema,
    valid: [{ command: "pwd" }, { command: "bun test", description: "tests", timeout: 30_000, workdir: "/workspace" }],
    invalid: [{ command: "" }, { command: "pwd", timeout: 0 }, { command: "pwd", timeout: 1.5 }, { command: "pwd", timeout: 2_147_483_648 }, { command: "pwd", env: {} }],
  },
  {
    name: "Bash job observation",
    schema: BashJobObservationRequestSchema,
    valid: [{ offset: 0, maxBytes: 1 }, { offset: 1_048_576, maxBytes: 65_536 }],
    invalid: [{ offset: -1, maxBytes: 1 }, { offset: 0, maxBytes: 0 }, { offset: 0, maxBytes: 65_537 }, { offset: 0, maxBytes: 1, extra: true }],
  },
]

describe("public request contracts", () => {
  for (const requestCase of cases) {
    test(`${requestCase.name} accepts valid examples`, () => {
      for (const value of requestCase.valid) expect(requestCase.schema.safeParse(value).success).toBe(true)
    })

    test(`${requestCase.name} rejects invalid examples and unknown fields`, () => {
      for (const value of requestCase.invalid) expect(requestCase.schema.safeParse(value).success).toBe(false)
    })
  }

  test("scalar idempotency keys enforce wire value bounds and types", () => {
    expect(IdempotencyKeySchema.safeParse("create-client-42").success).toBe(true)
    for (const value of ["", "x".repeat(256), 42, null, {}]) {
      expect(IdempotencyKeySchema.safeParse(value).success).toBe(false)
    }
  })
})
