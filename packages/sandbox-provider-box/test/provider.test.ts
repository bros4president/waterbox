import { describe, expect, test } from "bun:test"
import type { ToolName } from "@waterbox/contracts"
import { ProviderError } from "@waterbox/core/provider"
import { decodeInvocation, decodeSecureTransferInput } from "@waterbox/cli/protocol"
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
    polling: { intervalMs: 10, timeoutMs: 100 },
  }, { fetch: fakeFetch, clock })
  return { provider, seen, clock }
}

const signal = () => new AbortController().signal
const sandboxRef = { kind: "box-sandbox-v2", boxId: "bx_23456789" }
const snapshotRef = { kind: "box-named-snapshot-v2", name: "waterbox-user-snapshot" }
const commandResponse = (stdout: string, overrides: Record<string, unknown> = {}) => Response.json({ ok: true, type: "command.finished", success: true, exitCode: 0, stdout, stderr: "", timedOut: false, ...overrides })
const commandInvocation = (body: unknown) => {
  expect(body).toMatchObject({ timeoutSeconds: 600 })
  const command = (body as { command: string }).command
  expect(command).toMatch(/^\/usr\/local\/bin\/waterbox run j2\.[A-Za-z0-9_-]+$/)
  return decodeInvocation(command.slice("/usr/local/bin/waterbox run ".length))
}

