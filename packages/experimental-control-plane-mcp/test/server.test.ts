import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExperimentalMcpServer, parseExperimentalMcpOptions } from "../src/server.ts"

const sandbox = { sandboxId: "sbx_calm-forest-abc1", provider: "box", state: "running", version: 1, createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" }

describe("experimental control-plane MCP", () => {
  test("creates one sandbox and proxies all seven tools", async () => {
    const requests: Request[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); requests.push(request)
      if (request.url.endsWith("/v1/sandboxes")) return Response.json(sandbox, { status: 201 })
      const name = request.url.split("/").at(-1)!
      return new Response(toolResponse(name), { headers: { "content-type": "application/x-ndjson" } })
    }) as typeof fetch
    const directory = await mkdtemp(join(tmpdir(), "waterbox-mcp-test-")), statePath = join(directory, "state.json")
    const server = createExperimentalMcpServer({ apiUrl: "http://127.0.0.1:8787", apiKey: "local-secret", idempotencyKey: "smoke-run", statePath }, fetcher)
    const client = new Client({ name: "test", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["create_sandbox", "read", "write", "edit", "patch", "glob", "grep", "bash"])
      await client.callTool({ name: "create_sandbox", arguments: {} })
      await client.callTool({ name: "create_sandbox", arguments: {} })
      await client.callTool({ name: "write", arguments: { filePath: "/workspace/a.txt", content: "A\n" } })
      await client.callTool({ name: "read", arguments: { filePath: "/workspace/a.txt" } })
      await client.callTool({ name: "edit", arguments: { filePath: "/workspace/a.txt", oldString: "A", newString: "B" } })
      await client.callTool({ name: "patch", arguments: { patchText: "*** Begin Patch\n*** End Patch" } })
      await client.callTool({ name: "glob", arguments: { pattern: "*.txt", path: "/workspace" } })
      await client.callTool({ name: "grep", arguments: { pattern: "B", path: "/workspace" } })
      expect(await client.callTool({ name: "bash", arguments: { command: "pwd" } })).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("/workspace") }] })
      expect(requests.filter(request => request.url.endsWith("/v1/sandboxes"))).toHaveLength(1)
      expect(requests.filter(request => request.url.includes("/tools/"))).toHaveLength(7)
      expect(requests[0]!.headers.get("authorization")).toBe("Bearer local-secret")
      expect(requests[0]!.headers.get("idempotency-key")).toBe("smoke-run")
      const state = JSON.parse(await readFile(statePath, "utf8"))
      expect(Object.values(state.calls)).toEqual(Array.from({ length: 7 }, () => ({ attempted: 1, completed: 1 })))
    } finally { await Promise.all([client.close(), server.close()]); await rm(directory, { recursive: true, force: true }) }
  })

  test("keeps secrets out of MCP errors and validates configuration", async () => {
    const fetcher = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("do-not-print", { status: 500 })) as typeof fetch
    const server = createExperimentalMcpServer({ apiUrl: "http://127.0.0.1:8787", apiKey: "do-not-print", idempotencyKey: "smoke-run" }, fetcher)
    const client = new Client({ name: "test", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const result = await client.callTool({ name: "create_sandbox", arguments: {} })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).not.toContain("do-not-print")
    } finally { await Promise.all([client.close(), server.close()]) }
    expect(() => parseExperimentalMcpOptions({ WATERBOX_API_URL: "file:///tmp/x", WATERBOX_API_KEY: "key", WATERBOX_MCP_IDEMPOTENCY_KEY: "run" })).toThrow("invalid")
  })
})

function toolResponse(name: string): string {
  const events: Record<string, unknown> = {
    read: { type: "result", title: "read", output: "A\n", metadata: { filePath: "/workspace/a.txt", type: "text", offset: 1, lines: 1, totalLines: 1, truncated: false } },
    write: { type: "result", title: "write", output: "", metadata: { filePath: "/workspace/a.txt", bytes: 2 } },
    edit: { type: "result", title: "edit", output: "", metadata: { filePath: "/workspace/a.txt", replacements: 1, bytes: 2 } },
    patch: { type: "result", title: "patch", output: "", metadata: { added: [], updated: [], deleted: [], moved: [] } },
    glob: { type: "result", title: "glob", output: "/workspace/a.txt\n", metadata: { pattern: "*.txt", path: "/workspace", count: 1, truncated: false } },
    grep: { type: "result", title: "grep", output: "/workspace/a.txt:1:B\n", metadata: { pattern: "B", path: "/workspace", matches: 1, truncated: false } },
  }
  if (name === "bash") return `${JSON.stringify({ type: "stdout", data: "/workspace\n" })}\n${JSON.stringify({ type: "result", title: "bash", output: "/workspace\n", metadata: { command: "pwd", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } })}\n`
  return `${JSON.stringify(events[name])}\n`
}
