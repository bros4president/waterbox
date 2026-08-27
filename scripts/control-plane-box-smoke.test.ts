import { describe, expect, test } from "bun:test"
import { SmokeApi, parseSmokeConfig, runBoxSmoke, type SmokeConfig, type SmokeDependencies, type SmokeFetch } from "./control-plane-box-smoke.ts"

const sandbox = { sandboxId: "sbx_calm-cactus-7k3m", provider: "fake", state: "running", version: 1, createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" }
const snapshot = { snapshotId: "snap_silver-forest-2p9x", name: "smoke-run-snapshot", provider: "fake", sourceSandboxId: sandbox.sandboxId, state: "ready", version: 1, createdAt: sandbox.createdAt, updatedAt: sandbox.updatedAt }
const config: SmokeConfig = { baseUrl: "http://control.test", apiKey: "api-secret", runId: "smoke-run", pollIntervalMs: 1, pollTimeoutMs: 10 }
function dependencies(fetcher: SmokeFetch, clock = { value: 0 }): SmokeDependencies { return { fetch: fetcher, now: () => clock.value, sleep: async (ms) => { clock.value += ms }, randomId: () => "fixed" } }

describe("control-plane Box smoke safety", () => {
  test("requires explicit authorization, isolated-account acknowledgement, and credentials without echoing them", () => {
    for (const env of [{}, { WATERBOX_BOX_SMOKE_AUTHORIZED: "YES" }, { WATERBOX_BOX_SMOKE_AUTHORIZED: "YES", WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT: "YES", WATERBOX_API_URL: "bad", WATERBOX_DEV_API_KEY: "never-echo", BOX_API_KEY: "also-never" }]) {
      let error: unknown; try { parseSmokeConfig(env, () => "fixed") } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("never-echo"); expect(String(error)).not.toContain("also-never")
    }
  })

  test("exactly replays ambiguous transport creation with the same key and body", async () => {
    const calls: RequestInit[] = []; let attempt = 0
    const api = new SmokeApi(config, dependencies(async (_url, init) => { calls.push(init!); if (attempt++ === 0) throw new TypeError("secret transport detail"); return Response.json(sandbox, { status: 201 }) }))
    expect((await api.createSandbox({}, "stable-key")).sandboxId).toBe(sandbox.sandboxId)
    expect(calls).toHaveLength(2); expect(calls[0]?.body).toBe(calls[1]?.body); expect(new Headers(calls[0]?.headers).get("idempotency-key")).toBe("stable-key")
  })

  test("recovers accepted-but-unparsed creation by exact replay", async () => {
    const calls: RequestInit[] = []; let attempt = 0
    const api = new SmokeApi(config, dependencies(async (_url, init) => { calls.push(init!); return attempt++ === 0 ? new Response("truncated", { status: 201 }) : Response.json(sandbox, { status: 200 }) }))
    expect((await api.createSandbox({}, "parse-recovery")).sandboxId).toBe(sandbox.sandboxId)
    expect(calls).toHaveLength(2); expect(calls[0]?.body).toBe(calls[1]?.body); expect(new Headers(calls[1]?.headers).get("idempotency-key")).toBe("parse-recovery")
  })

  test("replays 5xx but never retries definite 4xx", async () => {
    let calls = 0
    const recovered = new SmokeApi(config, dependencies(async () => ++calls === 1 ? new Response("hidden", { status: 502 }) : Response.json(sandbox, { status: 201 })))
    expect((await recovered.createSandbox({}, "stable")).sandboxId).toBe(sandbox.sandboxId); expect(calls).toBe(2)
    calls = 0
    const definite = new SmokeApi(config, dependencies(async () => { calls++; return new Response("validation secret", { status: 400 }) }))
    await expect(definite.createSandbox({}, "stable")).rejects.toThrow("(400)"); expect(calls).toBe(1)
  })

  test("consumes NDJSON incrementally before delayed final events", async () => {
    const clock = { value: 0 }
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({ async pull(controller) { if (pulls++ === 0) { clock.value = 1; controller.enqueue(new TextEncoder().encode('{"type":"stdout","data":"first"}\n')) } else { await Bun.sleep(10); clock.value = 5; controller.enqueue(new TextEncoder().encode('{"type":"result","title":"bash","output":"","metadata":{"command":"x","workdir":"/workspace","exitCode":0,"signal":null,"timedOut":false,"aborted":false,"durationMs":4,"outputTruncated":false}}\n')); controller.close() } } })
    const api = new SmokeApi(config, dependencies(async () => new Response(body, { status: 200 }), clock))
    const result = await api.tool(sandbox.sandboxId, "bash", { command: "x" }, true)
    expect(result.incremental).toBeTrue(); expect(result.events).toHaveLength(2)
  })

  test("bounds deletion reconciliation and follows account-scoped list cursors", async () => {
    let sandboxGets = 0, snapshotGets = 0, sandboxDelete = 0, snapshotDelete = 0
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); const method = init?.method ?? "GET"
      if (url.pathname === "/v1/sandboxes" && !url.searchParams.has("cursor")) return Response.json({ items: [sandbox], nextCursor: "next" })
      if (url.pathname === "/v1/sandboxes" && url.searchParams.get("cursor") === "next") return Response.json({ items: [] })
      if (url.pathname === `/v1/sandboxes/${sandbox.sandboxId}` && method === "DELETE") { sandboxDelete++; return Response.json({ ...sandbox, state: "terminating" }) }
      if (url.pathname === `/v1/sandboxes/${sandbox.sandboxId}`) return Response.json({ ...sandbox, state: sandboxGets++ < 2 ? "terminating" : "terminated" })
      if (url.pathname === `/v1/snapshots/${snapshot.snapshotId}` && method === "DELETE") { snapshotDelete++; return Response.json({ ...snapshot, state: "deleting" }) }
      if (url.pathname === `/v1/snapshots/${snapshot.snapshotId}`) return Response.json({ ...snapshot, state: snapshotGets++ < 2 ? "deleting" : "deleted" })
      return new Response("not found", { status: 404 })
    }
    const api = new SmokeApi(config, dependencies(fetcher))
    expect(await api.listSandboxes()).toHaveLength(1)
    expect((await api.deleteSandboxAndWait(sandbox.sandboxId)).state).toBe("terminated")
    expect((await api.deleteSnapshotAndWait(snapshot.snapshotId)).state).toBe("deleted")
    expect([sandboxDelete, snapshotDelete]).toEqual([1, 1]); expect(sandboxGets).toBeLessThanOrEqual(4); expect(snapshotGets).toBeLessThanOrEqual(4)
  })

  test("rejects repeated list cursors instead of hanging cleanup", async () => {
    let calls = 0
    const api = new SmokeApi(config, dependencies(async () => { calls++; return Response.json({ items: [], nextCursor: "repeated" }) }))
    await expect(api.listSandboxes()).rejects.toThrow("cursor did not advance")
    expect(calls).toBe(2)
  })

  test("discovery failure still deletes an already tracked sandbox", async () => {
    let sandboxLists = 0, deletes = 0, state = "running"
    const fetcher: SmokeFetch = async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? "GET"
      if (url.pathname === "/v1/sandboxes" && method === "GET") { sandboxLists++; return sandboxLists === 1 ? Response.json({ items: [] }) : new Response("hidden", { status: 500 }) }
      if (url.pathname === "/v1/snapshots" && method === "GET") return new Response("hidden", { status: 500 })
      if (url.pathname === "/v1/sandboxes" && method === "POST") return Response.json(sandbox, { status: 201 })
      if (url.pathname.includes("/tools/")) return new Response("hidden", { status: 500 })
      if (url.pathname === `/v1/sandboxes/${sandbox.sandboxId}` && method === "DELETE") { deletes++; state = "terminated"; return Response.json({ ...sandbox, state: "terminating" }) }
      if (url.pathname === `/v1/sandboxes/${sandbox.sandboxId}`) return Response.json({ ...sandbox, state })
      return new Response("hidden", { status: 404 })
    }
    await expect(runBoxSmoke(config, dependencies(fetcher))).rejects.toThrow("cleanup incomplete")
    expect(deletes).toBe(1)
  })

  test("runs the full fake flow and leaves no nonterminal owned resource", async () => {
    const clock = { value: 0 }, sandboxes = new Map<string, string>(), snapshots = new Map<string, { state: string; name: string }>(); let creates = 0
    const fetcher: SmokeFetch = async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? "GET", parts = url.pathname.split("/").filter(Boolean)
      if (url.pathname === "/v1/sandboxes" && method === "GET") return Response.json({ items: [...sandboxes].map(([sandboxId, state]) => ({ ...sandbox, sandboxId, state })) })
      if (url.pathname === "/v1/snapshots" && method === "GET") return Response.json({ items: [...snapshots].map(([snapshotId, value]) => ({ ...snapshot, snapshotId, ...value })) })
      if (url.pathname === "/v1/sandboxes" && method === "POST") { const id = creates++ === 0 ? sandbox.sandboxId : "sbx_bright-river-4n8p"; sandboxes.set(id, "running"); return Response.json({ ...sandbox, sandboxId: id }, { status: 201 }) }
      const sandboxId = parts[2]
      if (parts[1] === "sandboxes" && parts[3] === "tools") {
        sandboxes.set(sandboxId!, "running")
        const bash = parts[4] === "bash"
        const stream = new ReadableStream<Uint8Array>({ async start(controller) { if (bash) { clock.value++; controller.enqueue(new TextEncoder().encode('{"type":"stdout","data":"first"}\n')); await Bun.sleep(2); clock.value += 2 } controller.enqueue(new TextEncoder().encode('{"type":"result"}\n')); controller.close() } })
        return new Response(stream)
      }
      if (parts[1] === "sandboxes" && parts[3] === "stop") { sandboxes.set(sandboxId!, "stopped"); return Response.json({ ...sandbox, sandboxId, state: "stopped" }) }
      if (parts[1] === "sandboxes" && parts[3] === "snapshots" && method === "POST") { const body = JSON.parse(String(init?.body)); snapshots.set(snapshot.snapshotId, { state: "ready", name: body.name }); return Response.json({ ...snapshot, name: body.name }, { status: 201 }) }
      if (parts[1] === "sandboxes" && parts.length === 3 && method === "DELETE") { sandboxes.set(sandboxId!, "terminated"); return Response.json({ ...sandbox, sandboxId, state: "terminating" }) }
      if (parts[1] === "sandboxes" && parts.length === 3) return Response.json({ ...sandbox, sandboxId, state: sandboxes.get(sandboxId!) })
      const snapshotId = parts[2]
      if (parts[1] === "snapshots" && method === "DELETE") { const value = snapshots.get(snapshotId!)!; snapshots.set(snapshotId!, { ...value, state: "deleted" }); return Response.json({ ...snapshot, snapshotId, ...value, state: "deleting" }) }
      if (parts[1] === "snapshots") { const value = snapshots.get(snapshotId!)!; return Response.json({ ...snapshot, snapshotId, ...value }) }
      return new Response("not found", { status: 404 })
    }
    const result = await runBoxSmoke(config, dependencies(fetcher, clock))
    expect(result.ok).toBeTrue(); expect([...sandboxes.values()].every((state) => state === "terminated")).toBeTrue(); expect([...snapshots.values()].every(({ state }) => state === "deleted")).toBeTrue()
  })
})
