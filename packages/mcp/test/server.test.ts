import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { WaterboxClient, WaterboxClientError, createRemoteApiBackend, type CommandContext } from "@waterbox/client"
import { createEmbeddedApiBackend } from "@waterbox/control-plane-local"
import { FakeSandboxProvider, FixedClock, SequenceIdGenerator } from "@waterbox/core/test-support"
import type { BashToolResult, Sandbox } from "@waterbox/contracts"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStartupClient } from "../src/main.ts"
import { createWaterboxMcpServer } from "../src/server.ts"

const sandbox: Sandbox = { sandboxId: "sbx_calm-forest-abc1", provider: "box", state: "running", version: 1, createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" }

describe("Waterbox MCP client renderer", () => {
  test("preserves the exact tool inventory and maps ordinary tools to one client command", async () => {
    let reads = 0
    const commands = stubClient({
      async read(input: any) {
        reads += 1
        expect(input).toEqual({ sandboxId: sandbox.sandboxId, filePath: "/workspace/a.txt" })
        return { title: "read", output: "A\n", metadata: { filePath: "/workspace/a.txt", type: "text", offset: 1, lines: 1, totalLines: 1, truncated: false } }
      },
    })
    const connection = await connected(commands)
    try {
      expect((await connection.client.listTools()).tools.map(tool => tool.name)).toEqual(["create_sandbox", "probe_sandbox", "delete_sandbox", "list_snapshots", "create_snapshot", "delete_snapshot", "send_file_securely", "read", "write", "edit", "patch", "glob", "grep", "bash"])
      const result = await connection.client.callTool({ name: "read", arguments: { sandboxId: sandbox.sandboxId, filePath: "/workspace/a.txt" } })
      expect(result).toMatchObject({ content: [{ text: expect.stringContaining('"output":"A\\n"') }] })
      expect(reads).toBe(1)
      expect(await connection.client.callTool({ name: "read", arguments: { filePath: "/workspace/a.txt" } })).toMatchObject({ isError: true, content: [{ text: "Invalid arguments for Waterbox read" }] })
      expect(reads).toBe(1)
    } finally { await connection.close() }
  })

  test("keeps host plaintext out of arguments and clears it after the client settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-mcp-file-")); const sourcePath = join(directory, "secret"); const secret = "plaintext-never-model-visible"; let supplied: Uint8Array | undefined
    await writeFile(sourcePath, secret)
    const commands = stubClient({ async sendFileSecurely(input: any) { supplied = input.plaintext; expect(new TextDecoder().decode(input.plaintext)).toBe(secret); expect(input).not.toHaveProperty("sourcePath"); return { sandboxId: sandbox.sandboxId, transferId: `xfer_${"a".repeat(32)}`, targetPath: "/root/secret", bytes: secret.length } } })
    const connection = await connected(commands)
    try { const result = await connection.client.callTool({ name: "send_file_securely", arguments: { sandboxId: sandbox.sandboxId, sourcePath, targetPath: "/root/secret" } }); expect(JSON.stringify(result)).not.toContain(secret); expect(supplied && Array.from(supplied).every(byte => byte === 0)).toBeTrue() }
    finally { await connection.close(); await rm(directory, { recursive: true, force: true }) }
  })

  test("maps client Bash progress and completed failures", async () => {
    const result: BashToolResult = { title: "Bash command", outcome: "completed", output: "failed", metadata: { command: "false", workdir: "/workspace", exitCode: 1, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } }
    const commands = stubClient({ async bash(_input: any, context: CommandContext) { await context.onProgress?.({ kind: "heartbeat", sequence: 7 }); return result } })
    const connection = await connected(commands)
    try { const progress: number[] = []; connection.client.setNotificationHandler(ProgressNotificationSchema, notification => { progress.push(notification.params.progress) }); const response = await connection.client.callTool({ name: "bash", arguments: { sandboxId: sandbox.sandboxId, command: "false" }, _meta: { progressToken: "p" } }); expect(response).toMatchObject({ isError: true, content: [{ text: "failed" }], structuredContent: { outcome: "completed" } }); expect(progress).toEqual([7]) }
    finally { await connection.close() }
  })

  test("renders safe recovery guidance from validated client errors", async () => {
    const commands = stubClient({ async createSandbox() { throw new WaterboxClientError("Sandbox preparation failed", { status: 503, code: "provider_failure", recoverySandboxId: sandbox.sandboxId }) } })
    const connection = await connected(commands)
    try { const response = await connection.client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "recover-create" } }); const rendered = JSON.stringify(response); expect(rendered).toContain(sandbox.sandboxId); expect(rendered).toContain("same idempotency key"); expect(rendered).toContain("probe_sandbox"); expect(rendered).not.toContain("requestId"); expect(response).toMatchObject({ isError: true }) }
    finally { await connection.close() }
  })

  test("keeps every tool side-effect free while setup is incomplete or unsupported", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-mcp-setup-")); const sqlitePath = join(directory, "must-not-exist.sqlite")
    try { for (const environment of [{}, { WATERBOX_PROVIDER: "waterbox" }, { WATERBOX_PROVIDER: "box" }]) { const commands = await createStartupClient({ ...environment, WATERBOX_SQLITE_PATH: sqlitePath }); const connection = await connected(commands); try { const response = await connection.client.callTool({ name: "send_file_securely", arguments: { sandboxId: sandbox.sandboxId, sourcePath: join(directory, "missing"), targetPath: "/root/secret" } }); expect(response).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("WATERBOX_PROVIDER=box") }] }); expect(existsSync(sqlitePath)).toBeFalse() } finally { await connection.close() } } }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  test("runs MCP through the real client, authenticated embedded API, core, SQLite, and provider", async () => {
    const provider = new FakeSandboxProvider({ name: "box" })
    const backend = await createEmbeddedApiBackend({ sqlitePath: ":memory:", accountId: "local", provider: { kind: "injected", implementation: provider } }, {
      clock: new FixedClock("2026-08-27T00:00:00.000Z"), ids: new SequenceIdGenerator([sandbox.sandboxId]),
    })
    const commands = new WaterboxClient(backend)
    const connection = await connected(commands)
    try {
      const created = await connection.client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "embedded-create" } })
      expect(created).toMatchObject({ content: [{ text: expect.stringContaining(sandbox.sandboxId) }] })
      expect(provider.createCalls).toBe(1)
    } finally { await connection.close() }
  })
})

function stubClient(overrides: Record<string, unknown>): WaterboxClient { return Object.assign(new WaterboxClient(createRemoteApiBackend("http://waterbox.test/", async () => { throw new Error("unexpected HTTP request") })), overrides) }
async function connected(commands: WaterboxClient) { const server = createWaterboxMcpServer(commands); const client = new Client({ name: "test", version: "1" }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]); return { client, async close() { await Promise.all([client.close(), server.close()]); await commands.close() } } }
