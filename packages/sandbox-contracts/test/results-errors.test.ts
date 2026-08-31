import { describe, expect, test } from "bun:test"
import {
  BashToolEventSchema,
  BashToolResultSchema,
  EditToolEventSchema,
  type ErrorEnvelope,
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
  GlobToolEventSchema,
  GrepToolEventSchema,
  PatchToolEventSchema,
  ReadToolEventSchema,
  ToolNameSchema,
  WriteToolEventSchema,
} from "../src/index.ts"

const base = { title: "complete", output: "ok" }

describe("tool results and events", () => {
  test("defines exactly the seven canonical tool names", () => {
    expect(ToolNameSchema.options).toEqual(["read", "write", "edit", "patch", "glob", "grep", "bash"])
  })

  test("accepts one final result event for every non-streaming tool", () => {
    const events = [
      [ReadToolEventSchema, { ...base, metadata: { filePath: "a.ts", type: "text", offset: 1, lines: 1, totalLines: 1 } }],
      [WriteToolEventSchema, { ...base, metadata: { filePath: "a.ts", bytes: 2 } }],
      [EditToolEventSchema, { ...base, metadata: { filePath: "a.ts", replacements: 1, bytes: 2 } }],
      [PatchToolEventSchema, { ...base, metadata: { added: [], updated: ["a.ts"], deleted: [], moved: [] } }],
      [GlobToolEventSchema, { ...base, metadata: { pattern: "*.ts", path: ".", count: 1, truncated: false } }],
      [GrepToolEventSchema, { ...base, metadata: { pattern: "x", path: ".", matches: 1, truncated: false } }],
    ] as const

    for (const [schema, result] of events) expect(schema.safeParse({ type: "result", ...result }).success).toBe(true)
  })

  test("accepts ordered NDJSON-compatible bash event shapes", () => {
    const result = {
      ...base,
      outcome: "completed",
      metadata: {
        command: "pwd",
        workdir: "/workspace",
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        durationMs: 12,
        outputTruncated: false,
      },
    }
    expect(BashToolResultSchema.safeParse(result).success).toBe(true)
    expect(BashToolEventSchema.safeParse({ type: "stdout", data: "out\n" }).success).toBe(true)
    expect(BashToolEventSchema.safeParse({ type: "stderr", data: "warn\n" }).success).toBe(true)
    expect(BashToolEventSchema.safeParse({ type: "result", ...result }).success).toBe(true)
    expect(BashToolEventSchema.safeParse({
      type: "result",
      ...result,
      metadata: { ...result.metadata, outputTruncated: true },
    }).success).toBe(true)
    expect(BashToolResultSchema.safeParse({
      title: "Bash command dispatched",
      output: "Command dispatched. statusPath reports execution state, and outputPath receives output continuously. Repeated output reads can duplicate tokens and pollute context.",
      outcome: "dispatched",
      metadata: {
        command: "sleep 20",
        workdir: ".",
        timeout: 20_000,
        jobId: "job_0123456789abcdef0123456789abcdef",
        outputPath: "/run/waterbox/bash-jobs/job_0123456789abcdef0123456789abcdef/output.log",
        statusPath: "/run/waterbox/bash-jobs/job_0123456789abcdef0123456789abcdef/status.json",
      },
    }).success).toBe(true)
    expect(BashToolResultSchema.safeParse({
      title: "Bash command dispatched",
      output: "Command dispatched",
      outcome: "dispatched",
      metadata: {
        command: "sleep 20",
        workdir: ".",
        jobId: "job_0123456789abcdef0123456789abcdef",
        outputPath: "/run/waterbox/bash-jobs/job_0123456789abcdef0123456789abcdef/output.log",
        statusPath: "/run/waterbox/bash-jobs/job_0123456789abcdef0123456789abcdef/status.json",
      },
    }).success).toBe(true)
  })

  test("rejects malformed event variants and unknown fields", () => {
    expect(BashToolEventSchema.safeParse({ type: "stdout", data: 1 }).success).toBe(false)
    expect(BashToolEventSchema.safeParse({ type: "progress", data: "x" }).success).toBe(false)
    expect(BashToolEventSchema.safeParse({ type: "stderr", data: "x", providerRef: {} }).success).toBe(false)
    expect(ReadToolEventSchema.safeParse({ type: "stdout", data: "x" }).success).toBe(false)
    expect(BashToolEventSchema.safeParse({
      type: "result",
      outcome: "completed",
      title: "complete",
      output: "ok",
      metadata: { command: "pwd", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 12 },
    }).success).toBe(false)
    expect(BashToolEventSchema.safeParse({
      type: "result",
      outcome: "completed",
      title: "complete",
      output: "ok",
      metadata: { command: "pwd", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 12, outputTruncated: "no" },
    }).success).toBe(false)
    expect(BashToolEventSchema.safeParse({ type: "result", result: { title: "complete", output: "ok", metadata: {} } }).success).toBe(false)
    const jobId = "job_0123456789abcdef0123456789abcdef"
    const base = { title: "dispatched", output: "recovery", outcome: "dispatched", metadata: { command: "x", workdir: ".", jobId, outputPath: `/run/waterbox/bash-jobs/${jobId}/output.log`, statusPath: `/run/waterbox/bash-jobs/${jobId}/status.json` } }
    for (const metadata of [
      { ...base.metadata, outputPath: `/tmp/${jobId}/output.log`, statusPath: `/tmp/${jobId}/status.json` },
      { ...base.metadata, outputPath: `/run/waterbox/bash-jobs/../bash-jobs/${jobId}/output.log` },
      { ...base.metadata, statusPath: `/run/waterbox/bash-jobs/${jobId}/../${jobId}/status.json` },
      { ...base.metadata, outputPath: `/run/waterbox/bash-jobs//${jobId}/output.log` },
    ]) expect(BashToolResultSchema.safeParse({ ...base, metadata }).success).toBe(false)
  })

  test("rejects non-canonical tool names and malformed types", () => {
    for (const value of ["shell", "find", "READ", "", 42, null, {}]) {
      expect(ToolNameSchema.safeParse(value).success).toBe(false)
    }
  })
})

