import { describe, expect, test } from "bun:test"
import type { ToolName } from "@waterbox/contracts"
import { ProviderError } from "@waterbox/core/provider"
import { BoxSandboxProvider, __testing, type BoxProviderClock } from "../src/index.ts"

class FakeClock implements BoxProviderClock {
  time = 0
  sleeps = 0
  now(): Date { return new Date(this.time) }
  async sleep(milliseconds: number, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); this.sleeps++; this.time += milliseconds }
}

interface Seen { url: string; method: string; headers: Headers; body?: unknown; signal: AbortSignal | null }
function harness(handler?: (request: Request, seen: Seen[]) => Response | Promise<Response>) {
  const seen: Seen[] = []
  const clock = new FakeClock()
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const text = request.body ? await request.clone().text() : ""
    seen.push({ url: request.url, method: request.method, headers: request.headers, ...(text ? { body: JSON.parse(text) } : {}), signal: init?.signal instanceof AbortSignal ? init.signal : null })
    if (handler) {
      const response = await handler(request, seen)
      if (response.status === 204 || !response.headers.get("content-type")?.includes("application/json")) return response
      if (response.status >= 400) return response
      const raw = await response.clone().json() as any
      const path = new URL(request.url).pathname
      const expectedStatus = request.method === "POST" && (path.endsWith("/boxes") || path.endsWith("/stop") || path.endsWith("/resume") || path.endsWith("/named-snapshots")) ? 202 : response.status
      if (raw?.ok === true) return expectedStatus === response.status ? response : Response.json(raw, { status: expectedStatus })
      if (raw?.url && path.endsWith("/host")) return Response.json({ ok: true, type: "port.hosted", success: true, port: 4317, url: `${raw.url}${raw.url.includes("?") ? "&" : "?"}_token=test`, isProtected: true, access: "private" }, { status: expectedStatus })
      if (raw?.id && raw?.state && path.endsWith("/boxes") && request.method === "POST") return Response.json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { ...raw, state: raw.state === "creating" ? "provisioning" : raw.state } }, { status: expectedStatus })
      if (raw?.id && raw?.state && path.endsWith("/stop")) return Response.json({ ok: true, type: "box.stopping", id: raw.id, status: "archiving", box: raw }, { status: expectedStatus })
      if (raw?.id && raw?.state && path.endsWith("/resume")) return Response.json({ ok: true, type: "box.resuming", id: raw.id, status: "resuming", box: { ...raw, state: raw.state === "resuming" ? "provisioning" : raw.state } }, { status: expectedStatus })
      if (raw?.id && raw?.state && path.includes("/named-snapshots")) { const name = request.method === "POST" ? (seen.at(-1)?.body as any)?.name : decodeURIComponent(path.split("/").at(-1)!); const status = raw.state === "creating" ? "saving" : raw.state; return Response.json({ ok: true, type: request.method === "POST" ? "snapshot.named.saving" : "snapshot.named.info", ...(request.method === "POST" ? { status: "saving" } : {}), snapshot: { name, status, sourceBoxId: "bx_23456789", createdAt: "2026-08-27T00:00:00Z", ...(status === "ready" ? { snapshotId: "snap_artifact_1" } : {}) } }, { status: expectedStatus }) }
      if (raw?.id && raw?.state && path.includes("/boxes/")) return Response.json({ ok: true, type: "box.info", box: { ...raw, state: raw.state === "creating" ? "provisioning" : raw.state } }, { status: response.status })
      return response
    }
    return Response.json({ ok: true, type: "box.info", box: { id: "bx_23456789", state: "ready" } })
  }
  const provider = new BoxSandboxProvider({
    apiBaseUrl: "https://api.box.test/api/box/v1",
    apiKey: "box-secret-key",
    systemTemplateRef: "template-secret-ref",
    daemonPort: 4317,
    polling: { intervalMs: 10, timeoutMs: 100 },
  }, { fetch: fakeFetch, clock })
  return { provider, seen, clock }
}

const signal = () => new AbortController().signal
const sandboxRef = { kind: "box-sandbox-v1", boxId: "bx_23456789", daemonUrl: "https://daemon-secret.test/access/token?signature=query-secret&_token=protected-token" }
const snapshotRef = { kind: "box-named-snapshot-v1", name: "waterbox-user-snapshot" }

