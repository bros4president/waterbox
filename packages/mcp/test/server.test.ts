import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { BashToolResultSchema } from "@waterbox/contracts"
import type {
  CreateSandboxRequest,
  CreateSnapshotRequest,
  CursorPaginationRequest,
  Sandbox,
  SandboxId,
  Snapshot,
  SnapshotId,
  SecureTransferConsumeRequest,
  SecureTransferId,
  ToolName,
} from "@waterbox/contracts"
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ProviderExecuteInput,
  ToolArgumentsByName,
  ToolEventByName,
} from "@waterbox/core/provider"
import { ProviderError } from "@waterbox/core/provider"
import { FakeSandboxProvider, FixedClock, SequenceIdGenerator } from "@waterbox/core/test-support"
import type { McpBackend } from "../src/backend.ts"
import { absorbBashReceipt } from "../src/bash-observation.ts"
import type { BoxMcpConfig } from "../src/config.ts"
import { createDirectBackend, createMcpBackend, UnsupportedMcpProviderError } from "../src/direct.ts"
import { createStartupBackend } from "../src/main.ts"
import { createWaterboxMcpServer } from "../src/server.ts"

const sandbox: Sandbox = {
  sandboxId: "sbx_calm-forest-abc1",
  provider: "box",
  state: "running",
  version: 1,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
}
const snapshot: Snapshot = {
  snapshotId: "snap_silver-river-abc1",
  name: "checkpoint",
  provider: "box",
  sourceSandboxId: sandbox.sandboxId,
  state: "ready",
  version: 1,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
}

const directConfig: BoxMcpConfig = {
  provider: {
    type: "box",
    config: {
      apiBaseUrl: "https://ascii.dev/api/box/v1",
      apiKey: "not-used-by-fake",
      polling: { intervalMs: 1, timeoutMs: 2 },
    },
  },
  sqlitePath: ":memory:",
}