describe("Box provider HTTP contract", () => {
  test("create disables inherited environment, preserves template and idempotency, and returns a command-backed reference", async () => {
    let inspection = 0
    const { provider, seen, clock } = harness((request) => {
      if (request.url.endsWith("/api/box/v1/boxes") && request.method === "POST") return Response.json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { id: "bx_23456789", state: "provisioning" } })
      if (request.url.endsWith("/api/box/v1/boxes/bx_23456789") && request.method === "GET") return Response.json({ ok: true, type: "box.info", box: { id: "bx_23456789", state: ++inspection === 1 ? "provisioning" : "idle" } })
      throw new Error("unexpected request")
    })
    const result = await provider.createSandbox({ accountId: "acct-a", sandboxId: "sbx_calm-cactus-7k3m", idempotencyKey: "stable-key", signal: signal() })
    expect(result).toEqual({ state: "running", providerRef: { kind: "box-sandbox-v2", boxId: "bx_23456789" } })
    expect(seen[0]?.body).toEqual({ from: "template-secret-ref", noEnv: true, env: { WATERBOX_SANDBOX_ID: "sbx_calm-cactus-7k3m" } })
    expect(seen[0]?.headers.get("idempotency-key")).toBe("stable-key")
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer box-secret-key")
    expect(seen.some(item => item.url.endsWith("/commands"))).toBe(false)
    expect(clock.sleeps).toBe(2)
  })

  test("create from snapshot uses only the private snapshot reference as source", async () => {
    const { provider, seen } = harness(() => Response.json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { id: "bx_abcdefgh", state: "ready" } }))
    await provider.createSandbox({ accountId: "acct-a", sandboxId: "sbx_calm-cactus-7k3m", sourceSnapshotRef: snapshotRef, idempotencyKey: "fork-key", signal: signal() })
    expect(seen[0]?.body).toEqual({ from: "waterbox-user-snapshot", noEnv: true, env: { WATERBOX_SANDBOX_ID: "sbx_calm-cactus-7k3m" } })
    expect(JSON.stringify(seen[0]?.body)).not.toContain("template-secret-ref")
    expect(seen[0]?.headers.get("idempotency-key")).toBe("fork-key")
  })

  test("inspect normalizes states; stop archives, resume retains identity, and delete is permanent", async () => {
    const { provider, seen } = harness((request) => {
      if (request.url.endsWith("/stop")) return Response.json({ id: "bx_23456789", state: "archived" })
      if (request.url.endsWith("/resume")) return Response.json({ id: "bx_23456789", state: "resuming" })
      if (request.method === "DELETE") return Response.json({ ok: true, type: "box.deleting", operation: { id: `bdop_${"a".repeat(32)}`, kind: "box", targetId: "bx_23456789", reason: "explicit", status: "pending", attemptCount: 0, requestedAt: "2026-08-27T00:00:00Z", completedAt: null } }, { status: 202 })
      if (request.url.includes("/deletion-operations/")) return Response.json({ ok: true, type: "deletion.operation", operation: { id: `bdop_${"a".repeat(32)}`, kind: "box", targetId: "bx_23456789", reason: "explicit", status: "completed", attemptCount: 1, requestedAt: "2026-08-27T00:00:00Z", completedAt: "2026-08-27T00:00:01Z" } })
      return Response.json({ id: "bx_23456789", state: request.method === "GET" ? "ready" : "failed" })
    })
    expect(await provider.inspectSandbox({ accountId: "a", providerRef: sandboxRef, signal: signal() })).toEqual({ state: "running", providerRef: sandboxRef })
    expect(await provider.stopResume.stop({ accountId: "a", providerRef: sandboxRef, signal: signal() })).toEqual({ state: "stopped", providerRef: sandboxRef })
    const resumed = await provider.stopResume.resume({ accountId: "a", providerRef: sandboxRef, signal: signal() })
    expect(resumed).toEqual({ state: "running", providerRef: sandboxRef })
    expect((await provider.deleteSandbox({ accountId: "a", providerRef: sandboxRef, signal: signal() })).state).toBe("terminated")
    expect(seen.some((item) => item.url.endsWith("/stop"))).toBe(true)
    expect(seen.some((item) => item.url.endsWith("/resume"))).toBe(true)
    expect(seen.some((item) => item.url.endsWith("/commands"))).toBe(false)
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

  test("transfers only ciphertext through Box files and small CLI metadata", async () => {
    const transferId = "123e4567-e89b-42d3-a456-426614174000"
    const publicKey = `age1${"q".repeat(58)}`
    const ciphertext = Buffer.from("encrypted-not-plaintext").toString("base64")
    const { provider, seen } = harness((request, requests) => {
      if (request.url.endsWith("/files")) {
        const body = requests.at(-1)?.body as { path: string; content: string }
        return Response.json({ ok: true, type: "file.written", success: true, path: body.path, encoding: "base64", size: Buffer.from(body.content, "base64").byteLength })
      }
      const command = (requests.at(-1)?.body as { command: string }).command
      if (command.endsWith("transfer-initiate")) return commandResponse(`${JSON.stringify({ transferId, publicKey, algorithm: "age-x25519", expiresAt: "2026-08-29T00:10:00.000Z" })}\n`)
      const input = decodeSecureTransferInput(command.slice("/usr/local/bin/waterbox transfer-consume ".length))
      return commandResponse(`${JSON.stringify({ transferId: input.transferId, targetPath: input.targetPath, bytes: 1 })}\n`)
    })
    const initiated = await provider.secureFileTransfer.initiate({ accountId: "a", providerRef: sandboxRef, signal: signal() })
    expect(initiated.transferId).toBe(transferId)
    const delivered = await provider.secureFileTransfer.consume({ accountId: "a", providerRef: sandboxRef, transferId, targetPath: "/root/.aws/credentials", ciphertext, signal: signal() })
    expect(delivered).toMatchObject({ transferId, targetPath: "/root/.aws/credentials" })
    const upload = seen.find((item) => item.url.endsWith("/files"))?.body as { content: string }
    expect(upload.content).toBe(ciphertext)
    expect(seen.filter((item) => item.url.endsWith("/commands")).every((item) => !JSON.stringify(item.body).includes(ciphertext))).toBe(true)
  })

  test("maps expired and consumed secure transfers without retrying", async () => {
    for (const [code, kind] of [["transfer_expired", "expired"], ["transfer_consumed", "consumed"]] as const) {
      let commands = 0
      const { provider } = harness((request, requests) => {
        if (request.url.endsWith("/files")) {
          const body = requests.at(-1)?.body as { path: string; content: string }
          return Response.json({ ok: true, type: "file.written", success: true, path: body.path, encoding: "base64", size: Buffer.from(body.content, "base64").byteLength })
        }
        commands++
        return commandResponse(`${JSON.stringify({ protocolVersion: 2, type: "error", status: code === "transfer_expired" ? 410 : 409, code })}\n`, { success: false, exitCode: 2 })
      })
      await expect(provider.secureFileTransfer.consume({ accountId: "a", providerRef: sandboxRef, transferId: "123e4567-e89b-42d3-a456-426614174000", targetPath: "secret", ciphertext: Buffer.from("cipher").toString("base64"), signal: signal() })).rejects.toMatchObject({ kind })
      expect(commands).toBe(1)
    }
  })

  test("rejects mismatched secure delivery", async () => {
    const input = { accountId: "a", providerRef: sandboxRef, transferId: "123e4567-e89b-42d3-a456-426614174000", targetPath: "secret", ciphertext: Buffer.from("cipher").toString("base64"), signal: signal() }
    const providerFor = (command: Response) => harness((request, requests) => {
      if (request.url.endsWith("/files")) {
        const body = requests.at(-1)?.body as { path: string; content: string }
        return Response.json({ ok: true, type: "file.written", success: true, path: body.path, encoding: "base64", size: Buffer.from(body.content, "base64").byteLength })
      }
      return command
    }).provider
    const mismatched = commandResponse(`${JSON.stringify({ transferId: "123e4567-e89b-42d3-a456-426614174001", targetPath: input.targetPath, bytes: 1 })}\n`)
    await expect(providerFor(mismatched).secureFileTransfer.consume(input)).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("treats a missing provider sandbox as terminated during reconciliation", async () => {
    const { provider } = harness(() => Response.json({ code: "not_found" }, { status: 404 }))
    expect(await provider.inspectSandbox({ accountId: "a", providerRef: sandboxRef, signal: signal() })).toEqual({ state: "terminated", providerRef: sandboxRef })
  })

  test("finishes deletion when the operation remains pending but the sandbox is gone", async () => {
    const operation = { id: `bdop_${"a".repeat(32)}`, kind: "box", targetId: "bx_23456789", reason: "explicit", status: "pending", attemptCount: 0, requestedAt: "2026-08-27T00:00:00Z", completedAt: null }
    const { provider, seen, clock } = harness((request) => {
      if (request.method === "DELETE") return Response.json({ ok: true, type: "box.deleting", operation }, { status: 202 })
      if (request.url.includes("/deletion-operations/")) return Response.json({ ok: true, type: "deletion.operation", operation })
      return Response.json({ code: "not_found" }, { status: 404 })
    })
    expect((await provider.deleteSandbox({ accountId: "a", providerRef: sandboxRef, signal: signal() })).state).toBe("terminated")
    expect(seen.some((item) => item.url.endsWith("/boxes/bx_23456789") && item.method === "GET")).toBe(true)
    expect(clock.sleeps).toBe(0)
  })

  test("rejects legacy daemon references instead of silently treating them as CLI-capable", async () => {
    await expect(harness().provider.inspectSandbox({ accountId: "a", providerRef: { kind: "box-sandbox-v1", boxId: "bx_23456789", daemonUrl: "https://protected.test/?_token=x" }, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
  })

  test("snapshot creation is asynchronous, provider-safe, inspectable, deletable, and quota-aware", async () => {
    const { provider, seen } = harness((request) => {
      if (request.method === "POST") return Response.json({ id: "snap-native", state: "creating" })
      if (request.method === "GET") return Response.json({ id: "snap-native", state: "ready" })
      const name = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!)
      return Response.json({ ok: true, type: "snapshot.named.deleted", name, status: "deleted" })
    })
    const created = await provider.snapshots.create({ accountId: "Customer.SECRET", snapshotId: "snap_silver-forest-2p9x", sandboxRef, signal: signal() })
    expect(created).toEqual({ state: "creating", providerRef: { kind: "box-named-snapshot-v2", name: expect.any(String) } })
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
    const inputRef = { kind: "box-sandbox-v2", boxId: "bx_23456789" } as const
    const { provider, seen } = harness((request, requests) => {
      const name = (requests.at(-1)?.body as { name: string }).name
      return Response.json({ ok: true, type: "snapshot.named.saving", status: "saving", snapshot: { name, status: "saving", sourceBoxId: inputRef.boxId, createdAt: "2026-08-27T00:00:00Z" } }, { status: 202 })
    })
    const result = await provider.snapshots.create({ accountId: "acct-continuity", snapshotId: "snap_silver-forest-2p9x", sandboxRef: inputRef, signal: controller.signal })
    const expectedName = await __testing.internalSnapshotName("acct-continuity", "snap_silver-forest-2p9x")
    expect(seen[0]?.body).toEqual({ boxId: inputRef.boxId, name: expectedName })
    expect(seen[0]?.signal).toBe(controller.signal)
    expect(result.providerRef).toEqual({ kind: "box-named-snapshot-v2", name: expectedName })
    expect(inputRef).toEqual({ kind: "box-sandbox-v2", boxId: "bx_23456789" })
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

  test("all seven tools preserve canonical arguments in one serialized command and return one result", async () => {
    const bashResult = { type: "result", outcome: "completed", title: "Bash", output: "x", metadata: { command: "echo x", workdir: ".", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } }
    const { provider, seen } = harness((_request, requests) => {
      const invocation = commandInvocation(requests.at(-1)?.body)
      return commandResponse(`${JSON.stringify(invocation.tool === "bash" ? bashResult : resultByTool[invocation.tool])}\n`)
    })
    for (const tool of ["read", "write", "edit", "patch", "glob", "grep", "bash"] as const) {
      const events = []
      for await (const event of provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: tool, arguments: argsByTool[tool] as never, signal: signal() })) events.push(event)
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe("result")
      expect(commandInvocation(seen.at(-1)?.body) as unknown).toEqual({ protocolVersion: 2, tool, arguments: argsByTool[tool] })
      expect(seen.at(-1)?.url).toBe("https://api.box.test/api/box/v1/boxes/bx_23456789/commands")
    }
  })

  test("ignores only the known Box shell warning for a deleted launch directory", async () => {
    const warning = "sh: 0: getcwd() failed: No such file or directory\n"
    const { provider } = harness(() => commandResponse(`${JSON.stringify(resultByTool.read)}\n`, { stderr: warning }))
    const events = []
    for await (const event of provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "read", arguments: { filePath: "x" }, signal: signal() })) events.push(event)
    expect(events).toHaveLength(1)

    const unexpected = harness(() => commandResponse(`${JSON.stringify(resultByTool.read)}\n`, { stderr: `${warning}unexpected\n` })).provider
    await expect(unexpected.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "read", arguments: { filePath: "x" }, signal: signal() })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("cancellation after dispatch is ambiguous and reaches the Box command request", async () => {
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
    await expect(pending).rejects.toMatchObject({ kind: "ambiguous_execution" })
    expect(observed?.aborted).toBe(true)
  })

  test("ambiguous Box command outcomes are not retried", async () => {
    let calls = 0
    const { provider } = harness(() => { calls++; return Response.json({ code: "box_direct_failed" }, { status: 502 }) })
    const iterator = provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "write", arguments: { filePath: "x", content: "x" }, signal: signal() })[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({ kind: "ambiguous_execution", message: "Tool execution outcome is unknown" })
    expect(calls).toBe(1)
  })

  test("forwards a dispatched bash receipt above the Box command timeout without polling or retry", async () => {
    const receipt = {
      type: "result", outcome: "dispatched", title: "Bash command dispatched", output: "Command dispatched. statusPath reports execution state, and outputPath receives output continuously. Repeated output reads can duplicate tokens and pollute context.",
      metadata: {
        command: "sleep 700", workdir: "/workspace", timeout: 700_000,
        jobId: `job_${"a".repeat(32)}`,
        outputPath: `/run/waterbox/bash-jobs/job_${"a".repeat(32)}/output.log`,
        statusPath: `/run/waterbox/bash-jobs/job_${"a".repeat(32)}/status.json`,
      },
    } as const
    const { provider, seen, clock } = harness(() => commandResponse(`${JSON.stringify(receipt)}\n`))

    const events = []
    for await (const event of provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "bash", arguments: { command: "sleep 700", timeout: 700_000 }, signal: signal() })) events.push(event)

    expect(events).toEqual([receipt])
    expect(seen.filter((request) => request.url.endsWith("/commands"))).toHaveLength(1)
    expect(seen).toHaveLength(1)
    expect(clock.sleeps).toBe(0)
  })

  test("samples and cleans Bash jobs with one hidden Box command per operation", async () => {
    const jobId = `job_${"a".repeat(32)}`
    const chunkBase64 = Buffer.from([0x66, 0x6f, 0x80]).toString("base64")
    const { provider, seen } = harness((_request, requests) => {
      const command = (requests.at(-1)?.body as { command: string }).command
      if (command.includes("__internal-bash-observe")) return commandResponse(`${JSON.stringify({ jobId, state: "running", chunkBase64, nextOffset: 3, outputSize: 8 })}\n`)
      return commandResponse(`${JSON.stringify({ jobId, cleaned: true })}\n`)
    })

    expect(await provider.bashJobs.observe({ accountId: "a", providerRef: sandboxRef, jobId, offset: 0, maxBytes: 4, signal: signal() })).toEqual({ jobId, state: "running", chunkBase64, nextOffset: 3, outputSize: 8 })
    await provider.bashJobs.cleanup({ accountId: "a", providerRef: sandboxRef, jobId, signal: signal() })

    expect(seen).toHaveLength(2)
    expect((seen[0]!.body as { command: string }).command).toBe(`/usr/local/bin/waterbox __internal-bash-observe ${jobId} 0 4`)
    expect((seen[1]!.body as { command: string }).command).toBe(`/usr/local/bin/waterbox __internal-bash-cleanup ${jobId}`)
  })

  test("dispatches concurrent commands without a provider-side queue", async () => {
    let dispatched = 0
    let confirmDispatch!: () => void
    let release!: () => void
    const bothDispatched = new Promise<void>((resolve) => { confirmDispatch = resolve })
    const responses = new Promise<void>((resolve) => { release = resolve })
    const { provider, seen } = harness(async (_request, requests) => {
      const body = requests.at(-1)?.body
      dispatched++
      if (dispatched === 2) confirmDispatch()
      await responses
      const invocation = commandInvocation(body)
      return commandResponse(`${JSON.stringify(resultByTool[invocation.tool as Exclude<ToolName, "bash">])}\n`)
    })
    const first = provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "read", arguments: { filePath: "a" }, signal: signal() })[Symbol.asyncIterator]().next()
    const second = provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "read", arguments: { filePath: "b" }, signal: signal() })[Symbol.asyncIterator]().next()
    await bothDispatched
    expect(seen.filter((request) => request.url.endsWith("/commands"))).toHaveLength(2)
    release()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
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
  const bashResult = { type: "result", outcome: "completed", title: "Bash", output: "", metadata: { command: "x", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } } as const

  test("rejects malformed, truncated, and multi-result CLI command envelopes as ambiguous without retry", async () => {
    const validFinal = `${JSON.stringify(bashResult)}\n`
    const variants: Array<Record<string, unknown>> = [
      { stdout: "" }, { stdout: JSON.stringify(bashResult) }, { stdout: validFinal + validFinal },
      { stdout: `{nope}\n` }, { stdout: validFinal, stdoutTruncated: true }, { stdout: validFinal, stderr: "unexpected" },
      { stdout: validFinal, success: false }, { stdout: validFinal, timedOut: true }, { stdout: validFinal, exitCode: 1 },
      { stdout: '{"protocolVersion":2,"type":"error","status":400,"code":"invalid_arguments"}\n', success: false, exitCode: 1, timedOut: true },
    ]
    for (const variant of variants) {
      let calls = 0
      const { provider } = harness(() => { calls++; return commandResponse(String(variant.stdout ?? ""), variant) })
      const iterator = provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "bash", arguments: { command: "x" }, signal: signal() })[Symbol.asyncIterator]()
      let error: unknown
      try { while (!(await iterator.next()).done) {} } catch (caught) { error = caught }
      expect(error).toMatchObject({ kind: "ambiguous_execution", message: "Tool execution outcome is unknown" })
      expect(calls).toBe(1)
    }
  })

  test("command ambiguity distinguishes definite API and CLI rejections from uncertain execution", async () => {
    const cases = [
      { response: Response.json({ code: "invalid_arguments" }, { status: 400 }), kind: "failure" },
      { response: Response.json({ code: "internal" }, { status: 500 }), kind: "ambiguous_execution" },
      { response: commandResponse('{"protocolVersion":2,"type":"error","status":400,"code":"tool_rejected"}\n', { success: false, exitCode: 2 }), kind: "failure" },
      { response: commandResponse('{"protocolVersion":2,"type":"error","status":500,"code":"internal_error"}\n', { success: false, exitCode: 1 }), kind: "ambiguous_execution" },
      { response: commandResponse('{"protocolVersion":1,"type":"error","status":400,"code":"tool_rejected"}\n', { success: false, exitCode: 2 }), kind: "ambiguous_execution" },
    ] as const
    for (const item of cases) {
      let calls = 0
      const { provider } = harness(() => { calls++; return item.response })
      const iterator = provider.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "write", arguments: { filePath: "x", content: "x" }, signal: signal() })[Symbol.asyncIterator]()
      await expect(iterator.next()).rejects.toMatchObject({ kind: item.kind })
      expect(calls).toBe(1)
    }
    let calls = 0
    const transport = harness(() => { calls++; throw new Error("daemon-secret query-secret") }).provider
    await expect(transport.executeTool({ accountId: "a", providerRef: sandboxRef, toolName: "write", arguments: { filePath: "x", content: "x" }, signal: signal() })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ kind: "ambiguous_execution", message: "Tool execution outcome is unknown" })
    expect(calls).toBe(1)
  })

  test("command stdout requires one exact canonical final event", async () => {
    for (const stdout of [
      `${JSON.stringify({ ...readResult, extra: true })}\n`,
      `${JSON.stringify({ type: "stdout", data: "x" })}\n`,
      `${"x".repeat(1_000)}\n`,
    ]) {
      const { provider } = harness(() => commandResponse(stdout))
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
    const base = { apiBaseUrl: "https://api.box.test", apiKey: "box-secret-key", systemTemplateRef: "template-secret-ref", polling: { intervalMs: 10, timeoutMs: 100 } }
    const clock = new FakeClock()
    const invalid = [
      { ...base, apiBaseUrl: "ftp://box-secret-key@example.test" }, { ...base, apiBaseUrl: "http://example.test" }, { ...base, apiBaseUrl: "https://user:pass@example.test" },
      { ...base, apiBaseUrl: "https://example.test?token=box-secret-key" }, { ...base, apiBaseUrl: " https://example.test" },
      { ...base, apiKey: " " }, { ...base, systemTemplateRef: " template " },
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
      { kind: "box-sandbox-v2", boxId: "" }, { kind: "box-sandbox-v2", boxId: "bx_23456789", extra: true },
      { kind: "box-sandbox-v1", boxId: "bx_23456789" },
    ]
    for (const providerRef of invalidRefs) await expect(harness().provider.inspectSandbox({ accountId: "a", providerRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    await expect(harness().provider.snapshots.inspect({ accountId: "a", snapshotId: "snap_silver-forest-2p9x", providerRef: { kind: "box-named-snapshot-v2", name: "waterbox-user-snapshot", extra: true }, signal: signal() })).rejects.toMatchObject({ kind: "failure" })

    for (const payload of [{ id: "other", state: "ready" }, { id: "", state: "ready" }]) {
      const { provider } = harness(() => Response.json(payload))
      await expect(provider.inspectSandbox({ accountId: "a", providerRef: { kind: "box-sandbox-v2", boxId: "bx_23456789" }, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    }
    const mismatchedStop = harness(() => Response.json({ id: "other", state: "archived" })).provider
    await expect(mismatchedStop.stopResume.stop({ accountId: "a", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    const mismatchedPoll = harness((request) => request.url.endsWith("/resume") ? Response.json({ id: "bx_23456789", state: "resuming" }) : Response.json({ id: "other", state: "ready" })).provider
    await expect(mismatchedPoll.stopResume.resume({ accountId: "a", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    const mismatchedSnapshot = harness(() => Response.json({ ok: true, type: "snapshot.named.info", snapshot: { name: "other", status: "ready", snapshotId: "snap_artifact_1", sourceBoxId: "bx_23456789", createdAt: "2026-08-27T00:00:00Z" } })).provider
    await expect(mismatchedSnapshot.snapshots.inspect({ accountId: "a", snapshotId: "snap_silver-forest-2p9x", providerRef: snapshotRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
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
      { name: "create source ref", invoke: () => provider.createSandbox({ accountId: "acct-a", sandboxId: "sbx_calm-cactus-7k3m", idempotencyKey: "key", sourceSnapshotRef: { kind: "box-named-snapshot-v2", name: "waterbox-user-snapshot", extra: true }, signal: signal() }) },
      { name: "resume", invoke: () => provider.stopResume.resume({ ...validOperation, providerRef: null }) },
      { name: "delete", invoke: () => provider.deleteSandbox({ ...validOperation, signal: "signal" as never }) },
      { name: "snapshot create", invoke: () => provider.snapshots.create({ accountId: "acct-a", snapshotId: "snap_silver-forest-2p9x", sandboxRef: null, signal: signal() }) },
      { name: "snapshot inspect", invoke: () => provider.snapshots.inspect({ ...validSnapshotOperation, signal: null as never }) },
      { name: "snapshot delete", invoke: () => provider.snapshots.delete({ ...validSnapshotOperation, providerRef: { kind: "box-named-snapshot-v2", name: "waterbox-user-snapshot", extra: true } }) },
    ]
    for (const item of cases) {
      await expect(item.invoke(), item.name).rejects.toMatchObject({ kind: "failure" })
      expect(fetches, item.name).toBe(0)
    }
  })
})