describe("Box provider HTTP contract", () => {
  test("create disables inherited environment, sends only the non-secret sandbox ID tag, and preserves template, idempotency, and protected hosting", async () => {
    let inspection = 0
    const { provider, seen, clock } = harness((request) => {
      if (request.url.endsWith("/api/box/v1/boxes") && request.method === "POST") return Response.json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { id: "bx_23456789", state: "provisioning" } })
      if (request.url.endsWith("/api/box/v1/boxes/bx_23456789") && request.method === "GET") return Response.json({ ok: true, type: "box.info", box: { id: "bx_23456789", state: ++inspection === 1 ? "provisioning" : "idle" } })
      if (request.url.endsWith("/host")) return Response.json({ ok: true, type: "port.hosted", success: true, port: 4317, url: "https://protected.test/token-a?_token=secret", isProtected: true, access: "private" })
      throw new Error("unexpected request")
    })
    const result = await provider.createSandbox({ accountId: "acct-a", sandboxId: "sbx_calm-cactus-7k3m", idempotencyKey: "stable-key", signal: signal() })
    expect(result).toEqual({ state: "running", providerRef: { kind: "box-sandbox-v1", boxId: "bx_23456789", daemonUrl: "https://protected.test/token-a?_token=secret" } })
    expect(seen[0]?.body).toEqual({ from: "template-secret-ref", noEnv: true, env: { WATERBOX_SANDBOX_ID: "sbx_calm-cactus-7k3m" } })
    expect(seen[0]?.headers.get("idempotency-key")).toBe("stable-key")
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer box-secret-key")
    expect(seen.at(-1)?.body).toEqual({ port: 4317, public: false })
    expect(clock.sleeps).toBe(2)
  })

  test("create from snapshot uses only the private snapshot reference as source", async () => {
    const { provider, seen } = harness((request) => request.url.endsWith("/host")
      ? Response.json({ ok: true, type: "port.hosted", success: true, port: 4317, url: "https://protected.test/token?_token=secret", isProtected: true, access: "private" })
      : Response.json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { id: "bx_abcdefgh", state: "ready" } }))
    await provider.createSandbox({ accountId: "acct-a", sandboxId: "sbx_calm-cactus-7k3m", sourceSnapshotRef: snapshotRef, idempotencyKey: "fork-key", signal: signal() })
    expect(seen[0]?.body).toEqual({ from: "waterbox-user-snapshot", noEnv: true, env: { WATERBOX_SANDBOX_ID: "sbx_calm-cactus-7k3m" } })
    expect(JSON.stringify(seen[0]?.body)).not.toContain("template-secret-ref")
    expect(seen[0]?.headers.get("idempotency-key")).toBe("fork-key")
  })

  test("inspect normalizes states; stop archives, resume refreshes hosting, and delete is permanent", async () => {
    let hosting = 0
    const { provider, seen } = harness((request) => {
      if (request.url.endsWith("/stop")) return Response.json({ id: "bx_23456789", state: "archived" })
      if (request.url.endsWith("/resume")) return Response.json({ id: "bx_23456789", state: "resuming" })
      if (request.method === "DELETE") return Response.json({ ok: true, type: "box.deleting", operation: { id: `bdop_${"a".repeat(32)}`, kind: "box", targetId: "bx_23456789", reason: "explicit", status: "pending", attemptCount: 0, requestedAt: "2026-08-27T00:00:00Z", completedAt: null } }, { status: 202 })
      if (request.url.includes("/deletion-operations/")) return Response.json({ ok: true, type: "deletion.operation", operation: { id: `bdop_${"a".repeat(32)}`, kind: "box", targetId: "bx_23456789", reason: "explicit", status: "completed", attemptCount: 1, requestedAt: "2026-08-27T00:00:00Z", completedAt: "2026-08-27T00:00:01Z" } })
      if (request.url.endsWith("/host")) return Response.json({ url: `https://protected.test/refreshed-${++hosting}` })
      return Response.json({ id: "bx_23456789", state: request.method === "GET" ? "ready" : "failed" })
    })
    expect(await provider.inspectSandbox({ accountId: "a", providerRef: sandboxRef, signal: signal() })).toEqual({ state: "running", providerRef: { kind: "box-sandbox-v1", boxId: "bx_23456789", daemonUrl: "https://protected.test/refreshed-1?_token=test" } })
    expect(await provider.stopResume.stop({ accountId: "a", providerRef: sandboxRef, signal: signal() })).toEqual({ state: "stopped", providerRef: { kind: "box-sandbox-v1", boxId: "bx_23456789" } })
    const resumed = await provider.stopResume.resume({ accountId: "a", providerRef: sandboxRef, signal: signal() })
    expect(resumed).toEqual({ state: "running", providerRef: { kind: "box-sandbox-v1", boxId: "bx_23456789", daemonUrl: "https://protected.test/refreshed-2?_token=test" } })
    expect((await provider.deleteSandbox({ accountId: "a", providerRef: sandboxRef, signal: signal() })).state).toBe("terminated")
    expect(seen.some((item) => item.url.endsWith("/stop"))).toBe(true)
    expect(seen.some((item) => item.url.endsWith("/resume"))).toBe(true)
    expect(seen.some((item) => item.method === "DELETE" && item.headers.get("x-ascii-confirm-delete") === "bx_23456789")).toBe(true)
  })

  test("rejects lifecycle envelopes for the opposite endpoint", async () => {
    const stopping = { ok: true, type: "box.stopping", id: "bx_23456789", status: "archiving" }
    const resuming = { ok: true, type: "box.resuming", id: "bx_23456789", status: "resuming" }
    const stopProvider = harness(() => Response.json(resuming, { status: 202 })).provider
    const resumeProvider = harness(() => Response.json(stopping, { status: 202 })).provider
    await expect(stopProvider.stopResume.stop({ accountId: "a", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    await expect(resumeProvider.stopResume.resume({ accountId: "a", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
  })

  test("maps provider running without registering or fabricating hosting", async () => {
    const { provider, seen } = harness(() => Response.json({ id: "bx_23456789", state: "running" }))
    expect(await provider.inspectSandbox({ accountId: "a", providerRef: sandboxRef, signal: signal() })).toEqual({ state: "running", providerRef: sandboxRef })
    expect(seen.map(item => item.url)).toEqual(["https://api.box.test/api/box/v1/boxes/bx_23456789"])
  })

  test("requires HTTPS protected URLs with a nonempty token and preserves path and query", async () => {
    for (const daemonUrl of ["http://protected.test/path?_token=x", "https://protected.test/path", "https://protected.test/path?_token="]) {
      await expect(harness().provider.inspectSandbox({ accountId: "a", providerRef: { kind: "box-sandbox-v1", boxId: "bx_23456789", daemonUrl }, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    }
    const invalidHosted = harness(() => Response.json({ ok: true, type: "port.hosted", success: true, port: 4317, url: "https://protected.test/access?signature=x", isProtected: true, access: "private" })).provider
    await expect(invalidHosted.inspectSandbox({ accountId: "a", providerRef: { kind: "box-sandbox-v1", boxId: "bx_23456789" }, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    const routed = __testing.daemonToolUrl(sandboxRef.daemonUrl, "read")
    expect(routed.pathname).toBe("/access/token/v1/tools/read")
    expect(routed.search).toBe("?signature=query-secret&_token=protected-token")
  })

  test("snapshot creation is asynchronous, provider-safe, inspectable, deletable, and quota-aware", async () => {
    const { provider, seen } = harness((request) => {
      if (request.method === "POST") return Response.json({ id: "snap-native", state: "creating" })
      if (request.method === "GET") return Response.json({ id: "snap-native", state: "ready" })
      const name = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!)
      return Response.json({ ok: true, type: "snapshot.named.deleted", name, status: "deleted" })
    })
    const created = await provider.snapshots.create({ accountId: "Customer.SECRET", snapshotId: "snap_silver-forest-2p9x", sandboxRef, signal: signal() })
    expect(created).toEqual({ state: "creating", providerRef: { kind: "box-named-snapshot-v1", name: expect.any(String) } })
    const name = (seen[0]?.body as { name: string }).name
    expect(name).toMatch(/^waterbox-[a-z0-9-]+$/)
    expect(name.length).toBeLessThanOrEqual(63)
    expect((await provider.snapshots.inspect({ accountId: "a", snapshotId: "snap_silver-forest-2p9x", providerRef: created.providerRef, signal: signal() })).state).toBe("ready")
    expect((await provider.snapshots.delete({ accountId: "a", snapshotId: "snap_silver-forest-2p9x", providerRef: created.providerRef, signal: signal() })).state).toBe("deleted")

    const limited = harness(() => Response.json({ code: "snapshot_quota_exceeded", message: "secret details" }, { status: 409 })).provider
    await expect(limited.snapshots.create({ accountId: "a", snapshotId: "snap_silver-forest-2p9x", sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "limit", message: "Box named snapshot limit reached" })
  })

  test("preserves account-derived identity, provider reference, and caller signal", async () => {
    const controller = new AbortController()
    const inputRef = { kind: "box-sandbox-v1", boxId: "bx_23456789" } as const
    const { provider, seen } = harness((request, requests) => {
      const name = (requests.at(-1)?.body as { name: string }).name
      return Response.json({ ok: true, type: "snapshot.named.saving", status: "saving", snapshot: { name, status: "saving", sourceBoxId: inputRef.boxId, createdAt: "2026-08-27T00:00:00Z" } }, { status: 202 })
    })
    const result = await provider.snapshots.create({ accountId: "acct-continuity", snapshotId: "snap_silver-forest-2p9x", sandboxRef: inputRef, signal: controller.signal })
    const expectedName = await __testing.internalSnapshotName("acct-continuity", "snap_silver-forest-2p9x")
    expect(seen[0]?.body).toEqual({ boxId: inputRef.boxId, name: expectedName })
    expect(seen[0]?.signal).toBe(controller.signal)
    expect(result.providerRef).toEqual({ kind: "box-named-snapshot-v1", name: expectedName })
    expect(inputRef).toEqual({ kind: "box-sandbox-v1", boxId: "bx_23456789" })
  })

  test("reconciles a lost accepted named-snapshot response without retrying POST", async () => {
    let posts = 0
    const { provider, seen } = harness((request) => {
      const url = new URL(request.url)
      if (request.method === "POST") { posts++; throw new TypeError("response lost") }
      const name = decodeURIComponent(url.pathname.split("/").at(-1)!)
      if (request.method === "GET") return Response.json({ ok: true, type: "snapshot.named.info", snapshot: { name, status: "saving", sourceBoxId: "bx_23456789", createdAt: "2026-08-27T00:00:00Z" } })
      return Response.json({ ok: true, type: "snapshot.named.deleted", name, status: "deleted" })
    })
    const created = await provider.snapshots.create({ accountId: "acct-a", snapshotId: "snap_silver-forest-2p9x", sandboxRef, signal: signal() })
    expect(created.state).toBe("creating")
    expect(posts).toBe(1)
    expect(seen.filter(item => item.method === "POST")).toHaveLength(1)
    expect((await provider.snapshots.inspect({ accountId: "acct-a", snapshotId: "snap_silver-forest-2p9x", providerRef: created.providerRef, signal: signal() })).state).toBe("creating")
    expect((await provider.snapshots.delete({ accountId: "acct-a", snapshotId: "snap_silver-forest-2p9x", providerRef: created.providerRef, signal: signal() })).state).toBe("deleted")
  })

  test("rejects competing same-name snapshot reconciliation without retrying", async () => {
    let posts = 0
    const { provider } = harness((request) => {
      if (request.method === "POST") { posts++; throw new TypeError("response lost") }
      const name = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!)
      return Response.json({ ok: true, type: "snapshot.named.info", snapshot: { name, status: "saving", sourceBoxId: "bx_abcdefgh", createdAt: "2026-08-27T00:00:00Z" } })
    })
    await expect(provider.snapshots.create({ accountId: "acct-a", snapshotId: "snap_silver-forest-2p9x", sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution", message: "Box snapshot save requires manual recovery" })
    expect(posts).toBe(1)
  })

  test("treats lost snapshot response followed by 404 as ambiguous without synthetic acceptance", async () => {
    let posts = 0; let gets = 0
    const { provider } = harness((request) => {
      if (request.method === "POST") { posts++; throw new TypeError("response lost") }
      gets++; return Response.json({ code: "not_found" }, { status: 404 })
    })
    await expect(provider.snapshots.create({ accountId: "acct-a", snapshotId: "snap_silver-forest-2p9x", sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    expect(posts).toBe(1); expect(gets).toBe(1)
  })

  test("requires named-snapshot source, state, and ready artifact identity but not unused timestamps", async () => {
    const name = (snapshotRef as any).name
    const valid = { name, status: "ready", snapshotId: "snap_artifact_1", sourceBoxId: "bx_23456789" }
    expect((await harness(() => Response.json({ ok: true, type: "snapshot.named.info", snapshot: valid })).provider.snapshots.inspect({ accountId: "a", snapshotId: "snap_silver-forest-2p9x", providerRef: snapshotRef, signal: signal() })).state).toBe("ready")
    for (const snapshot of [{ ...valid, sourceBoxId: undefined }, { ...valid, snapshotId: undefined }, { ...valid, status: "unknown" }]) {
      const provider = harness(() => Response.json({ ok: true, type: "snapshot.named.info", snapshot })).provider
      await expect(provider.snapshots.inspect({ accountId: "a", snapshotId: "snap_silver-forest-2p9x", providerRef: snapshotRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    }
  })

  test("rejects snapshot envelopes for the opposite operation", async () => {
    const createProvider = harness((_request, seen) => { const name = (seen.at(-1)?.body as { name: string }).name; return Response.json({ ok: true, type: "snapshot.named.info", snapshot: { name, status: "saving", sourceBoxId: "bx_23456789" } }, { status: 202 }) }).provider
    await expect(createProvider.snapshots.create({ accountId: "a", snapshotId: "snap_silver-forest-2p9x", sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    const saving = { ok: true, type: "snapshot.named.saving", status: "saving", snapshot: { name: snapshotRef.name, status: "saving", sourceBoxId: "bx_23456789" } }
    await expect(harness(() => Response.json(saving)).provider.snapshots.inspect({ accountId: "a", snapshotId: "snap_silver-forest-2p9x", providerRef: snapshotRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
  })

  test("rejects deletion envelopes for the opposite delete and poll operations", async () => {
    const operationBody = { id: `bdop_${"a".repeat(32)}`, kind: "box", targetId: "bx_23456789", status: "pending" }
    await expect(harness(() => Response.json({ ok: true, type: "deletion.operation", operation: operationBody }, { status: 202 })).provider.deleteSandbox({ accountId: "a", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    const provider = harness(request => request.method === "DELETE" ? Response.json({ ok: true, type: "box.deleting", operation: operationBody }, { status: 202 }) : Response.json({ ok: true, type: "box.deleting", operation: operationBody })).provider
    await expect(provider.deleteSandbox({ accountId: "a", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
  })

  test("errors redact API keys, provider ids, response bodies, and protected URLs", async () => {
    const { provider } = harness(() => Response.json({ code: "broken", message: "box-secret-key https://daemon-secret.test/access-token bx_23456789" }, { status: 500 }))
    let error: unknown
    try { await provider.inspectSandbox({ accountId: "a", providerRef: sandboxRef, signal: signal() }) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(ProviderError)
    const serialized = JSON.stringify(error)
    expect(String((error as Error).message)).toBe("Box request failed (500)")
    for (const secret of ["box-secret-key", "daemon-secret", "access", "query-secret", "bx_23456789"]) expect(serialized).not.toContain(secret)
  })
})

describe("Box provider canonical daemon transport and conformance", () => {
  const resultByTool: Record<Exclude<ToolName, "bash">, unknown> = {
    read: { type: "result", title: "Read", output: "x", metadata: { filePath: "x", offset: 1 } },
    write: { type: "result", title: "Write", output: "ok", metadata: { filePath: "x", bytes: 1 } },
    edit: { type: "result", title: "Edit", output: "ok", metadata: { filePath: "x", replacements: 1, bytes: 1 } },
    patch: { type: "result", title: "Patch", output: "ok", metadata: { added: [], updated: ["x"], deleted: [], moved: [] } },
    glob: { type: "result", title: "Glob", output: "x", metadata: { pattern: "*", path: ".", count: 1, truncated: false } },
    grep: { type: "result", title: "Grep", output: "x", metadata: { pattern: "x", path: ".", matches: 1, truncated: false } },
  }
  const argsByTool: Record<ToolName, Record<string, unknown>> = {
    read: { filePath: "x" }, write: { filePath: "x", content: "x" }, edit: { filePath: "x", oldString: "a", newString: "b" },
    patch: { patchText: "*** Begin Patch" }, glob: { pattern: "*" }, grep: { pattern: "x" }, bash: { command: "echo x" },
  }

  test("all seven tools preserve canonical request arguments and response events", async () => {
    const { provider, seen } = harness((request) => {
      const tool = new URL(request.url).pathname.split("/").at(-1) as ToolName
      if (tool === "bash") return new Response(`${JSON.stringify({ type: "stdout", data: "x\n" })}\n${JSON.stringify({ type: "result", title: "Bash", output: "x", metadata: { command: "echo x", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } })}\n`, { headers: { "content-type": "application/x-ndjson" } })
      return Response.json(resultByTool[tool])
    })
    for (const tool of ["read", "write", "edit", "patch", "glob", "grep", "bash"] as const) {
      const events = []
      for await (const event of provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: tool, arguments: argsByTool[tool] as never, signal: signal() })) events.push(event)
      expect(events.at(-1)?.type).toBe("result")
      expect(seen.at(-1)?.body).toEqual(argsByTool[tool])
      const routed = new URL(seen.at(-1)!.url)
      expect(routed.pathname).toBe(`/access/token/v1/tools/${tool}`)
      expect(routed.search).toBe("?signature=query-secret&_token=protected-token")
    }
  })

  test("bash yields chunks in arrival order without buffering to completion", async () => {
    let second!: () => void
    const gate = new Promise<void>((resolve) => { second = resolve })
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"stdout","data":"first"}\n'))
        await gate
        controller.enqueue(new TextEncoder().encode('{"type":"stderr","data":"second"}\n'))
        controller.enqueue(new TextEncoder().encode('{"type":"result","title":"Bash","output":"","metadata":{"command":"x","workdir":"/workspace","exitCode":0,"signal":null,"timedOut":false,"aborted":false,"durationMs":1,"outputTruncated":false}}\n'))
        controller.close()
      },
    })
    const { provider } = harness(() => new Response(stream, { headers: { "content-type": "application/x-ndjson" } }))
    const iterator = provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "bash", arguments: { command: "x" }, signal: signal() })[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: { type: "stdout", data: "first" } })
    second()
    expect((await iterator.next()).value).toEqual({ type: "stderr", data: "second" })
  })

  test("cancellation reaches the daemon request", async () => {
    let observed: AbortSignal | undefined
    const { provider } = harness((request) => {
      observed = request.signal
      if (request.signal.aborted) return Promise.reject(request.signal.reason)
      return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))
    })
    const controller = new AbortController()
    const iterator = provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "read", arguments: { filePath: "x" }, signal: controller.signal })[Symbol.asyncIterator]()
    const pending = iterator.next()
    await new Promise((resolve) => setTimeout(resolve, 1))
    controller.abort(new DOMException("cancelled", "AbortError"))
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(observed?.aborted).toBe(true)
  })

  test("ambiguous daemon outcomes are not retried", async () => {
    let calls = 0
    const { provider } = harness(() => { calls++; return Response.json({ code: "box_direct_failed" }, { status: 502 }) })
    const iterator = provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "write", arguments: { filePath: "x", content: "x" }, signal: signal() })[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({ kind: "ambiguous_execution", message: "Tool execution outcome is unknown" })
    expect(calls).toBe(1)
  })

  test("optional operation groups and internal snapshot names conform to the core port", async () => {
    const { provider } = harness()
    expect(provider.name).toBe("box")
    expect(Object.keys(provider.stopResume)).toEqual(["stop", "resume"])
    expect(Object.keys(provider.snapshots)).toEqual(["create", "inspect", "delete"])
    const first = await __testing.internalSnapshotName("ACCT !!", "snap_silver-forest-2p9x")
    const second = await __testing.internalSnapshotName("ACCT ??", "snap_silver-forest-2p9x-other-long-suffix")
    expect(first).toMatch(/^waterbox-[a-z0-9-]+$/)
    expect(first.length).toBeLessThanOrEqual(63)
    expect(second).not.toBe(first)
  })
})

describe("Phase E guardian corrections", () => {
  const readResult = { type: "result", title: "Read", output: "ok", metadata: { filePath: "/workspace/conformance.txt", offset: 1 } } as const
  const bashResult = { type: "result", title: "Bash", output: "", metadata: { command: "x", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } } as const

  test("protected routing preserves access path and query exactly", () => {
    const url = __testing.daemonToolUrl("https://protected.test/a%2Fb/token/?signature=s3cr3t&mode=protected", "grep")
    expect(url.origin).toBe("https://protected.test")
    expect(url.pathname).toBe("/a%2Fb/token/v1/tools/grep")
    expect(url.search).toBe("?signature=s3cr3t&mode=protected")
  })

  test("crash reconciliation refreshes missing hosting and returns a reference usable for execution", async () => {
    const { provider, seen } = harness((request) => {
      if (request.url === "https://api.box.test/api/box/v1/boxes/bx_23456789") return Response.json({ id: "bx_23456789", state: "idle" })
      if (request.url.endsWith("/host")) return Response.json({ url: "https://protected.test/crash/token?sig=fresh-secret" })
      if (request.url === "https://protected.test/crash/token/v1/tools/read?sig=fresh-secret\&_token=test") return Response.json(readResult)
      throw new Error("unexpected request")
    })
    const reconciled = await provider.inspectSandbox({ accountId: "a", providerRef: { kind: "box-sandbox-v1", boxId: "bx_23456789" }, signal: signal() })
    expect(reconciled.state).toBe("running")
    const events = []
    for await (const event of provider.executeTool({ accountId: "a", providerRef: reconciled.providerRef, toolName: "read", arguments: { filePath: "/workspace/conformance.txt" }, signal: signal() })) events.push(event)
    expect(events).toEqual([readResult])
    expect(seen.map((item) => item.url)).toContain("https://protected.test/crash/token/v1/tools/read?sig=fresh-secret\&_token=test")
  })

  test("rejects every malformed bash framing variant as ambiguous without retry", async () => {
    const validFinal = `${JSON.stringify(bashResult)}\n`
    const variants: Array<{ name: string; body: BodyInit | null; type?: string }> = [
      { name: "empty", body: "", type: "application/x-ndjson" },
      { name: "missing final", body: '{"type":"stdout","data":"x"}\n', type: "application/x-ndjson" },
      { name: "duplicate final", body: validFinal + validFinal, type: "application/x-ndjson" },
      { name: "post result", body: validFinal + '{"type":"stderr","data":"late"}\n', type: "application/x-ndjson" },
      { name: "truncated", body: JSON.stringify(bashResult), type: "application/x-ndjson" },
      { name: "blank line", body: `\n${validFinal}`, type: "application/x-ndjson" },
      { name: "malformed", body: `{nope}\n`, type: "application/x-ndjson" },
      { name: "oversized line", body: `${JSON.stringify({ type: "stdout", data: "x".repeat(1_048_577) })}\n${validFinal}`, type: "application/x-ndjson" },
      { name: "wrong media", body: validFinal, type: "application/json" },
      { name: "missing media", body: validFinal },
      { name: "fatal utf8", body: new Uint8Array([0xff, 0x0a]), type: "application/x-ndjson" },
    ]
    for (const variant of variants) {
      let calls = 0
      const { provider } = harness(() => { calls++; return new Response(variant.body, { headers: variant.type ? { "content-type": variant.type } : {} }) })
      const iterator = provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "bash", arguments: { command: "x" }, signal: signal() })[Symbol.asyncIterator]()
      let error: unknown
      try { while (!(await iterator.next()).done) {} } catch (caught) { error = caught }
      expect(error, variant.name).toMatchObject({ kind: "ambiguous_execution", message: "Tool execution outcome is unknown" })
      expect(calls, variant.name).toBe(1)
    }
  })

  test("daemon ambiguity distinguishes known pre-execution 4xx from all post-dispatch uncertainty", async () => {
    const cases = [
      { status: 400, body: JSON.stringify({ code: "invalid_arguments" }), type: "application/json", kind: "failure" },
      { status: 400, body: "unreadable", type: "text/plain", kind: "ambiguous_execution" },
      { status: 500, body: JSON.stringify({ code: "internal" }), type: "application/json", kind: "ambiguous_execution" },
      { status: 503, body: null, type: undefined, kind: "ambiguous_execution" },
    ] as const
    for (const item of cases) {
      let calls = 0
      const { provider } = harness(() => { calls++; return new Response(item.body, { status: item.status, headers: item.type ? { "content-type": item.type } : {} }) })
      const iterator = provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "write", arguments: { filePath: "x", content: "x" }, signal: signal() })[Symbol.asyncIterator]()
      await expect(iterator.next()).rejects.toMatchObject({ kind: item.kind })
      expect(calls).toBe(1)
    }
    let calls = 0
    const transport = harness(() => { calls++; throw new Error("daemon-secret query-secret") }).provider
    await expect(transport.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "write", arguments: { filePath: "x", content: "x" }, signal: signal() })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ kind: "ambiguous_execution", message: "Tool execution outcome is unknown" })
    expect(calls).toBe(1)
  })

  test("non-bash responses require exact JSON media and canonical final event", async () => {
    for (const response of [
      new Response(JSON.stringify(readResult), { headers: { "content-type": "text/plain" } }),
      Response.json({ ...readResult, extra: true }),
      new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
      new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }),
    ]) {
      const { provider } = harness(() => response)
      await expect(provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "read", arguments: { filePath: "x" }, signal: signal() })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ kind: "ambiguous_execution" })
    }
  })

  test("snapshot names retain deterministic collision-resistant identity hashes", async () => {
    const names = await Promise.all([
      __testing.internalSnapshotName("same-prefix-aaaaaaaaaaaaaaaa-1", "snap_same-prefix-aaaaaaaaaaaaaaaa-1"),
      __testing.internalSnapshotName("same-prefix-aaaaaaaaaaaaaaaa-2", "snap_same-prefix-aaaaaaaaaaaaaaaa-1"),
      __testing.internalSnapshotName("same-prefix-aaaaaaaaaaaaaaaa-1", "snap_same-prefix-aaaaaaaaaaaaaaaa-2"),
    ])
    expect(new Set(names).size).toBe(3)
    for (const name of names) { expect(name).toMatch(/^waterbox-[a-z0-9-]+$/); expect(name.length).toBeLessThanOrEqual(63) }
    expect(await __testing.internalSnapshotName("same-prefix-aaaaaaaaaaaaaaaa-1", "snap_same-prefix-aaaaaaaaaaaaaaaa-1")).toBe(names[0])
  })

  test("strictly rejects hostile configuration, DTOs, identities, URLs, and opaque references with safe errors", async () => {
    const base = { apiBaseUrl: "https://api.box.test", apiKey: "box-secret-key", systemTemplateRef: "template-secret-ref", daemonPort: 4317, polling: { intervalMs: 10, timeoutMs: 100 } }
    const clock = new FakeClock()
    const invalid = [
      { ...base, apiBaseUrl: "ftp://box-secret-key@example.test" }, { ...base, apiBaseUrl: "http://example.test" }, { ...base, apiBaseUrl: "https://user:pass@example.test" },
      { ...base, apiBaseUrl: "https://example.test?token=box-secret-key" }, { ...base, apiBaseUrl: " https://example.test" },
      { ...base, apiKey: " " }, { ...base, systemTemplateRef: " template " }, { ...base, daemonPort: 0 },
      { ...base, polling: { intervalMs: 0, timeoutMs: 100 } }, { ...base, polling: { intervalMs: 100, timeoutMs: 10 } },
      { ...base, extra: true }, { ...base, polling: { intervalMs: 10, timeoutMs: 100, extra: true } },
    ]
    for (const config of invalid) expect(() => new BoxSandboxProvider(config, { clock })).toThrow("Box provider configuration is invalid")
    expect(() => new BoxSandboxProvider(base, { clock, fetch: 1 as never })).toThrow("Box provider dependencies are invalid")
    expect(() => new BoxSandboxProvider(base, { clock, extra: true } as never)).toThrow("Box provider dependencies are invalid")
    const serialized: string[] = []
    for (const config of invalid) { try { new BoxSandboxProvider(config, { clock }) } catch (error) { serialized.push(JSON.stringify(error) + String(error)) } }
    expect(serialized.join(" ")).not.toContain("box-secret-key")

    const invalidRefs: import("@waterbox/core/records").JsonValue[] = [
      { kind: "box-sandbox-v1", boxId: "" }, { kind: "box-sandbox-v1", boxId: "bx_23456789", extra: true },
      { kind: "box-sandbox-v1", boxId: "bx_23456789", daemonUrl: "not-a-url" }, { kind: "box-sandbox-v1", boxId: "bx_23456789", daemonUrl: "https://user:pass@host.test/token?_token=x" },
    ]
    for (const providerRef of invalidRefs) await expect(harness().provider.inspectSandbox({ accountId: "a", providerRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    await expect(harness().provider.snapshots.inspect({ accountId: "a", snapshotId: "snap_silver-forest-2p9x", providerRef: { kind: "box-named-snapshot-v1", name: "waterbox-user-snapshot", extra: true }, signal: signal() })).rejects.toMatchObject({ kind: "failure" })

    for (const payload of [{ id: "other", state: "ready" }, { id: "", state: "ready" }]) {
      const { provider } = harness(() => Response.json(payload))
      await expect(provider.inspectSandbox({ accountId: "a", providerRef: { kind: "box-sandbox-v1", boxId: "bx_23456789" }, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    }
    const mismatchedStop = harness(() => Response.json({ id: "other", state: "archived" })).provider
    await expect(mismatchedStop.stopResume.stop({ accountId: "a", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    const mismatchedPoll = harness((request) => request.url.endsWith("/resume") ? Response.json({ id: "bx_23456789", state: "resuming" }) : Response.json({ id: "other", state: "ready" })).provider
    await expect(mismatchedPoll.stopResume.resume({ accountId: "a", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    const mismatchedSnapshot = harness(() => Response.json({ ok: true, type: "snapshot.named.info", snapshot: { name: "other", status: "ready", snapshotId: "snap_artifact_1", sourceBoxId: "bx_23456789", createdAt: "2026-08-27T00:00:00Z" } })).provider
    await expect(mismatchedSnapshot.snapshots.inspect({ accountId: "a", snapshotId: "snap_silver-forest-2p9x", providerRef: snapshotRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    const invalidHosting = harness((request) => request.url.endsWith("/host") ? Response.json({ url: "https://protected.test/token#fragment" }) : Response.json({ id: "bx_23456789", state: "ready" })).provider
    await expect(invalidHosting.inspectSandbox({ accountId: "a", providerRef: { kind: "box-sandbox-v1", boxId: "bx_23456789" }, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    const changingClock = new FakeClock()
    let clockCalls = 0
    const badClock = { now: () => ++clockCalls === 1 ? new Date(0) : new Date(Number.NaN), sleep: changingClock.sleep.bind(changingClock) }
    const invalidRuntimeClock = new BoxSandboxProvider(base, { clock: badClock, fetch: async () => Response.json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { id: "bx_23456789", state: "provisioning" } }, { status: 202 }) })
    await expect(invalidRuntimeClock.createSandbox({ accountId: "a", sandboxId: "sbx_calm-cactus-7k3m", idempotencyKey: "key", signal: signal() })).rejects.toMatchObject({ kind: "failure", message: "Box provider clock is invalid" })
  })

  test("non-success Box bodies preserve exact cancellation for lifecycle and snapshot calls", async () => {
    for (const family of ["lifecycle", "snapshot"] as const) {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"code":"snapshot_quota')) },
        cancel() { cancelled = true },
      })
      const { provider } = harness(() => new Response(body, { status: 409, headers: { "content-type": "application/json" } }))
      const controller = new AbortController()
      const reason = new DOMException(`cancel ${family}`, "AbortError")
      const pending = family === "lifecycle"
        ? provider.stopResume.stop({ accountId: "acct-a", providerRef: sandboxRef, signal: controller.signal })
        : provider.snapshots.inspect({ accountId: "acct-a", snapshotId: "snap_silver-forest-2p9x", providerRef: snapshotRef, signal: controller.signal })
      await new Promise((resolve) => setTimeout(resolve, 1))
      controller.abort(reason)
      let caught: unknown
      try { await pending } catch (error) { caught = error }
      expect(caught).toBe(reason)
      expect(cancelled).toBe(true)
    }
  })

  test("validates cancellation signals and stored references before fetch", async () => {
    let fetches = 0
    const { provider } = harness(() => { fetches++; return Response.json({ id: "bx_23456789", state: "ready" }) })
    const validOperation = { accountId: "acct-a", providerRef: sandboxRef, signal: signal() }
    const validSnapshotOperation = { accountId: "acct-a", snapshotId: "snap_silver-forest-2p9x", providerRef: snapshotRef, signal: signal() }
    const cases: Array<{ name: string; invoke: () => Promise<unknown> }> = [
      { name: "create signal", invoke: () => provider.createSandbox({ accountId: "acct-a", sandboxId: "sbx_calm-cactus-7k3m", idempotencyKey: "key", signal: {} as never }) },
      { name: "create source ref", invoke: () => provider.createSandbox({ accountId: "acct-a", sandboxId: "sbx_calm-cactus-7k3m", idempotencyKey: "key", sourceSnapshotRef: { kind: "box-named-snapshot-v1", name: "waterbox-user-snapshot", extra: true }, signal: signal() }) },
      { name: "resume", invoke: () => provider.stopResume.resume({ ...validOperation, providerRef: null }) },
      { name: "delete", invoke: () => provider.deleteSandbox({ ...validOperation, signal: "signal" as never }) },
      { name: "snapshot create", invoke: () => provider.snapshots.create({ accountId: "acct-a", snapshotId: "snap_silver-forest-2p9x", sandboxRef: null, signal: signal() }) },
      { name: "snapshot inspect", invoke: () => provider.snapshots.inspect({ ...validSnapshotOperation, signal: null as never }) },
      { name: "snapshot delete", invoke: () => provider.snapshots.delete({ ...validSnapshotOperation, providerRef: { kind: "box-named-snapshot-v1", name: "waterbox-user-snapshot", extra: true } }) },
    ]
    for (const item of cases) {
      await expect(item.invoke(), item.name).rejects.toMatchObject({ kind: "failure" })
      expect(fetches, item.name).toBe(0)
    }
  })
})