describe("Waterbox MCP server", () => {
  test("exposes explicit lifecycle and sandbox-targeted operation tools", async () => {
    const backend = new StubBackend()
    const { client, close } = await connected(backend)
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "create_sandbox", "probe_sandbox", "delete_sandbox", "list_snapshots", "create_snapshot", "delete_snapshot", "send_file_securely",
        "read", "write", "edit", "patch", "glob", "grep", "bash",
      ])
      const bashTool = (await client.listTools()).tools.find((tool) => tool.name === "bash")
      expect(bashTool?.description).toBe("Runs unrestricted bash as root in the specified Waterbox sandbox, never on the local machine. The default working directory is /workspace.")
      expect((await client.listTools()).tools.some((tool) => tool.name.includes("job"))).toBeFalse()
      await client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "create-1" } })
      await client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "create-2", sourceSnapshotId: snapshot.snapshotId } })
      await client.callTool({ name: "create_snapshot", arguments: { sandboxId: sandbox.sandboxId, name: "checkpoint" } })
      await client.callTool({ name: "list_snapshots", arguments: { limit: 10 } })
      await client.callTool({ name: "delete_snapshot", arguments: { snapshotId: snapshot.snapshotId } })
      await client.callTool({ name: "probe_sandbox", arguments: { sandboxId: sandbox.sandboxId } })
      await client.callTool({ name: "delete_sandbox", arguments: { sandboxId: sandbox.sandboxId } })
      await client.callTool({ name: "read", arguments: { sandboxId: sandbox.sandboxId, filePath: "/workspace/a.txt" } })

      expect(backend.createInputs).toEqual([
        { request: {}, idempotencyKey: "create-1" },
        { request: { sourceSnapshotId: snapshot.snapshotId }, idempotencyKey: "create-2" },
      ])
      expect(backend.lifecycleCalls).toEqual(["createSnapshot", "listSnapshots", "deleteSnapshot", "probeSandbox", "deleteSandbox"])
      expect(backend.executedSandboxIds).toEqual([sandbox.sandboxId])

      const invalid = await client.callTool({ name: "read", arguments: { filePath: "/workspace/a.txt" } })
      expect(invalid).toMatchObject({ isError: true, content: [{ text: "Invalid arguments for Waterbox read" }] })
      expect(backend.executeCalls).toBe(1)

      const directory = await mkdtemp(join(tmpdir(), "waterbox-mcp-secure-"))
      try {
        const secret = "mcp-secret-never-in-result"
        const sourcePath = join(directory, "secret")
        await writeFile(sourcePath, secret)
        const sent = await client.callTool({ name: "send_file_securely", arguments: { sandboxId: sandbox.sandboxId, sourcePath, targetPath: "/root/secret" } })
        expect(JSON.stringify(sent)).not.toContain(secret)
        expect(backend.securePlaintext).toBe(secret)
        expect(backend.secureCiphertext).not.toContain(secret)
      } finally { await rm(directory, { recursive: true, force: true }) }
    } finally {
      await close()
    }
  })

  test("composes core, SQLite, and a provider for lifecycle and all seven Direct tools", async () => {
    const provider = new ValidFakeProvider({ name: "box" })
    const backend = await createDirectBackend(directConfig, {
      provider,
      clock: new FixedClock("2026-08-27T00:00:00.000Z"),
      ids: new SequenceIdGenerator([sandbox.sandboxId], [snapshot.snapshotId]),
    })
    const { client, close } = await connected(backend)
    try {
      await client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "direct-create" } })
      await client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "direct-create" } })
      await client.callTool({ name: "probe_sandbox", arguments: { sandboxId: sandbox.sandboxId } })
      await client.callTool({ name: "write", arguments: { sandboxId: sandbox.sandboxId, filePath: "/workspace/a.txt", content: "A\n" } })
      await client.callTool({ name: "read", arguments: { sandboxId: sandbox.sandboxId, filePath: "/workspace/a.txt" } })
      await client.callTool({ name: "edit", arguments: { sandboxId: sandbox.sandboxId, filePath: "/workspace/a.txt", oldString: "A", newString: "B" } })
      await client.callTool({ name: "patch", arguments: { sandboxId: sandbox.sandboxId, patchText: "*** Begin Patch\n*** End Patch" } })
      await client.callTool({ name: "glob", arguments: { sandboxId: sandbox.sandboxId, pattern: "*.txt", path: "/workspace" } })
      await client.callTool({ name: "grep", arguments: { sandboxId: sandbox.sandboxId, pattern: "B", path: "/workspace" } })
      const bash = await client.callTool({ name: "bash", arguments: { sandboxId: sandbox.sandboxId, command: "pwd" } })
      expect(bash).toMatchObject({ content: [{ text: expect.stringContaining("/workspace") }] })
      await client.callTool({ name: "create_snapshot", arguments: { sandboxId: sandbox.sandboxId, name: "checkpoint" } })
      const listed = await client.callTool({ name: "list_snapshots", arguments: {} })
      expect(listed).toMatchObject({ content: [{ text: expect.stringContaining(snapshot.snapshotId) }] })
      await client.callTool({ name: "delete_snapshot", arguments: { snapshotId: snapshot.snapshotId } })
      await client.callTool({ name: "delete_sandbox", arguments: { sandboxId: sandbox.sandboxId } })
      expect(provider.createCalls).toBe(1)
      expect(provider.inspectSandboxCalls).toBe(1)
      expect(provider.toolNames).toEqual(["write", "read", "edit", "patch", "glob", "grep", "bash"])
      expect(provider.createSnapshotCalls).toBe(1)
      expect(provider.deleteSnapshotCalls).toBe(1)
      expect(provider.deleteCalls).toBe(1)
    } finally {
      await close()
    }
  })

  test("returns a redacted recovery handle and resumes preparation from SQLite without recreating", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-mcp-preparation-"))
    const config = { ...directConfig, sqlitePath: join(directory, "waterbox.sqlite") }
    try {
      const firstProvider = new ValidFakeProvider({ name: "box" })
      firstProvider.prepareError = new ProviderError("ambiguous_execution", "lost response with provider secret")
      const firstBackend = await createDirectBackend(config, {
        provider: firstProvider,
        clock: new FixedClock("2026-08-27T00:00:00.000Z"),
        ids: new SequenceIdGenerator([sandbox.sandboxId]),
      })
      const first = await connected(firstBackend)
      try {
        const unresolved = await first.client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "recover-create" } })
        expect(unresolved).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(sandbox.sandboxId) }] })
        expect(JSON.stringify(unresolved)).not.toContain("provider secret")
      } finally { await first.close() }

      const secondProvider = new ValidFakeProvider({ name: "box" })
      const secondBackend = await createDirectBackend(config, {
        provider: secondProvider,
        clock: new FixedClock("2026-08-27T00:00:00.000Z"),
        ids: new SequenceIdGenerator(),
      })
      const second = await connected(secondBackend)
      try {
        const recovered = await second.client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "recover-create" } })
        expect(recovered).toMatchObject({ content: [{ text: expect.stringContaining('"state":"running"') }] })
        expect(secondProvider.createCalls).toBe(0)
        expect(secondProvider.prepareCalls).toBe(1)
        expect((await second.client.callTool({ name: "delete_sandbox", arguments: { sandboxId: sandbox.sandboxId } })).isError).not.toBe(true)
      } finally { await second.close() }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test("makes a definite preparation failure deletable through its MCP recovery handle", async () => {
    const provider = new ValidFakeProvider({ name: "box" })
    provider.prepareError = new ProviderError("failure", "private provider failure")
    const backend = await createDirectBackend(directConfig, {
      provider,
      clock: new FixedClock("2026-08-27T00:00:00.000Z"),
      ids: new SequenceIdGenerator([sandbox.sandboxId]),
    })
    const connection = await connected(backend)
    try {
      const failed = await connection.client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "failed-create" } })
      expect(failed).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(sandbox.sandboxId) }] })
      expect(JSON.stringify(failed)).not.toContain("private provider failure")
      expect((await connection.client.callTool({ name: "delete_sandbox", arguments: { sandboxId: sandbox.sandboxId } })).isError).not.toBe(true)
    } finally { await connection.close() }
  })

  test("fails the acknowledged Waterbox provider before creating local state", async () => {
    await expect(createMcpBackend({ provider: { type: "waterbox" } })).rejects.toBeInstanceOf(UnsupportedMcpProviderError)
    await expect(createMcpBackend({ provider: { type: "waterbox" } })).rejects.toThrow('provider "waterbox" is not supported yet')
  })

  test("keeps every tool side-effect free while provider setup is incomplete or unsupported", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-mcp-setup-"))
    const sqlitePath = join(directory, "must-not-exist.sqlite")
    const environments = [
      {},
      { WATERBOX_PROVIDER: "unknown" },
      { WATERBOX_PROVIDER: "waterbox" },
      { WATERBOX_PROVIDER: "box" },
      { WATERBOX_PROVIDER: "box", BOX_API_KEY: "secret", BOX_POLL_INTERVAL_MS: "invalid" },
    ]
    const names = ["create_sandbox", "probe_sandbox", "delete_sandbox", "list_snapshots", "create_snapshot", "delete_snapshot", "send_file_securely", "read", "write", "edit", "patch", "glob", "grep", "bash"]
    try {
      for (const environment of environments) {
        const backend = await createStartupBackend({ ...environment, WATERBOX_SQLITE_PATH: sqlitePath })
        const connection = await connected(backend)
        try {
          expect((await connection.client.listTools()).tools).toHaveLength(14)
          for (const name of names) {
            const result = await connection.client.callTool({ name, arguments: name === "send_file_securely" ? { sandboxId: sandbox.sandboxId, sourcePath: join(directory, "missing-secret"), targetPath: "/root/secret" } : {} })
            expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("WATERBOX_PROVIDER=box") }] })
          }
          expect(existsSync(sqlitePath)).toBe(false)
        } finally {
          await connection.close()
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("absorbs dispatched bash receipts and retains completed failure classification", async () => {
    const backend = new StubBackend()
    const completed = {
      type: "result", outcome: "completed", title: "bash", output: "failed", metadata: {
        command: "false", workdir: "/workspace", exitCode: 1, signal: null,
        timedOut: false, aborted: false, durationMs: 1, outputTruncated: false,
      },
    } as const
    backend.bashEvent = {
      type: "result", outcome: "dispatched", title: "Bash command dispatched", output: "Command dispatched. statusPath reports execution state, and outputPath receives output continuously. Repeated output reads can duplicate tokens and pollute context.", metadata: {
        command: "sleep 20", workdir: "/workspace", timeout: 20_000,
        jobId: `job_${"a".repeat(32)}`,
        outputPath: `/run/waterbox/bash-jobs/job_${"a".repeat(32)}/output.log`,
        statusPath: `/run/waterbox/bash-jobs/job_${"a".repeat(32)}/status.json`,
      },
    }
    backend.bashObservation = {
      jobId: `job_${"a".repeat(32)}`, state: "completed", chunkBase64: Buffer.from("absorbed output").toString("base64"),
      nextOffset: 15, outputSize: 15, exitCode: 0, signal: null, timedOut: false, durationMs: 20,
    }
    const { client, close } = await connected(backend)
    try {
      const dispatched = await client.callTool({ name: "bash", arguments: { sandboxId: sandbox.sandboxId, command: "sleep 20", timeout: 20_000 } })
      expect(dispatched.isError).not.toBe(true)
      expect(dispatched).toMatchObject({ content: [{ text: "absorbed output" }], structuredContent: { title: "Bash command", outcome: "completed", metadata: { exitCode: 0, outputTruncated: false } } })
      expect(BashToolResultSchema.safeParse(dispatched.structuredContent).success).toBeTrue()
      const bashTool = (await client.listTools()).tools.find(tool => tool.name === "bash")
      expect(bashTool?.outputSchema).toMatchObject({ type: "object" })
      expect(backend.cleanupCalls).toBe(1)

      for (const metadata of [
        completed.metadata,
        { ...completed.metadata, exitCode: 0, timedOut: true },
        { ...completed.metadata, exitCode: 0, aborted: true },
      ]) {
        backend.bashEvent = { ...completed, metadata }
        expect(await client.callTool({ name: "bash", arguments: { sandboxId: sandbox.sandboxId, command: "false" } })).toMatchObject({ isError: true })
      }
    } finally {
      await close()
    }
  })

  test("returns safe fallback paths without command or observer details", async () => {
    const backend = new StubBackend()
    const jobId = `job_${"b".repeat(32)}`
    backend.bashEvent = { type: "result", outcome: "dispatched", title: "Bash command dispatched", output: "dispatched", metadata: {
      command: "printf top-secret", workdir: "/workspace", jobId,
      outputPath: `/run/waterbox/bash-jobs/${jobId}/output.log`, statusPath: `/run/waterbox/bash-jobs/${jobId}/status.json`,
    } }
    backend.observationError = new Error("sensitive observer failure")
    const { client, close } = await connected(backend)
    try {
      const fallback = await client.callTool({ name: "bash", arguments: { sandboxId: sandbox.sandboxId, command: "printf top-secret" } })
      expect(fallback.isError).not.toBe(true)
      const text = ((fallback as { content: Array<{ text: string }> }).content[0]!).text
      expect(text).toContain(jobId)
      expect(text).toContain(`/run/waterbox/bash-jobs/${jobId}/status.json`)
      expect(text).toContain(`/run/waterbox/bash-jobs/${jobId}/output.log`)
      expect(text).not.toContain("top-secret")
      expect(JSON.stringify(fallback)).not.toContain("sensitive observer failure")
      expect(fallback).toMatchObject({ structuredContent: { title: "Bash command dispatched", outcome: "dispatched" } })
      expect(BashToolResultSchema.safeParse(fallback.structuredContent).success).toBeTrue()
    } finally { await close() }
  })

  test("heartbeats periodically while an observation request is stalled without overlap", async () => {
    const backend = new StubBackend()
    backend.stallObservation = true
    const controller = new AbortController()
    const receipt = dispatchedReceipt(`job_${"d".repeat(32)}`, "secret command")
    const progress: number[] = []
    let attempts = 0, sends = 0, maximumSends = 0
    const result = absorbBashReceipt(backend, sandbox.sandboxId, receipt, {
      signal: controller.signal,
      progressToken: "request-token",
      sendNotification(notification) {
        attempts += 1
        if (attempts === 1) throw new Error("progress transport failed")
        return (async () => {
          sends += 1; maximumSends = Math.max(maximumSends, sends)
          progress.push(notification.params.progress)
          await Bun.sleep(5)
          sends -= 1
          if (progress.length === 3) controller.abort()
        })()
      },
    }, 1)

    expect(await result).toMatchObject({ structuredContent: { outcome: "dispatched" } })
    expect(progress).toEqual([2, 3, 4])
    expect(attempts).toBe(4)
    expect(maximumSends).toBe(1)
    expect(JSON.stringify(progress)).not.toContain("secret command")
    expect(backend.cleanupCalls).toBe(0)
  })

  test("commits terminal drain before caller cancellation during cleanup", async () => {
    const backend = new StubBackend()
    const controller = new AbortController()
    const receipt = dispatchedReceipt(`job_${"e".repeat(32)}`, "secret command")
    backend.bashObservation = { jobId: receipt.metadata.jobId, state: "completed", chunkBase64: Buffer.from("complete").toString("base64"), nextOffset: 8, outputSize: 8, exitCode: 0, signal: null, timedOut: false, durationMs: 1 }
    backend.cleanupHook = signal => { expect(signal).not.toBe(controller.signal); expect(signal.aborted).toBeFalse(); controller.abort(); throw new Error("cleanup failed") }

    const result = await absorbBashReceipt(backend, sandbox.sandboxId, receipt, { signal: controller.signal, sendNotification: async () => {} }, 1)

    expect(result).toMatchObject({ content: [{ text: "complete" }], structuredContent: { title: "Bash command", outcome: "completed" } })
    expect(backend.cleanupCalls).toBe(1)
  })

  test("returns completed without waiting for cleanup and stops heartbeats", async () => {
    const backend = new StubBackend()
    const receipt = dispatchedReceipt(`job_${"1".repeat(32)}`, "secret command")
    backend.bashObservation = { jobId: receipt.metadata.jobId, state: "completed", chunkBase64: Buffer.from("complete").toString("base64"), nextOffset: 8, outputSize: 8, exitCode: 0, signal: null, timedOut: false, durationMs: 1 }
    backend.neverResolveCleanup = true
    let cleanupSignal: AbortSignal | undefined
    let resolveCleanupAbort!: () => void
    const cleanupAborted = new Promise<void>(resolve => { resolveCleanupAbort = resolve })
    backend.cleanupHook = signal => {
      cleanupSignal = signal
      signal.addEventListener("abort", resolveCleanupAbort, { once: true })
    }
    const progress: number[] = []
    const caller = new AbortController()

    const operation = absorbBashReceipt(backend, sandbox.sandboxId, receipt, {
      signal: caller.signal,
      progressToken: "cleanup-test",
      async sendNotification(notification) { progress.push(notification.params.progress) },
    }, 2, 10)
    const result = await Promise.race([operation, Bun.sleep(100).then(() => { throw new Error("Completed result waited for cleanup") })])
    const progressAtCompletion = progress.length
    expect(cleanupSignal).toBeDefined()
    expect(cleanupSignal).not.toBe(caller.signal)
    expect(cleanupSignal?.aborted).toBeFalse()
    await Promise.race([cleanupAborted, Bun.sleep(100).then(() => { throw new Error("Cleanup deadline did not abort") })])
    await Bun.sleep(5)

    expect(result).toMatchObject({ content: [{ text: "complete" }], structuredContent: { outcome: "completed" } })
    expect(backend.cleanupCalls).toBe(1)
    expect(cleanupSignal?.aborted).toBeTrue()
    expect((cleanupSignal?.reason as DOMException).name).toBe("TimeoutError")
    expect(progress.length).toBe(progressAtCompletion)
  })

  test("stream-decodes split and invalid UTF-8 while draining beyond retained output", async () => {
    const backend = new StubBackend()
    const jobId = `job_${"c".repeat(32)}`
    backend.bashEvent = { type: "result", outcome: "dispatched", title: "Bash command dispatched", output: "dispatched", metadata: {
      command: "large-output", workdir: "/workspace", jobId,
      outputPath: `/run/waterbox/bash-jobs/${jobId}/output.log`, statusPath: `/run/waterbox/bash-jobs/${jobId}/status.json`,
    } }
    const raw = Buffer.concat([Buffer.from([0xe2]), Buffer.from([0x82, 0xac, 0x80]), Buffer.alloc(1_100_000, 0x78)])
    const chunks = [raw.subarray(0, 1), raw.subarray(1, 4), ...Array.from({ length: Math.ceil((raw.length - 4) / 65_536) }, (_, index) => raw.subarray(4 + index * 65_536, 4 + (index + 1) * 65_536))]
    const expectedOffsets: number[] = []
    let offset = 0
    for (const chunk of chunks) {
      expectedOffsets.push(offset)
      offset += chunk.byteLength
      backend.bashObservations.push({ jobId, state: offset === raw.length ? "completed" : "running", chunkBase64: chunk.toString("base64"), nextOffset: offset, outputSize: raw.length, ...(offset === raw.length ? { exitCode: 0, signal: null, timedOut: false, durationMs: 10 } : {}) })
    }
    const { client, close } = await connected(backend)
    try {
      const result = await client.callTool({ name: "bash", arguments: { sandboxId: sandbox.sandboxId, command: "large-output" } })
      const text = ((result as { content: Array<{ text: string }> }).content[0]!).text
      expect(text.startsWith("€�xxx")).toBeTrue()
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1_048_576)
      expect(result).toMatchObject({ structuredContent: { metadata: { outputTruncated: true } } })
      expect(backend.observedOffsets).toEqual(expectedOffsets)
      expect(backend.observedOffsets.at(-1)).toBeLessThan(raw.length)
      expect(backend.cleanupCalls).toBe(1)
    } finally { await close() }
  })
})

