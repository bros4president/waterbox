import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { BashToolResultSchema } from "@waterbox/contracts"
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

  test("absorbs a dispatched bash receipt without adding a job tool", async () => {
    const jobId = `job_${"a".repeat(32)}`
    const receipt = {
      type: "result", outcome: "dispatched", title: "Bash command dispatched", output: "Command dispatched. statusPath reports execution state, and outputPath receives output continuously. Repeated output reads can duplicate tokens and pollute context.", metadata: {
        command: "sleep 20", workdir: "/workspace", timeout: 20_000, jobId,
        outputPath: `/run/waterbox/bash-jobs/${jobId}/output.log`,
        statusPath: `/run/waterbox/bash-jobs/${jobId}/status.json`,
      },
    }
    const requests: Request[] = []
    let cleanupSignal: AbortSignal | undefined
    let resolveCleanupAbort!: () => void
    const cleanupAborted = new Promise<void>(resolve => { resolveCleanupAbort = resolve })
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); requests.push(request)
      if (request.url.endsWith("/v1/sandboxes")) return Response.json(sandbox, { status: 201 })
      if (request.url.endsWith("/observations")) { await Bun.sleep(25); return Response.json({ jobId, state: "completed", chunkBase64: Buffer.from("absorbed output").toString("base64"), nextOffset: 15, outputSize: 15, exitCode: 0, signal: null, timedOut: false, durationMs: 20 }) }
      if (request.method === "DELETE") {
        cleanupSignal = request.signal
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => { resolveCleanupAbort(); reject(request.signal.reason) }
          request.signal.addEventListener("abort", abort, { once: true })
          if (request.signal.aborted) abort()
        })
      }
      return new Response(`${JSON.stringify(receipt)}\n`, { headers: { "content-type": "application/x-ndjson" } })
    }) as typeof fetch
    const server = createExperimentalMcpServer({ apiUrl: "http://127.0.0.1:8787", apiKey: "local-secret", idempotencyKey: "smoke-run" }, fetcher, { bashObservationIntervalMs: 5, bashCleanupDeadlineMs: 10 })
    const client = new Client({ name: "test", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const listed = await client.listTools()
      expect(listed.tools.filter((tool) => tool.name === "bash")).toHaveLength(1)
      expect(listed.tools.some((tool) => tool.name.includes("job"))).toBeFalse()
      expect(listed.tools.find((tool) => tool.name === "bash")?.description).toBe("Runs unrestricted bash as root in the selected remote Waterbox sandbox, never on the local machine. The default working directory is /workspace.")
      expect(listed.tools.find((tool) => tool.name === "bash")?.outputSchema).toMatchObject({ type: "object" })
      await client.callTool({ name: "create_sandbox", arguments: {} })

      const progress: Array<{ progress: number; message?: string }> = []
      const result = await client.callTool({ name: "bash", arguments: { command: "sleep 20", timeout: 20_000 } }, undefined, { onprogress: value => { progress.push(value) }, timeout: 500 })
      const progressAtCompletion = progress.length
      expect(cleanupSignal).toBeDefined()
      expect(cleanupSignal?.aborted).toBeFalse()
      await Promise.race([cleanupAborted, Bun.sleep(100).then(() => { throw new Error("Cleanup deadline did not abort") })])
      await Bun.sleep(5)

      expect(result.isError).not.toBe(true)
      expect(result).toMatchObject({ content: [{ text: "absorbed output" }], structuredContent: { title: "Bash command", outcome: "completed", metadata: { exitCode: 0 } } })
      expect(BashToolResultSchema.safeParse(result.structuredContent).success).toBeTrue()
      expect(cleanupSignal?.aborted).toBeTrue()
      expect((cleanupSignal?.reason as DOMException).name).toBe("TimeoutError")
      expect(progress.length).toBeGreaterThanOrEqual(3)
      expect(progress.map(value => value.progress)).toEqual(progress.map((_value, index) => index + 1))
      expect(progress.length).toBe(progressAtCompletion)
      expect(JSON.stringify(progress)).not.toContain("sleep 20")
      expect(JSON.stringify(progress)).not.toContain(jobId)
      expect(requests.filter((request) => request.url.includes("/tools/bash"))).toHaveLength(1)
      expect(requests.filter((request) => request.url.endsWith("/observations"))).toHaveLength(1)
      expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1)
    } finally { await Promise.all([client.close(), server.close()]) }
  })

  test("renders canonical recovery paths when API observation fails", async () => {
    const jobId = `job_${"f".repeat(32)}`
    const receipt = { type: "result", outcome: "dispatched", title: "Bash command dispatched", output: "dispatched", metadata: {
      command: "top-secret command", workdir: "/workspace", jobId,
      outputPath: `/run/waterbox/bash-jobs/${jobId}/output.log`, statusPath: `/run/waterbox/bash-jobs/${jobId}/status.json`,
    } }
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/v1/sandboxes")) return Response.json(sandbox, { status: 201 })
      if (url.endsWith("/observations")) return new Response("sensitive observer failure", { status: 500 })
      return new Response(`${JSON.stringify(receipt)}\n`, { headers: { "content-type": "application/x-ndjson" } })
    }) as typeof fetch
    const server = createExperimentalMcpServer({ apiUrl: "http://127.0.0.1:8787", apiKey: "local-secret", idempotencyKey: "smoke-run" }, fetcher)
    const client = new Client({ name: "test", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      await client.callTool({ name: "create_sandbox", arguments: {} })
      const result = await client.callTool({ name: "bash", arguments: { command: "top-secret command" } })
      const text = ((result as { content: Array<{ text: string }> }).content[0]!).text
      expect(text).toContain(jobId)
      expect(text).toContain(receipt.metadata.statusPath)
      expect(text).toContain(receipt.metadata.outputPath)
      expect(text).not.toContain("top-secret command")
      expect(text).not.toContain("sensitive observer failure")
      expect(result).toMatchObject({ structuredContent: { title: "Bash command dispatched", outcome: "dispatched" } })
      expect(BashToolResultSchema.safeParse(result.structuredContent).success).toBeTrue()
    } finally { await Promise.all([client.close(), server.close()]) }
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
  if (name === "bash") return `${JSON.stringify({ type: "stdout", data: "/workspace\n" })}\n${JSON.stringify({ type: "result", outcome: "completed", title: "bash", output: "/workspace\n", metadata: { command: "pwd", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } })}\n`
  return `${JSON.stringify(events[name])}\n`
}
