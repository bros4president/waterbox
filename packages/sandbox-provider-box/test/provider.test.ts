import { describe, expect, test } from "bun:test"
import type { ToolName } from "@waterbox/contracts"
import { ProviderError } from "@waterbox/core/provider"
import { decodeInvocation, decodeSecureTransferInput } from "@waterbox/cli/protocol"
import { BoxSandboxProvider, __testing, loadSandboxRuntimeArtifact, type BoxProviderClock, type BoxProviderDiagnostic } from "../src/index.ts"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

class FakeClock implements BoxProviderClock {
  time = 0
  sleeps = 0
  now(): Date { return new Date(this.time) }
  async sleep(milliseconds: number, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); this.sleeps++; this.time += milliseconds }
}

interface Seen { url: string; method: string; headers: Headers; body?: unknown; signal: AbortSignal | null }
const artifactBytes = new TextEncoder().encode('#!/usr/bin/env node\nconsole.log("waterbox")\n')
const artifact = { bytes: artifactBytes, sha256: createHash("sha256").update(artifactBytes).digest("hex"), cliProtocolVersion: 2 as const, artifactVersion: "0.1.0" }
function harness(handler?: (request: Request, seen: Seen[]) => Response | Promise<Response>, polling = { intervalMs: 10, timeoutMs: 100 }, diagnostic?: (event: BoxProviderDiagnostic) => void) {
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
    polling,
  }, { fetch: fakeFetch, clock, artifact, ...(diagnostic ? { diagnostic } : {}) })
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
  test("fresh create omits from, disables inherited environment, preserves idempotency, and returns a ready reference", async () => {
    let inspection = 0
    const { provider, seen, clock } = harness((request) => {
      if (request.url.endsWith("/api/box/v1/boxes") && request.method === "POST") return Response.json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { id: "bx_23456789", state: "provisioning" } })
      if (request.url.endsWith("/api/box/v1/boxes/bx_23456789") && request.method === "GET") return Response.json({ ok: true, type: "box.info", box: { id: "bx_23456789", state: ++inspection === 1 ? "provisioning" : "idle" } })
      throw new Error("unexpected request")
    })
    const result = await provider.createSandbox({ accountId: "acct-a", sandboxId: "sbx_calm-cactus-7k3m", idempotencyKey: "stable-key", signal: signal() })
    expect(result).toEqual({ state: "running", providerRef: { kind: "box-sandbox-v2", boxId: "bx_23456789" } })
    expect(seen[0]?.body).toEqual({ noEnv: true, env: { WATERBOX_SANDBOX_ID: "sbx_calm-cactus-7k3m" } })
    expect(seen[0]?.headers.get("idempotency-key")).toBe("stable-key")
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer box-secret-key")
    expect(seen.some(item => item.url.endsWith("/commands"))).toBe(false)
    expect(clock.sleeps).toBe(2)
  })

  test("create from snapshot uses only the private snapshot reference as source", async () => {
    const { provider, seen } = harness(() => Response.json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { id: "bx_abcdefgh", state: "ready" } }))
    await provider.createSandbox({ accountId: "acct-a", sandboxId: "sbx_calm-cactus-7k3m", sourceSnapshotRef: snapshotRef, idempotencyKey: "fork-key", signal: signal() })
    expect(seen[0]?.body).toEqual({ from: "waterbox-user-snapshot", noEnv: true, env: { WATERBOX_SANDBOX_ID: "sbx_calm-cactus-7k3m" } })
    expect(Object.keys(seen[0]?.body as object)).toEqual(["from", "noEnv", "env"])
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

