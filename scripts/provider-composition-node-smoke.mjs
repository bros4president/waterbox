import assert from "node:assert/strict"
import { createMcpClient, parseMcpConfig } from "../packages/mcp/dist/index.js"

const originalFetch = globalThis.fetch

try {
  await smokeBox()
  await smokeVercel()
  process.stdout.write("provider composition Node smoke passed\n")
} finally {
  globalThis.fetch = originalFetch
}

async function smokeBox() {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    if (request.method === "POST" && url.pathname.endsWith("/boxes")) return Response.json({ ok: true, type: "box.created", status: "ready", box: { id: "bx_23456789", state: "ready" } }, { status: 202 })
    if (request.method === "POST" && url.pathname.endsWith("/commands")) return Response.json({ ok: true, type: "command.finished", success: true, exitCode: 0, stdout: "waterbox-bootstrap-ok\n", stderr: "", timedOut: false })
    throw new Error(`unexpected configured Box request ${request.method} ${url.pathname}`)
  }
  const client = await createMcpClient(parseMcpConfig({ WATERBOX_PROVIDER: "box", BOX_API_KEY: "test-key", WATERBOX_SQLITE_PATH: ":memory:" }))
  try {
    const created = await client.createSandbox({}, { idempotencyKey: "node-box", signal: new AbortController().signal })
    assert.equal(created.provider, "box")
    assert.equal(created.state, "running")
  } finally { await client.close() }
}

async function smokeVercel() {
  let created
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url), path = url.pathname
    if (request.method === "POST" && path === "/v4/sandboxes") {
      const body = await request.json()
      created = { name: body.name, tags: body.tags }
      return Response.json({ sandbox: { name: body.name, currentSessionId: "node-session", status: "running", tags: body.tags }, session: { id: "node-session", projectId: "project" } })
    }
    if (request.method === "GET" && path.startsWith("/v2/sandboxes/") && !path.includes("/sessions/")) return Response.json({ sandbox: { name: created.name, currentSessionId: "node-session", status: "running", tags: created.tags }, session: { id: "node-session", projectId: "project" } })
    if (request.method === "POST" && path.endsWith("/cmd")) return Response.json({ command: { id: "node-command", sessionId: "node-session", exitCode: null } })
    if (request.method === "GET" && path.endsWith("/cmd/node-command")) return Response.json({ command: { id: "node-command", sessionId: "node-session", exitCode: 0 } })
    if (request.method === "GET" && path.endsWith("/logs")) return new Response(JSON.stringify({ stream: "stdout", data: "waterbox-bootstrap-ok\n" }) + "\n", { headers: { "content-type": "application/x-ndjson" } })
    throw new Error(`unexpected configured Vercel request ${request.method} ${path}`)
  }
  const client = await createMcpClient(parseMcpConfig({ WATERBOX_PROVIDER: "vercel", VERCEL_TOKEN: "test-token", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project", WATERBOX_SQLITE_PATH: ":memory:" }))
  try {
    const created = await client.createSandbox({}, { idempotencyKey: "node-vercel", signal: new AbortController().signal })
    assert.equal(created.provider, "vercel")
    assert.equal(created.state, "running")
  } finally { await client.close() }
}