class StubBackend implements McpBackend {
  executeCalls = 0
  readonly createInputs: Array<{ request: CreateSandboxRequest; idempotencyKey: string }> = []
  readonly lifecycleCalls: string[] = []
  readonly executedSandboxIds: SandboxId[] = []
  securePlaintext = ""
  secureCiphertext = ""
  private secureIdentity?: string
  bashEvent?: ToolEventByName["bash"]
  bashObservation?: { jobId: string; state: "completed"; chunkBase64: string; nextOffset: number; outputSize: number; exitCode: number; signal: null; timedOut: boolean; durationMs: number }
  bashObservations: Array<any> = []
  observationError?: unknown
  stallObservation = false
  observedOffsets: number[] = []
  cleanupCalls = 0
  cleanupHook?: (signal: AbortSignal) => void
  neverResolveCleanup = false

  async createSandbox(request: CreateSandboxRequest, idempotencyKey: string): Promise<Sandbox> {
    this.createInputs.push({ request, idempotencyKey })
    return sandbox
  }

  async probeSandbox(): Promise<Sandbox> { this.lifecycleCalls.push("probeSandbox"); return sandbox }
  async deleteSandbox(): Promise<Sandbox> { this.lifecycleCalls.push("deleteSandbox"); return { ...sandbox, state: "terminated" } }
  async listSnapshots(request: CursorPaginationRequest) { this.lifecycleCalls.push("listSnapshots"); return { items: [snapshot], ...(request.limit === 1 ? { nextCursor: "cursor" } : {}) } }
  async createSnapshot(_sandboxId: SandboxId, _request: CreateSnapshotRequest): Promise<Snapshot> { this.lifecycleCalls.push("createSnapshot"); return snapshot }
  async deleteSnapshot(_snapshotId: SnapshotId): Promise<Snapshot> { this.lifecycleCalls.push("deleteSnapshot"); return { ...snapshot, state: "deleted" } }
  async initiateSecureFileTransfer() {
    this.secureIdentity = await generateX25519Identity()
    return { transferId: "123e4567-e89b-42d3-a456-426614174000" as const, publicKey: await identityToRecipient(this.secureIdentity), algorithm: "age-x25519" as const, expiresAt: "2099-01-01T00:00:00.000Z" }
  }
  async consumeSecureFileTransfer(_sandboxId: SandboxId, transferId: SecureTransferId, request: SecureTransferConsumeRequest) {
    this.secureCiphertext = request.ciphertext
    const decrypter = new Decrypter()
    decrypter.addIdentity(this.secureIdentity!)
    const plaintext = await decrypter.decrypt(Buffer.from(request.ciphertext, "base64"), "text")
    this.securePlaintext = plaintext
    return { transferId, targetPath: request.targetPath, bytes: Buffer.byteLength(plaintext) }
  }