describe("structured errors", () => {
  test("includes the stable control-plane error codes", () => {
    expect(ErrorCodeSchema.options).toEqual([
      "invalid_request",
      "unauthorized",
      "not_found",
      "conflict",
      "idempotency_conflict",
      "idempotency_in_progress",
      "invalid_state",
      "unsupported_capability",
      "provider_failure",
      "provider_limit",
      "ambiguous_execution",
      "transfer_expired",
      "transfer_consumed",
      "internal_error",
    ])
  })

  test("accepts only the stable safe error fields", () => {
    const envelope: ErrorEnvelope = {
      error: {
        code: "provider_limit",
        message: "Snapshot quota reached",
        requestId: "req-42",
      },
    }
    expect(ErrorEnvelopeSchema.parse(envelope)).toEqual(envelope)
  })

  test("rejects unknown codes, details, and envelope fields", () => {
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: "box_error", message: "failed", requestId: "req-1" } }).success).toBe(false)
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: "not_found", message: "", requestId: "req-1" } }).success).toBe(false)
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: "not_found", message: "missing", requestId: "req-1", details: {} } }).success).toBe(false)
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: "not_found", message: "missing", requestId: "req-1", details: null } }).success).toBe(false)
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: "not_found", message: "missing", requestId: "req-1" }, status: 404 }).success).toBe(false)
  })

  test("rejects nested ownership and provider-secret details structurally", () => {
    const envelope = {
      error: {
        code: "provider_failure",
        message: "failed",
        requestId: "req-1",
        details: {
          context: [{ accountId: "acct-1", provider: { providerRef: { protectedUrl: "secret" }, token: "secret" } }],
        },
      },
    }
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(false)
  })
})
