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
import { createStartupClient, startupMessage } from "../src/main.ts"
import { createHostedMcpClient } from "../src/composition.ts"
import { createWaterboxMcpServer } from "../src/server.ts"
import { readLocalFile } from "../src/secure-transfer.ts"

const sandbox: Sandbox = { sandboxId: "sbx_calm-forest-abc1", provider: "box", state: "running", version: 1, createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" }

describe("Waterbox MCP client renderer", () => {
  test("renders actionable incompatible-schema startup guidance without exposing unknown errors", () => {
    const incompatible = new Error("Incompatible Waterbox SQLite schema at /users/test/.waterbox/direct.sqlite. Move the database before starting the current build.")
    incompatible.name = "IncompatibleRepositorySchemaError"
    expect(startupMessage(incompatible)).toBe(incompatible.message)
    expect(startupMessage(new Error("secret internal detail"))).toBe("Waterbox MCP failed to start")
  })

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
      const listedTools = (await connection.client.listTools()).tools
      expect(connection.client.getInstructions()).toBe("Waterbox gives agents the ability to create, manage, and command isolated sandboxes.\n\nUse Waterbox when instructed by the user or when additional isolated compute would be useful, such as avoiding pressure on the local machine or running parallel work without workspace conflicts.\n\nWaterbox tools fall into two groups:\n\n- **Daily workflow:** create a sandbox, operate on it, then stop it.\n- **Reusable setup utilities:** list and create snapshots to avoid repeating environment setup.\n\n**Core workflow**\n\n1. Create a sandbox as the execution environment for your work.\n2. Use the filesystem and command tools to work inside the sandbox.\n3. When the task is complete and all material outcomes expected outside the sandbox have been exported or otherwise preserved, stop the sandbox to avoid unnecessary compute costs. Do not stop it merely because a conversational turn has ended while work remains active.\n\nSandbox filesystem state is resumable, but retention is provider-dependent. Neither sandboxes nor snapshots are definitive storage. Export material outcomes when the task is complete.\n\n**Reusable setup pattern**\n\nWhen you detect repeated setup work or dependencies, consider creating a snapshot so future sandboxes can start from a prepared environment. Give snapshots clear names and descriptions, and preserve reusable dependencies, tools, CLIs, and other environment preparation. Keep task-specific work in source control or another definitive external store so snapshots do not seed future work with stale project state.")
      expect(listedTools.map(tool => tool.name)).toEqual(["create_sandbox", "probe_sandbox", "stop_sandbox", "list_snapshots", "create_snapshot", "delete_snapshot", "send_file_securely", "read", "write", "edit", "patch", "glob", "grep", "bash"])
      expect(listedTools.find(tool => tool.name === "create_sandbox")?.description).toBe("Creates a sandbox for coding work, optionally seeded from a reusable snapshot. Reuse `idempotencyKey` to retry the same creation safely; use a new key to create another sandbox.")
      expect(listedTools.find(tool => tool.name === "list_snapshots")?.description).toBe("Lists user-owned Waterbox snapshots with cursor pagination. Use it to find snapshots referenced by the user by name, description, or intended environment.")
      expect(listedTools.find(tool => tool.name === "create_snapshot")?.description).toBe("Creates a reusable setup snapshot from a running sandbox. Give it a clear name and description so future agents can discover its purpose. This is a setup tool: use snapshots to preserve reusable environments, not for routine pauses or as definitive storage for completed work.")
      expect(listedTools.find(tool => tool.name === "stop_sandbox")?.description).toBe("Stops compute while preserving resumable filesystem state, subject to provider behavior. No separate resume step is needed. If more coding work is required, the next coding tool call resumes the sandbox before performing the requested operation. Recommended usage: use it as a cleanup step to avoid spending more compute after the task's material outcomes are complete and available outside the sandbox, for example in a pull request or another exported deliverable. Because resuming adds latency, do not stop merely because a conversational turn has ended.")
      expect(listedTools.map(tool => tool.name)).not.toContain("delete_sandbox")
      expect(listedTools.map(tool => tool.name)).not.toContain("resume_sandbox")
      expect(listedTools.map(tool => tool.name)).not.toContain("list_sandboxes")
      for (const name of ["read", "write", "edit", "patch", "glob", "grep", "bash"]) {
        const description = listedTools.find(tool => tool.name === name)?.description
        expect(description).toContain("sandbox workspace")
        expect(description).not.toContain("/workspace")
      }
      const result = await connection.client.callTool({ name: "read", arguments: { sandboxId: sandbox.sandboxId, filePath: "/workspace/a.txt" } })
      expect(result).toMatchObject({ content: [{ text: expect.stringContaining('"output":"A\\n"') }] })
      expect(reads).toBe(1)
      expect(await connection.client.callTool({ name: "read", arguments: { filePath: "/workspace/a.txt" } })).toMatchObject({ isError: true, content: [{ text: "Invalid arguments for read" }] })
      expect(reads).toBe(1)
    } finally { await connection.close() }
  })

  test("validates, dispatches, and safely renders stop_sandbox", async () => {
    let stops = 0
    const commands = stubClient({
      async stopSandbox(input: any) { stops += 1; expect(input).toEqual({ sandboxId: sandbox.sandboxId }); return { ...sandbox, state: "stopped" } },
    })
    const connection = await connected(commands)
    try {
      expect(await connection.client.callTool({ name: "stop_sandbox", arguments: { sandboxId: sandbox.sandboxId } })).toMatchObject({ content: [{ text: expect.stringContaining('"state":"stopped"') }] })
      expect(stops).toBe(1)
      expect(await connection.client.callTool({ name: "stop_sandbox", arguments: { sandboxId: "not-a-sandbox" } })).toMatchObject({ isError: true, content: [{ text: "Invalid arguments for stop_sandbox" }] })
      expect(stops).toBe(1)
    } finally { await connection.close() }

    const failing = await connected(stubClient({ async stopSandbox() { throw new WaterboxClientError("Stopping failed", { status: 502, code: "provider_failure" }) } }))
    try { expect(await failing.client.callTool({ name: "stop_sandbox", arguments: { sandboxId: sandbox.sandboxId } })).toMatchObject({ isError: true, content: [{ text: "Waterbox MCP request failed" }] }) }
    finally { await failing.close() }
  })

  test("keeps host plaintext out of arguments and clears it after the client settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-mcp-file-")); const sourcePath = join(directory, "secret"); const secret = "plaintext-never-model-visible"; let supplied: Uint8Array | undefined
    await writeFile(sourcePath, secret)
    const commands = stubClient({ async sendFileSecurely(input: any) { supplied = input.plaintext; expect(new TextDecoder().decode(input.plaintext)).toBe(secret); expect(input).not.toHaveProperty("sourcePath"); return { sandboxId: sandbox.sandboxId, transferId: `xfer_${"a".repeat(32)}`, targetPath: "/root/secret", bytes: secret.length } } })
    const connection = await connected(commands)
    try { const result = await connection.client.callTool({ name: "send_file_securely", arguments: { sandboxId: sandbox.sandboxId, sourcePath, targetPath: "/root/secret" } }); expect(JSON.stringify(result)).not.toContain(secret); expect(supplied && Array.from(supplied).every(byte => byte === 0)).toBeTrue() }
    finally { await connection.close(); await rm(directory, { recursive: true, force: true }) }
  })

  test("clears an owned host buffer when a partial read aborts before transfer", async () => {
    const controller = new AbortController()
    let allocated: Uint8Array | undefined
    let reads = 0
    const regular = { isFile: () => true, size: 3 }
    const handle = {
      async stat() { return regular },
      async read(buffer: Uint8Array) {
        reads += 1
        buffer.set([1, 2, 3])
        controller.abort(new DOMException("test abort", "AbortError"))
        return { bytesRead: 3, buffer }
      },
      async close() {},
    }
    await expect(readLocalFile("ignored", controller.signal, {
      stat: (async () => regular) as any,
      open: (async () => handle) as any,
      allocate(size) { allocated = new Uint8Array(size); return allocated },
    })).rejects.toThrow("test abort")
    expect(reads).toBe(1)
    expect(allocated).toBeDefined()
    expect(allocated && allocated.every(byte => byte === 0)).toBeTrue()
  })

  test("maps client Bash progress and completed failures", async () => {
    const result: BashToolResult = { title: "Bash command", outcome: "completed", output: "failed", metadata: { command: "false", workdir: "/workspace", exitCode: 1, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } }
    const commands = stubClient({ async bash(_input: any, context: CommandContext) { await context.onProgress?.({ kind: "heartbeat", sequence: 7 }); return result } })
    const connection = await connected(commands)
    try { const progress: number[] = []; connection.client.setNotificationHandler(ProgressNotificationSchema, notification => { progress.push(notification.params.progress) }); const response = await connection.client.callTool({ name: "bash", arguments: { sandboxId: sandbox.sandboxId, command: "false" }, _meta: { progressToken: "p" } }); expect(response).toMatchObject({ isError: true, content: [{ text: "failed" }], structuredContent: { outcome: "completed" } }); expect(progress).toEqual([7]) }
    finally { await connection.close() }
  })

  test("preserves validated API recovery messages and rejects externally constructed client errors", async () => {
    const message = `Sandbox ${sandbox.sandboxId} may require recovery. Inspect it with probe_sandbox before retrying the operation.`
    const commands = new WaterboxClient(createRemoteApiBackend("http://waterbox.test/", async () => new Response(JSON.stringify({ error: { code: "provider_failure", message, requestId: "req_test", sandboxId: sandbox.sandboxId } }), { status: 502, headers: { "content-type": "application/json" } })))
    const connection = await connected(commands)
    try {
      expect(await connection.client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "recover-create" } })).toMatchObject({ isError: true, content: [{ text: message }] })
    }
    finally { await connection.close() }
    const spoofed = await connected(stubClient({ async createSandbox() { throw new WaterboxClientError("provider secret", { recoverySandboxId: sandbox.sandboxId }) } }))
    try { expect(await spoofed.client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "spoof" } })).toMatchObject({ isError: true, content: [{ text: "Waterbox MCP request failed" }] }) }
    finally { await spoofed.close() }
  })

  test("uses the captured validated client message after mutation", async () => {
    const approved = "The sandbox operation failed safely"
    const source = new WaterboxClient(createRemoteApiBackend("http://waterbox.test/", async () => new Response(JSON.stringify({ error: { code: "provider_failure", message: approved, requestId: "req_test" } }), { status: 502, headers: { "content-type": "application/json" } })))
    const commands = stubClient({ async createSandbox() { const error = await source.createSandbox({}, { idempotencyKey: "mutate", signal: new AbortController().signal }).catch(value => value); (error as Error).message = "mutated client secret"; throw error } })
    const connection = await connected(commands)
    try { expect(await connection.client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: "mutate" } })).toMatchObject({ isError: true, content: [{ text: approved }] }) }
    finally { await connection.close() }
  })

  test("keeps every tool side-effect free while setup is incomplete or unsupported", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waterbox-mcp-setup-")); const sqlitePath = join(directory, "must-not-exist.sqlite")
    const storage = { async read() { return undefined }, async write() {}, async remove() {} }, credentials = { async get() { return undefined }, async set() {}, async delete() { return false } }
    try { for (const environment of [{}, { WATERBOX_PROVIDER: "waterbox" }, { WATERBOX_PROVIDER: "box" }]) { const commands = await createStartupClient({ ...environment, WATERBOX_SQLITE_PATH: sqlitePath }, undefined, { storage, credentials }); const connection = await connected(commands); try { const response = await connection.client.callTool({ name: "send_file_securely", arguments: { sandboxId: sandbox.sandboxId, sourcePath: join(directory, "missing"), targetPath: "/root/secret" } }); expect(response).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("WATERBOX_PROVIDER") }] }); expect(existsSync(sqlitePath)).toBeFalse() } finally { await connection.close() } } }
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

  test("pins hosted calls to Waterbox and injects bearer authorization", async () => {
    const requests: Request[] = []
    const client = createHostedMcpClient({ provider: { type: "waterbox", apiKey: "hosted-secret" } }, async request => {
      requests.push(request)
      return new Response(JSON.stringify({ items: [] }), { headers: { "content-type": "application/json" } })
    })
    try { await client.listSnapshots({}, { signal: new AbortController().signal }) }
    finally { await client.close() }
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("https://api.waterbox.ai/v1/snapshots")
    expect(requests[0]!.method).toBe("GET")
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer hosted-secret")
    expect(requests[0]!.redirect).toBe("manual")
  })

  test("does not follow hosted redirects or expose redirect responses through MCP", async () => {
    for (const status of [301, 302, 307, 308]) {
      const requests: Request[] = []
      const commands = createHostedMcpClient({ provider: { type: "waterbox", apiKey: "hosted-secret" } }, async request => {
        requests.push(request)
        return new Response(JSON.stringify({ error: { code: "provider_failure", message: "redirect provider prose", requestId: "req_redirect" } }), { status, headers: { "content-type": "application/json", location: "https://attacker.example/redirect" } })
      })
      const connection = await connected(commands)
      try {
        const response = await connection.client.callTool({ name: "create_sandbox", arguments: { idempotencyKey: `redirect-${status}` } })
        expect(response).toMatchObject({ isError: true, content: [{ text: "The Waterbox API returned an invalid response" }] })
        expect(JSON.stringify(response)).not.toContain("redirect provider prose")
      } finally { await connection.close() }
      expect(requests).toHaveLength(1)
      expect(requests[0]!.url).toBe("https://api.waterbox.ai/v1/sandboxes")
      expect(requests[0]!.redirect).toBe("manual")
      expect(requests[0]!.headers.get("authorization")).toBe("Bearer hosted-secret")
    }
  })

  test("rejects removed delete_sandbox calls as unknown tools", async () => {
    const connection = await connected(stubClient({}))
    try { await expect(connection.client.callTool({ name: "delete_sandbox", arguments: { sandboxId: sandbox.sandboxId } })).resolves.toMatchObject({ isError: true, content: [{ text: "Unknown Waterbox tool" }] }) }
    finally { await connection.close() }
  })
})

function stubClient(overrides: Record<string, unknown>): WaterboxClient { return Object.assign(new WaterboxClient(createRemoteApiBackend("http://waterbox.test/", async () => { throw new Error("unexpected HTTP request") })), overrides) }
async function connected(commands: WaterboxClient) { const server = createWaterboxMcpServer(commands); const client = new Client({ name: "test", version: "1" }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]); return { client, async close() { await Promise.all([client.close(), server.close()]); await commands.close() } } }
