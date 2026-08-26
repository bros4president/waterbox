import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createPiMcpServer, parseOptions } from "./server.ts"

describe("Pi MCP facade", () => {
  test("discovers and proxies Pi tools with sandbox authentication headers", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith("/v1/pi/tools")) {
        return Response.json([{
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        }])
      }
      return Response.json({ content: [{ type: "text", text: "contents" }] })
    }) as typeof fetch

    const server = createPiMcpServer({ url: "https://sandbox.example/original", headers: { Authorization: "token" } }, fetcher)
    const client = new Client({ name: "test", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      expect((await client.listTools()).tools).toEqual([{
        name: "read",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }])
      expect(await client.callTool({ name: "read", arguments: { path: "README.md" } })).toMatchObject({
        content: [{ type: "text", text: "contents" }],
      })
      expect(requests.map((request) => request.url)).toEqual([
        "https://sandbox.example/v1/pi/tools",
        "https://sandbox.example/v1/pi/tools/read",
      ])
      expect(new Headers(requests[1]!.init?.headers).get("Authorization")).toBe("token")
      expect(new Headers(requests[1]!.init?.headers).get("X-aws-proxy-port")).toBe("8080")
      expect(requests[1]!.init?.body).toBe(JSON.stringify({ path: "README.md" }))
    } finally {
      await Promise.all([client.close(), server.close()])
    }
  })

  test("parses environment and repeated CLI header options", () => {
    expect(parseOptions(
      ["--url", "sandbox.example", "--header", "X-One: first", "--header=X-Two: second"],
      { PI_SANDBOX_HEADERS: JSON.stringify({ Authorization: "token" }) },
    )).toEqual({
      url: "sandbox.example",
      headers: { Authorization: "token", "X-One": "first", "X-Two": "second" },
    })
  })
})
