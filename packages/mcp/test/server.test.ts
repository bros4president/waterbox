import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
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
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ProviderExecuteInput,
  ToolArgumentsByName,
  ToolEventByName,
} from "@waterbox/core/provider"
import { FakeSandboxProvider, FixedClock, SequenceIdGenerator } from "@waterbox/core/test-support"
import type { McpBackend } from "../src/backend.ts"
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
      systemTemplateRef: "waterbox-system-v5",
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

  test("fails the acknowledged Waterbox provider before creating local state", async () => {
    await expect(createMcpBackend({ provider: { type: "waterbox" } })).rejects.toBeInstanceOf(UnsupportedMcpProviderError)
    await expect(createMcpBackend({ provider: { type: "waterbox" } })).rejects.toThrow('provider "waterbox" is not supported yet')
  })

  test("stays connected and explains how to provide a missing Box credential", async () => {
    const backend = await createStartupBackend({ WATERBOX_PROVIDER: "box" })
    const { client, close } = await connected(backend)
    try {
      expect((await client.listTools()).tools).toHaveLength(14)
      expect(await client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "missing-credential" } })).toMatchObject({
        isError: true,
        content: [{ text: "BOX_API_KEY is required for the Box provider. Configure it using your MCP client's recommended secret or environment mechanism, then restart the client. Do not provide the key in chat or as a tool argument." }],
      })
    } finally {
      await close()
    }
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
    return oneEvent(toolEvent(toolName) as ToolEventByName[N])
  }

  async close(): Promise<void> {}
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
    bash: { type: "result", title: "bash", output: "/workspace\n", metadata: { command: "pwd", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } },
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