  async executeTool<N extends ToolName>(
    sandboxId: SandboxId,
    toolName: N,
    _arguments: ToolArgumentsByName[N],
  ): Promise<AsyncIterable<ToolEventByName[N]>> {
    this.executeCalls++
    this.executedSandboxIds.push(sandboxId)
    const event = toolName === "bash" && this.bashEvent ? this.bashEvent : toolEvent(toolName)
    return oneEvent(event as ToolEventByName[N])
  }

  async observeBashJob(_sandboxId: SandboxId, _jobId: string, offset: number, _maxBytes: number, signal: AbortSignal) {
    this.observedOffsets.push(offset)
    if (this.stallObservation) await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
    if (this.observationError) throw this.observationError
    const queued = this.bashObservations.shift()
    if (queued) return queued
    if (!this.bashObservation) throw new Error("No Bash observation")
    return this.bashObservation
  }

  async cleanupBashJob(_sandboxId: SandboxId, _jobId: string, signal: AbortSignal) {
    this.cleanupCalls++
    this.cleanupHook?.(signal)
    if (this.neverResolveCleanup) await new Promise<void>(() => {})
  }

  async close(): Promise<void> {}
}

function dispatchedReceipt(jobId: string, command: string) {
  const result = BashToolResultSchema.parse({ title: "Bash command dispatched", output: "dispatched", outcome: "dispatched", metadata: {
    command, workdir: "/workspace", jobId,
    outputPath: `/run/waterbox/bash-jobs/${jobId}/output.log`, statusPath: `/run/waterbox/bash-jobs/${jobId}/status.json`,
  } })
  if (result.outcome !== "dispatched") throw new Error("Expected dispatched receipt")
  return result
}