describe("Box runtime bootstrap", () => {
  const uploadResponse = (body: unknown) => {
    const value = body as { path: string; content: string }
    return Response.json({ ok: true, type: "file.written", success: true, path: value.path, encoding: "base64", size: Buffer.from(value.content, "base64").byteLength })
  }
  const prepare = (provider: BoxSandboxProvider, abortSignal = signal()) => provider.prepareSandbox({ accountId: "acct-a", providerRef: sandboxRef, signal: abortSignal })

  async function installerFixture() {
    const root = await mkdtemp(join(tmpdir(), "waterbox-bootstrap-command-"))
    const fakeBin = join(root, "fake-bin"), libraryDirectory = join(root, "usr-local-lib"), binaryDirectory = join(root, "usr-local-bin")
    const uploadPath = join(root, "upload.js"), workspaceDirectory = join(root, "workspace"), jobsDirectory = join(root, "run", "waterbox", "bash-jobs")
    const cliPath = join(libraryDirectory, "waterbox-cli.js"), launcherPath = join(binaryDirectory, "waterbox"), manifestPath = join(libraryDirectory, "waterbox-bootstrap.json")
    const logPath = join(root, "sudo.log")
    await mkdir(fakeBin)
    const sudoPath = join(fakeBin, "sudo")
    await writeFile(sudoPath, `#!/bin/sh
set -eu
test "$1" = -n
shift
last=
for argument in "$@"; do last=$argument; done
printf '%s\t%s\n' "$1" "$last" >> "$WB_SUDO_LOG"
if test "$1" = mktemp && test -n "\${WB_FAIL_MKTEMP_PATTERN:-}"; then case "$last" in *"$WB_FAIL_MKTEMP_PATTERN"*) exit 90;; esac; fi
if test "$1" = mv && test -n "\${WB_FAIL_DEST:-}" && test "$last" = "$WB_FAIL_DEST"; then exit 91; fi
exec "$@"
`)
    await chmod(sudoPath, 0o755)
    const layout = { uploadPath, libraryDirectory, binaryDirectory, workspaceDirectory, jobsDirectory, cliPath, launcherPath, manifestPath, nodePath: Bun.which("node") ?? "/usr/local/bin/node" }
    const command = __testing.installCommand(artifact, layout)
    const environment = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, WB_SUDO_LOG: logPath }
    const run = async (extra: Record<string, string> = {}) => {
      const child = Bun.spawn(["/bin/sh", "-c", command], { env: { ...environment, ...extra }, stdout: "pipe", stderr: "pipe" })
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { exitCode, stdout, stderr }
    }
    const temporaryFiles = async () => (await Promise.all([readdir(libraryDirectory).catch(() => []), readdir(binaryDirectory).catch(() => [])])).flat().filter(name => name.startsWith(".waterbox"))
    return { root, layout, command, logPath, run, temporaryFiles }
  }

  async function verifierFixture() {
    const root = await mkdtemp(join(tmpdir(), "waterbox-verify-command-")), fakeBin = join(root, "fake-bin")
    const manifestPath = join(root, "waterbox-bootstrap.json"), cliPath = join(root, "waterbox-cli.js"), invocationLog = join(root, "invocations.log")
    const sudoPath = join(fakeBin, "sudo"), waterboxPath = join(fakeBin, "waterbox"), nodePath = join(fakeBin, "node"), rgPath = join(fakeBin, "rg")
    await mkdir(fakeBin)
    await writeFile(sudoPath, '#!/bin/sh\nset -eu\ntest "$1" = -n\nshift\nexec "$@"\n')
    await writeFile(waterboxPath, `#!/bin/sh
set -eu
printf '%s\n' "$1" >> "$WB_INVOCATION_LOG"
case "$1" in
  health) if test "\${WB_FAIL_FACT:-}" = health; then printf '%s\n' wrong; else printf '%s\n' '${JSON.stringify({ ok: true, protocolVersion: 2, tools: ["read", "write", "edit", "patch", "glob", "grep", "bash"] })}'; fi;;
  version) if test "\${WB_FAIL_FACT:-}" = version; then printf '%s\n' wrong; else printf '%s\n' '${JSON.stringify({ protocolVersion: 2 })}'; fi;;
  *) exit 2;;
esac
`)
    const realNode = Bun.which("node") ?? "/usr/local/bin/node"
    await writeFile(nodePath, `#!/bin/sh
set -eu
if test "$1" = --version; then if test "\${WB_FAIL_FACT:-}" = node; then printf '%s\n' v25.0.0; else printf '%s\n' v24.15.0; fi; else exec ${JSON.stringify(realNode)} "$@"; fi
`)
    await writeFile(rgPath, '#!/bin/sh\nset -eu\nif test "${WB_FAIL_FACT:-}" = rg; then printf "%s\\n" wrong; else printf "%s\\n" "ripgrep 14.1.0"; fi\n')
    await Promise.all([sudoPath, waterboxPath, nodePath, rgPath].map(path => chmod(path, 0o755)))
    const layout = { manifestPath, cliPath, waterboxPath, nodePath, rgPath }
    const command = __testing.verifyCommand(artifact, layout)
    const run = async (extra: Record<string, string> = {}) => {
      const child = Bun.spawn(["/bin/sh", "-c", command], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, WB_INVOCATION_LOG: invocationLog, ...extra }, stdout: "pipe", stderr: "pipe" })
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { exitCode, stdout, stderr }
    }
    const invocations = async () => (await readFile(invocationLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
    return { root, layout, command, run, invocations }
  }

  test("uploads the injected immutable artifact deterministically, installs atomically, and verifies all runtime facts", async () => {
    let verifies = 0
    const { provider, seen } = harness((request, requests) => {
      const body = requests.at(-1)?.body
      if (request.url.endsWith("/files")) return uploadResponse(body)
      const command = (body as { command: string }).command
      if (command === __testing.verifyCommand(artifact)) return commandResponse(`${++verifies === 1 ? "waterbox-bootstrap-incomplete" : "waterbox-bootstrap-ok"}\n`)
      expect(command).toBe(__testing.installCommand(artifact))
      return commandResponse("waterbox-bootstrap-installed\n")
    })

    expect(await prepare(provider)).toEqual({ state: "running", providerRef: sandboxRef })
    const upload = seen.find(item => item.url.endsWith("/files"))!
    expect(upload.method).toBe("PUT")
    expect(upload.body).toEqual({ path: __testing.artifactPath(artifact.sha256), content: Buffer.from(artifact.bytes).toString("base64"), encoding: "base64" })
    const commands = seen.filter(item => item.url.endsWith("/commands")).map(item => item.body as { command: string; timeoutSeconds: number })
    expect(commands.map(item => item.command)).toEqual([__testing.verifyCommand(artifact), __testing.installCommand(artifact), __testing.verifyCommand(artifact)])
    expect(commands.every(item => item.timeoutSeconds === 120)).toBe(true)
    const installer = commands[1]!.command
    expect(installer).toContain(`install -m 0600 '${__testing.artifactPath(artifact.sha256)}' "$cli"`)
    expect(installer).toContain(__testing.nodeSha256("$cli", true))
    expect(installer.indexOf("install -m 0600")).toBeLessThan(installer.indexOf(__testing.nodeSha256("$cli", true)))
    expect(installer.indexOf(__testing.nodeSha256("$cli", true))).toBeLessThan(installer.indexOf('mv -f "$cli"'))
    expect(installer).toContain("mv -f \"$manifest\" '/usr/local/lib/waterbox-bootstrap.json'")
    expect(installer.indexOf('mv -f "$launcher"')).toBeLessThan(installer.indexOf('mv -f "$cli"'))
    expect(installer.indexOf("/usr/local/lib/waterbox-cli.js")).toBeLessThan(installer.indexOf("/usr/local/lib/waterbox-bootstrap.json"))
    expect(installer).toContain("install -d -m 0755 -o \"$uid\" -g \"$gid\" '/workspace'")
    expect(installer).toContain("install -d -m 0700 '/run/waterbox/bash-jobs'")
    expect(installer).not.toMatch(/apt|get install|bun/i)
    const verification = commands[0]!.command
    const checks = __testing.verificationChecks(artifact)
    for (const fact of [checks.installedDigest, checks.health, checks.version, checks.node, checks.rg, "/usr/local/lib/waterbox-bootstrap.json"]) expect(verification).toContain(fact)
    expect(__testing.manifest(artifact)).toBe('{"schemaVersion":1,"artifactSha256":"' + artifact.sha256 + '","artifactVersion":"0.1.0","cliProtocolVersion":2,"nodeMajor":24,"bootstrapVersion":1}')
  })

  test("emits only sanitized preparation stage and outcome enums", async () => {
    let verifies = 0
    const diagnostics: BoxProviderDiagnostic[] = []
    const { provider } = harness((request, requests) => {
      if (request.url.endsWith("/files")) return uploadResponse(requests.at(-1)?.body)
      const command = (requests.at(-1)?.body as { command: string }).command
      if (command === __testing.verifyCommand(artifact)) return commandResponse(`${++verifies === 1 ? "waterbox-bootstrap-incomplete" : "waterbox-bootstrap-ok"}\n`)
      return commandResponse("waterbox-bootstrap-installed\n")
    }, undefined, (event) => diagnostics.push(event))

    await prepare(provider)
    expect(diagnostics).toEqual([
      { type: "preparation", stage: "verify", outcome: "incomplete" },
      { type: "preparation", stage: "upload", outcome: "complete" },
      { type: "preparation", stage: "install", outcome: "complete" },
      { type: "preparation", stage: "final-verify", outcome: "complete" },
    ])
    const serialized = JSON.stringify(diagnostics)
    for (const sensitive of ["box-secret-key", "bx_23456789", "/usr/local", "/tmp/", artifact.sha256, Buffer.from(artifact.bytes).toString("base64"), "command"]) expect(serialized).not.toContain(sensitive)
  })

  test("executes verifier incomplete, fact-failure, and complete branches at natural EOF", async () => {
    const fixture = await verifierFixture()
    try {
      expect(await fixture.run()).toEqual({ exitCode: 0, stdout: "waterbox-bootstrap-incomplete\n", stderr: "" })
      expect(await fixture.invocations()).toEqual([])

      await writeFile(fixture.layout.manifestPath, __testing.manifest(artifact))
      await writeFile(fixture.layout.cliPath, "wrong bytes")
      expect(await fixture.run()).toEqual({ exitCode: 0, stdout: "waterbox-bootstrap-incomplete\n", stderr: "" })
      expect(await fixture.invocations()).toEqual([])

      await writeFile(fixture.layout.cliPath, artifact.bytes)
      for (const fact of ["health", "version", "node", "rg"]) {
        const result = await fixture.run({ WB_FAIL_FACT: fact })
        expect(result).toEqual({ exitCode: 0, stdout: `waterbox-bootstrap-failed-${fact}\n`, stderr: "" })
      }
      expect(await fixture.run()).toEqual({ exitCode: 0, stdout: "waterbox-bootstrap-ok\n", stderr: "" })
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  })

  test("executes the generated installer safely across success, interruption, corruption, allocation failure, and concurrency", async () => {
    const fixtures: Array<Awaited<ReturnType<typeof installerFixture>>> = []
    try {
      const successful = await installerFixture(); fixtures.push(successful)
      await writeFile(successful.layout.uploadPath, artifact.bytes)
      const result = await successful.run()
      expect(result).toEqual({ exitCode: 0, stdout: "waterbox-bootstrap-installed\n", stderr: "" })
      expect(createHash("sha256").update(await readFile(successful.layout.cliPath)).digest("hex")).toBe(artifact.sha256)
      expect(await readFile(successful.layout.launcherPath, "utf8")).toBe(__testing.LAUNCHER)
      expect(await readFile(successful.layout.manifestPath, "utf8")).toBe(__testing.manifest(artifact))
      expect((await stat(successful.layout.cliPath)).mode & 0o777).toBe(0o644)
      expect((await stat(successful.layout.launcherPath)).mode & 0o777).toBe(0o755)
      expect((await stat(successful.layout.manifestPath)).mode & 0o777).toBe(0o644)
      expect((await stat(successful.layout.workspaceDirectory)).mode & 0o777).toBe(0o755)
      expect((await stat(successful.layout.jobsDirectory)).mode & 0o777).toBe(0o700)
      if (typeof process.getuid === "function") expect((await stat(successful.layout.workspaceDirectory)).uid).toBe(process.getuid())
      expect(await successful.temporaryFiles()).toEqual([])
      expect(await successful.run()).toEqual({ exitCode: 0, stdout: "waterbox-bootstrap-installed\n", stderr: "" })

      const interrupted = await installerFixture(); fixtures.push(interrupted)
      await writeFile(interrupted.layout.uploadPath, artifact.bytes)
      const interruptedResult = await interrupted.run({ WB_FAIL_DEST: interrupted.layout.manifestPath })
      expect(interruptedResult.exitCode).not.toBe(0)
      expect(await readFile(interrupted.layout.launcherPath, "utf8")).toBe(__testing.LAUNCHER)
      expect(createHash("sha256").update(await readFile(interrupted.layout.cliPath)).digest("hex")).toBe(artifact.sha256)
      await expect(readFile(interrupted.layout.manifestPath)).rejects.toBeDefined()
      const moveDestinations = (await readFile(interrupted.logPath, "utf8")).split("\n").filter(line => line.startsWith("mv\t")).map(line => line.slice(3))
      expect(moveDestinations).toEqual([interrupted.layout.launcherPath, interrupted.layout.cliPath, interrupted.layout.manifestPath])
      expect(await interrupted.temporaryFiles()).toEqual([])

      const corrupted = await installerFixture(); fixtures.push(corrupted)
      await writeFile(corrupted.layout.uploadPath, Buffer.from("wrong staged bytes"))
      const corruptedResult = await corrupted.run()
      expect(corruptedResult.exitCode).not.toBe(0)
      await expect(readFile(corrupted.layout.cliPath)).rejects.toBeDefined()
      await expect(readFile(corrupted.layout.manifestPath)).rejects.toBeDefined()
      expect(await corrupted.temporaryFiles()).toEqual([])

      const allocation = await installerFixture(); fixtures.push(allocation)
      await writeFile(allocation.layout.uploadPath, artifact.bytes)
      const allocationResult = await allocation.run({ WB_FAIL_MKTEMP_PATTERN: "/.waterbox.XXXXXX" })
      expect(allocationResult.exitCode).not.toBe(0)
      expect(await allocation.temporaryFiles()).toEqual([])

      const concurrent = await installerFixture(); fixtures.push(concurrent)
      await writeFile(concurrent.layout.uploadPath, artifact.bytes)
      await Promise.all([
        mkdir(concurrent.layout.libraryDirectory, { recursive: true }), mkdir(concurrent.layout.binaryDirectory, { recursive: true }),
        mkdir(concurrent.layout.workspaceDirectory, { recursive: true }), mkdir(concurrent.layout.jobsDirectory, { recursive: true }),
      ])
      const concurrentResults = await Promise.all([concurrent.run(), concurrent.run()])
      expect(concurrentResults.map(item => ({ exitCode: item.exitCode, stderr: item.stderr }))).toEqual([{ exitCode: 0, stderr: "" }, { exitCode: 0, stderr: "" }])
      expect(createHash("sha256").update(await readFile(concurrent.layout.cliPath)).digest("hex")).toBe(artifact.sha256)
      expect(await readFile(concurrent.layout.launcherPath, "utf8")).toBe(__testing.LAUNCHER)
      expect(await readFile(concurrent.layout.manifestPath, "utf8")).toBe(__testing.manifest(artifact))
      expect(await concurrent.temporaryFiles()).toEqual([])
    } finally {
      await Promise.all(fixtures.map(fixture => rm(fixture.root, { recursive: true, force: true })))
    }
  })

  test("restart after a completed or response-lost preparation verifies first and performs no upload or install", async () => {
    const { provider, seen } = harness(() => commandResponse("waterbox-bootstrap-ok\n"))
    await prepare(provider)
    await prepare(provider)
    expect(seen.filter(item => item.url.endsWith("/files"))).toHaveLength(0)
    expect(seen.filter(item => item.url.endsWith("/commands"))).toHaveLength(2)
    expect(seen.some(item => (item.body as any)?.command === __testing.installCommand(artifact))).toBe(false)
  })

  test("leaves a lost upload or install response ambiguous and lets a replay begin with verification", async () => {
    let phase: "upload" | "install" = "upload"; let installed = false; let uploads = 0; let installs = 0
    const { provider, seen } = harness((request, requests) => {
      if (request.url.endsWith("/files")) { uploads++; if (phase === "upload") throw new TypeError("lost response"); return uploadResponse(requests.at(-1)?.body) }
      const command = (requests.at(-1)?.body as { command: string }).command
      if (command === __testing.verifyCommand(artifact)) return commandResponse(`${installed ? "waterbox-bootstrap-ok" : "waterbox-bootstrap-incomplete"}\n`)
      installs++; if (phase === "install") throw new TypeError("lost response"); installed = true; return commandResponse("waterbox-bootstrap-installed\n")
    })
    await expect(prepare(provider)).rejects.toMatchObject({ kind: "ambiguous_execution" })
    expect(uploads).toBe(1)
    phase = "install"
    await expect(prepare(provider)).rejects.toMatchObject({ kind: "ambiguous_execution" })
    expect(installs).toBe(1)
    installed = true
    await expect(prepare(provider)).resolves.toEqual({ state: "running", providerRef: sandboxRef })
    expect(seen.filter(item => item.url.endsWith("/files"))).toHaveLength(2)
  })

  test("concurrent preparations converge through identical atomic installers", async () => {
    let installed = false; let installs = 0; let releaseInstalls!: () => void
    const bothStaged = new Promise<void>(resolve => { releaseInstalls = resolve })
    const { provider } = harness(async (request, requests) => {
      if (request.url.endsWith("/files")) return uploadResponse(requests.at(-1)?.body)
      const command = (requests.at(-1)?.body as { command: string }).command
      if (command === __testing.verifyCommand(artifact)) return commandResponse(`${installed ? "waterbox-bootstrap-ok" : "waterbox-bootstrap-incomplete"}\n`)
      if (++installs === 2) releaseInstalls()
      await bothStaged
      installed = true
      return commandResponse("waterbox-bootstrap-installed\n")
    })
    await expect(Promise.all([prepare(provider), prepare(provider)])).resolves.toHaveLength(2)
    expect(installs).toBe(2)
    const installer = __testing.installCommand(artifact)
    expect(installer).toContain("mktemp '/usr/local/lib/.waterbox-cli.")
    expect(installer.indexOf(__testing.nodeSha256("$cli", true))).toBeLessThan(installer.indexOf('mv -f "$cli"'))
    expect(installer.indexOf('mv -f "$cli"')).toBeLessThan(installer.indexOf('mv -f "$manifest"'))
  })

  test("rejects wrong upload path, size, and encoding before installation", async () => {
    for (const override of [{ path: "/tmp/wrong" }, { size: artifact.bytes.byteLength + 1 }, { encoding: "utf8" }]) {
      let uploads = 0
      const { provider, seen } = harness((request, requests) => {
        if (!request.url.endsWith("/files")) return commandResponse("waterbox-bootstrap-incomplete\n")
        uploads++
        const body = requests.at(-1)?.body as { path: string }
        return Response.json({ ok: true, type: "file.written", success: true, path: body.path, encoding: "base64", size: artifact.bytes.byteLength, ...override })
      })
      await expect(prepare(provider)).rejects.toMatchObject({ kind: "failure" })
      expect(uploads).toBe(1)
      expect(seen.filter(item => (item.body as any)?.command === __testing.installCommand(artifact))).toHaveLength(0)
    }
  })

  test("keeps a lost upload response ambiguous without retrying", async () => {
    const { provider, seen } = harness((request) => request.url.endsWith("/files") ? Promise.reject(new TypeError("box-secret-key bx_23456789 /tmp/private")) : commandResponse("waterbox-bootstrap-incomplete\n"))
    let error: unknown
    try { await prepare(provider) } catch (caught) { error = caught }
    expect(error).toMatchObject({ kind: "ambiguous_execution" })
    const uploads = seen.filter(item => item.url.endsWith("/files"))
    expect(uploads).toHaveLength(1)
    const serialized = JSON.stringify(error) + String(error)
    for (const secret of ["box-secret-key", "bx_23456789", "/tmp/", Buffer.from(artifact.bytes).toString("base64")]) expect(serialized).not.toContain(secret)
  })

  test("classifies malformed verification, command timeout metadata, and cancellation safely without mutation", async () => {
    for (const response of [Response.json({ private: "raw-response" }), commandResponse("waterbox-bootstrap-ok\n", { timedOut: true })]) {
      const { provider, seen } = harness(() => response)
      let error: unknown
      try { await prepare(provider) } catch (caught) { error = caught }
      expect(error).toMatchObject({ kind: "ambiguous_execution" })
      expect(seen).toHaveLength(1)
      const serialized = JSON.stringify(error) + String(error)
      expect(serialized).not.toContain("raw-response")
    }

    const controller = new AbortController()
    const reason = new DOMException("cancelled", "AbortError")
    const pending = prepare(harness((request, requests) => {
      if (request.url.endsWith("/files")) return uploadResponse(requests.at(-1)?.body)
      return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))
    }).provider, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 1)); controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  test("actual verification request timeout aborts transport and remains mutation-free", async () => {
    let aborted = false
    const { provider, seen } = harness(request => new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => { aborted = true; reject(request.signal.reason) }, { once: true })), { intervalMs: 1, timeoutMs: 5 })
    await expect(prepare(provider)).rejects.toMatchObject({ kind: "ambiguous_execution" })
    expect(aborted).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url.endsWith("/commands")).toBe(true)
  })

  test("independently rejects health, version, Node 24, and ripgrep verification failures", async () => {
    for (const fact of ["health", "version", "node", "rg"]) {
      const { provider, seen } = harness(() => commandResponse(`waterbox-bootstrap-failed-${fact}\n`))
      await expect(prepare(provider), fact).rejects.toMatchObject({ kind: "failure", message: "Box runtime preparation failed" })
      expect(seen).toHaveLength(1)
      const verification = (seen.at(-1)?.body as { command: string }).command
      expect(verification).toBe(__testing.verifyCommand(artifact))
      expect(verification).toContain(__testing.verificationChecks(artifact)[fact as "health" | "version" | "node" | "rg"])
    }
  })

  test("repairs an installed digest mismatch and rejects a staged digest mismatch before publishing", async () => {
    let verification = 0
    const repaired = harness((request, requests) => {
      if (request.url.endsWith("/files")) return uploadResponse(requests.at(-1)?.body)
      const command = (requests.at(-1)?.body as { command: string }).command
      if (command === __testing.verifyCommand(artifact)) return commandResponse(`${++verification === 1 ? "waterbox-bootstrap-incomplete" : "waterbox-bootstrap-ok"}\n`)
      return commandResponse("waterbox-bootstrap-installed\n")
    })
    await prepare(repaired.provider)
    expect(repaired.seen.some(item => item.url.endsWith("/files"))).toBe(true)
    expect(__testing.verifyCommand(artifact)).toContain(__testing.verificationChecks(artifact).installedDigest)

    const staged = harness((request, requests) => {
      if (request.url.endsWith("/files")) return uploadResponse(requests.at(-1)?.body)
      const command = (requests.at(-1)?.body as { command: string }).command
      return command === __testing.verifyCommand(artifact) ? commandResponse("waterbox-bootstrap-incomplete\n") : commandResponse("", { success: false, exitCode: 1 })
    })
    await expect(prepare(staged.provider)).rejects.toMatchObject({ kind: "failure" })
    const installer = __testing.installCommand(artifact)
    expect(installer.indexOf(__testing.nodeSha256("$cli", true))).toBeLessThan(installer.indexOf('mv -f "$cli"'))
    expect(staged.seen.filter(item => (item.body as any)?.command === __testing.verifyCommand(artifact))).toHaveLength(1)
  })

  test("requires exact final reconciliation after interrupted installation", async () => {
    let verifies = 0
    const { provider } = harness((request, requests) => {
      if (request.url.endsWith("/files")) return uploadResponse(requests.at(-1)?.body)
      const command = (requests.at(-1)?.body as { command: string }).command
      if (command === __testing.verifyCommand(artifact)) return commandResponse(++verifies === 1 ? "waterbox-bootstrap-incomplete\n" : "waterbox-bootstrap-ok-extra\n")
      return commandResponse("waterbox-bootstrap-installed\n")
    })
    await expect(prepare(provider)).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("rejects altered artifact metadata, bytes, protocol, and ambient non-file locations", async () => {
    const base = { apiBaseUrl: "https://api.box.test", apiKey: "key", polling: { intervalMs: 1, timeoutMs: 2 } }
    const clock = new FakeClock()
    for (const invalid of [
      { ...artifact, sha256: "0".repeat(64) }, { ...artifact, bytes: new Uint8Array() }, { ...artifact, cliProtocolVersion: 1 }, { ...artifact, artifactVersion: " " }, { ...artifact, extra: true },
    ]) expect(() => new BoxSandboxProvider(base, { clock, artifact: invalid as never })).toThrow("Box runtime artifact is invalid")
    await expect(loadSandboxRuntimeArtifact(new URL("https://example.test/private-cli.js"), "0.1.0")).rejects.toThrow("Box runtime artifact location is invalid")
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
    const base = { apiBaseUrl: "https://api.box.test", apiKey: "box-secret-key", polling: { intervalMs: 10, timeoutMs: 100 } }
    const clock = new FakeClock()
    const invalid = [
      { ...base, apiBaseUrl: "ftp://box-secret-key@example.test" }, { ...base, apiBaseUrl: "http://example.test" }, { ...base, apiBaseUrl: "https://user:pass@example.test" },
      { ...base, apiBaseUrl: "https://example.test?token=box-secret-key" }, { ...base, apiBaseUrl: " https://example.test" },
      { ...base, apiKey: " " },
      { ...base, polling: { intervalMs: 0, timeoutMs: 100 } }, { ...base, polling: { intervalMs: 100, timeoutMs: 10 } },
      { ...base, extra: true }, { ...base, polling: { intervalMs: 10, timeoutMs: 100, extra: true } },
    ]
    for (const config of invalid) expect(() => new BoxSandboxProvider(config, { clock, artifact })).toThrow("Box provider configuration is invalid")
    expect(() => new BoxSandboxProvider(base, { clock, artifact, fetch: 1 as never })).toThrow("Box provider dependencies are invalid")
    expect(() => new BoxSandboxProvider(base, { clock, artifact, extra: true } as never)).toThrow("Box provider dependencies are invalid")
    const serialized: string[] = []
    for (const config of invalid) { try { new BoxSandboxProvider(config, { clock, artifact }) } catch (error) { serialized.push(JSON.stringify(error) + String(error)) } }
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
    const invalidRuntimeClock = new BoxSandboxProvider(base, { clock: badClock, artifact, fetch: async () => Response.json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { id: "bx_23456789", state: "provisioning" } }, { status: 202 }) })
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