class ValidFakeProvider extends FakeSandboxProvider {
  readonly toolNames: ToolName[] = []

  override executeTool<N extends ToolName>(input: ProviderExecuteInput<N>): AsyncIterable<ToolEventByName[N]> {
    this.toolNames.push(input.toolName)
    return oneEvent(toolEvent(input.toolName) as ToolEventByName[N])
  }
}

function toolEvent(name: ToolName): ToolEventByName[ToolName] {
  const events = {
    read: { type: "result", title: "read", output: "B\n", metadata: { filePath: "/workspace/a.txt", type: "text", offset: 1, lines: 1, totalLines: 1, truncated: false } },
    write: { type: "result", title: "write", output: "", metadata: { filePath: "/workspace/a.txt", bytes: 2 } },
    edit: { type: "result", title: "edit", output: "", metadata: { filePath: "/workspace/a.txt", replacements: 1, bytes: 2 } },
    patch: { type: "result", title: "patch", output: "", metadata: { added: [], updated: [], deleted: [], moved: [] } },
    glob: { type: "result", title: "glob", output: "/workspace/a.txt\n", metadata: { pattern: "*.txt", path: "/workspace", count: 1, truncated: false } },
    grep: { type: "result", title: "grep", output: "/workspace/a.txt:1:B\n", metadata: { pattern: "B", path: "/workspace", matches: 1, truncated: false } },
    bash: { type: "result", outcome: "completed", title: "bash", output: "/workspace\n", metadata: { command: "pwd", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } },
  } as const
  return events[name] as unknown as ToolEventByName[ToolName]
}

async function* oneEvent<N extends ToolName>(event: ToolEventByName[N]): AsyncIterable<ToolEventByName[N]> {
  yield event
}

async function connected(backend: McpBackend) {
  const server = createWaterboxMcpServer(backend)
  const client = new Client({ name: "test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    async close() {
      await Promise.all([client.close(), server.close()])
      await backend.close()
    },
  }
}
