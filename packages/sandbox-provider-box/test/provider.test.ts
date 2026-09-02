import { describe, expect, test } from "bun:test"
import type { Identity, SandboxId } from "@waterbox/contracts"
import { SandboxService } from "@waterbox/core"
import { FixedClock, InMemoryIdempotencyRepository, InMemorySandboxRepository, InMemorySnapshotRepository, SequenceIdGenerator } from "@waterbox/core/test-support"
import { decodeInvocation } from "@waterbox/cli/protocol"
import { createHash } from "node:crypto"
import { BOX_RUNTIME_PATH_PROVISIONER, BOX_RUNTIME_PROFILE, BoxSandboxInfrastructure, BoxSandboxProvider, type BoxProviderClock } from "../src/index.ts"

class Clock implements BoxProviderClock {
  now(): Date { return new Date(0) }
  async sleep(_milliseconds: number, signal: AbortSignal): Promise<void> { signal.throwIfAborted() }
}

const signal = () => new AbortController().signal
const sandboxRef = { kind: "box-sandbox-v2", boxId: "bx_23456789" } as const
const artifactBytes = new TextEncoder().encode("#!/usr/bin/env node\nconsole.log('waterbox')\n")
const artifact = { bytes: artifactBytes, sha256: createHash("sha256").update(artifactBytes).digest("hex"), cliProtocolVersion: 2 as const, artifactVersion: "0.1.0" }

function infrastructure(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request)
    return handler(request)
  }
  const value = new BoxSandboxInfrastructure({ apiBaseUrl: "https://box.test/v1", apiKey: "test-key", polling: { intervalMs: 1, timeoutMs: 20 } }, { clock: new Clock(), fetch })
  return { value, requests, fetch }
}

const box = (state = "ready") => Response.json({ ok: true, type: "box.info", box: { id: "bx_23456789", state } })
const command = (stdout: string, options: Record<string, unknown> = {}) => Response.json({ ok: true, type: "command.finished", success: true, exitCode: 0, stdout, stderr: "", timedOut: false, ...options })

describe("Box primitive contracts", () => {
  test("creates a durable Box reference with native idempotency and exact readiness polling", async () => {
    let polls = 0
    const { value, requests } = infrastructure(request => {
      if (request.method === "POST") return Response.json({ ok: true, type: "box.created", status: "provisioning", box: { id: "bx_23456789", state: "provisioning" } }, { status: 202 })
      return box(++polls === 1 ? "provisioning" : "ready")
    })
    await expect(value.create({ accountId: "account", sandboxId: "sbx_calm-cactus-7k3m" as never, idempotencyKey: "create-once", signal: signal() })).resolves.toEqual({ state: "running", providerRef: sandboxRef })
    expect((await requests[0]!.json())).toEqual({ noEnv: true, env: { WATERBOX_SANDBOX_ID: "sbx_calm-cactus-7k3m" } })
    expect(requests[0]!.headers.get("idempotency-key")).toBe("create-once")
  })

  test("sends ttlSeconds only for a configured automatic stop", async () => {
    const requests: Request[] = []
    const value = new BoxSandboxInfrastructure({ apiBaseUrl: "https://box.test/v1", apiKey: "test-key", polling: { intervalMs: 1, timeoutMs: 20 }, automaticStopMs: 5_400_000 }, {
      clock: new Clock(),
      fetch: async (input, init) => {
        const request = new Request(input, init); requests.push(request)
        return request.method === "POST"
          ? Response.json({ ok: true, type: "box.created", status: "provisioning", box: { id: "bx_23456789", state: "provisioning" } }, { status: 202 })
          : box("ready")
      },
    })
    await value.create({ accountId: "account", sandboxId: "sbx_calm-cactus-7k3m" as never, idempotencyKey: "create-auto-stop", signal: signal() })
    expect(await requests[0]!.json()).toEqual({ noEnv: true, env: { WATERBOX_SANDBOX_ID: "sbx_calm-cactus-7k3m" }, ttlSeconds: 5_400 })
  })

  test("maps a longest Friendly Words snapshot ID to its stable truncated and hashed Box name", async () => {
    const snapshotId = "snap_quintessential-quintessential-gigantspinosaurus" as never
    let name: string | undefined
    const { value } = infrastructure(async request => {
      if (request.method === "GET") return box("ready")
      const body = await request.json() as { name: string }
      name = body.name
      return Response.json({ ok: true, type: "snapshot.named.saving", status: "saving", snapshot: { name: body.name, sourceBoxId: sandboxRef.boxId, status: "saving" } }, { status: 202 })
    })
    await expect(value.snapshots.create({ accountId: "account", snapshotId, providerRef: sandboxRef, expectedState: "running", signal: signal() })).resolves.toMatchObject({ state: "creating" })
    const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12)
    expect(name).toBe(`waterbox-account-${hash("account")}-snap-qui-${hash(snapshotId)}`)
  })

  test("keeps exact inspection side-effect free and preserves persisted references", async () => {
    const { value, requests } = infrastructure(() => Response.json({ code: "not_found" }, { status: 404 }))
    await expect(value.inspect({ accountId: "account", providerRef: sandboxRef, signal: signal() })).resolves.toEqual({ state: "terminated", providerRef: sandboxRef })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe("GET")
  })

  test("reports lost responses for every dispatched sandbox mutation as ambiguous without changing read failures", async () => {
    const lost = () => { throw new Error("connection closed after dispatch") }
    const created = infrastructure(lost).value
    const stopped = infrastructure(lost).value
    const resumed = infrastructure(lost).value
    const deleted = infrastructure(lost).value
    const inspected = infrastructure(lost).value
    await expect(created.create({ accountId: "account", sandboxId: "sbx_calm-cactus-7k3m" as never, idempotencyKey: "lost-create", signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    await expect(stopped.stopResume.stop({ accountId: "account", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    await expect(resumed.stopResume.resume({ accountId: "account", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    await expect(deleted.delete({ accountId: "account", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    await expect(inspected.inspect({ accountId: "account", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
  })

  test("keeps definite native mutation rejections definitive", async () => {
    const rejected = () => Response.json({ code: "rate_limited" }, { status: 429 })
    const created = infrastructure(rejected).value
    const stopped = infrastructure(rejected).value
    const resumed = infrastructure(rejected).value
    const deleted = infrastructure(rejected).value
    await expect(created.create({ accountId: "account", sandboxId: "sbx_calm-cactus-7k3m" as never, idempotencyKey: "rejected-create", signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    await expect(stopped.stopResume.stop({ accountId: "account", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    await expect(resumed.stopResume.resume({ accountId: "account", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    await expect(deleted.delete({ accountId: "account", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
  })

  test("classifies every dispatched lifecycle response that cannot prove its result as ambiguous without retrying", async () => {
    const lifecycle = [
      ["create", (value: BoxSandboxInfrastructure) => value.create({ accountId: "account", sandboxId: "sbx_calm-cactus-7k3m" as never, idempotencyKey: "uncertain-create", signal: signal() })],
      ["stop", (value: BoxSandboxInfrastructure) => value.stopResume.stop({ accountId: "account", providerRef: sandboxRef, signal: signal() })],
      ["resume", (value: BoxSandboxInfrastructure) => value.stopResume.resume({ accountId: "account", providerRef: sandboxRef, signal: signal() })],
      ["delete", (value: BoxSandboxInfrastructure) => value.delete({ accountId: "account", providerRef: sandboxRef, signal: signal() })],
    ] as const
    const cases = [
      ["HTTP 500", () => Response.json({ code: "internal" }, { status: 500 })],
      ["malformed envelope", () => Response.json({ ok: true, type: "unexpected" }, { status: 202 })],
      ["unexpected successful status", () => Response.json({ ok: true }, { status: 200 })],
    ] as const
    for (const [caseName, response] of cases) {
      for (const [operationName, invoke] of lifecycle) {
        let fetches = 0
        const { value } = infrastructure(() => { fetches += 1; return response() })
        await expect(invoke(value), `${caseName}: ${operationName}`).rejects.toMatchObject({ kind: "ambiguous_execution" })
        expect(fetches, `${caseName}: ${operationName}`).toBe(1)
      }
    }
  })

  test("reports an adapter-detected lost mutation response even when the caller abort races it", async () => {
    const controller = new AbortController()
    const { value } = infrastructure(() => {
      controller.abort(new DOMException("caller left", "AbortError"))
      throw new Error("connection closed after dispatch")
    })
    await expect(value.stopResume.stop({ accountId: "account", providerRef: sandboxRef, signal: controller.signal })).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("keeps actual post-dispatch aborts and server failures ambiguous for writes and snapshots", async () => {
    const controller = new AbortController()
    const aborted = infrastructure(() => { controller.abort(new DOMException("late abort", "AbortError")); throw new DOMException("late abort", "AbortError") }).value
    await expect(aborted.writeFile({ accountId: "account", providerRef: sandboxRef, path: "/tmp/a", contents: new Uint8Array(), signal: controller.signal })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    const failed = infrastructure(request => request.method === "GET" ? box("ready") : Response.json({ code: "internal" }, { status: 500 })).value
    await expect(failed.snapshots.create({ accountId: "account", snapshotId: "snap_silver-forest-2p9x" as never, providerRef: sandboxRef, expectedState: "running", signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    const snapshotController = new AbortController()
    const snapshotAbort = infrastructure(request => {
      if (request.method === "GET") return box("ready")
      snapshotController.abort(new DOMException("late abort", "AbortError"))
      throw new DOMException("late abort", "AbortError")
    }).value
    await expect(snapshotAbort.snapshots.create({ accountId: "account", snapshotId: "snap_silver-forest-2p9x" as never, providerRef: sandboxRef, expectedState: "running", signal: snapshotController.signal })).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("honors cancellation before file-write and snapshot-delete dispatch", async () => {
    let requests = 0
    const { value } = infrastructure(() => { requests++; throw new Error("must not dispatch") })
    const controller = new AbortController(), reason = new DOMException("cancelled", "AbortError")
    controller.abort(reason)
    await expect(value.writeFile({ accountId: "account", providerRef: sandboxRef, path: "/tmp/a", contents: new Uint8Array(), signal: controller.signal })).rejects.toBe(reason)
    await expect(value.snapshots.delete({ accountId: "account", snapshotId: "snap_silver-forest-2p9x" as never, providerRef: { kind: "box-named-snapshot-v2", name: "waterbox-user-snapshot" }, signal: controller.signal })).rejects.toBe(reason)
    expect(requests).toBe(0)
  })

  test("treats snapshot 404 as deleted and a lost delete acknowledgement as ambiguous", async () => {
    const ref = { kind: "box-named-snapshot-v2", name: "waterbox-user-snapshot" } as const
    await expect(infrastructure(() => Response.json({ code: "not_found" }, { status: 404 })).value.snapshots.inspect({ accountId: "account", snapshotId: "snap_silver-forest-2p9x" as never, providerRef: ref, signal: signal() })).resolves.toMatchObject({ state: "deleted" })
    await expect(infrastructure(() => { throw new TypeError("lost after delete") }).value.snapshots.delete({ accountId: "account", snapshotId: "snap_silver-forest-2p9x" as never, providerRef: ref, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("accepts terminal sandbox absence on a retry after a lost delete acknowledgement", async () => {
    const lost = infrastructure(() => { throw new TypeError("lost after delete") }).value
    await expect(lost.delete({ accountId: "account", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    await expect(infrastructure(() => Response.json({ code: "not_found" }, { status: 404 })).value.delete({ accountId: "account", providerRef: sandboxRef, signal: signal() })).resolves.toMatchObject({ state: "terminated" })
  })

  test("does not mistake a missing deletion-operation record for sandbox absence", async () => {
    const { value } = infrastructure(request => request.method === "DELETE"
      ? Response.json({ ok: true, type: "box.deleting", operation: { id: `bdop_${"a".repeat(32)}`, kind: "box", targetId: sandboxRef.boxId, status: "pending" } }, { status: 202 })
      : Response.json({ code: "not_found" }, { status: 404 }))
    await expect(value.delete({ accountId: "account", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("bounds requests independently and preserves read versus dispatched-write outcomes", async () => {
    const fetch = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }))
    const value = new BoxSandboxInfrastructure({ apiBaseUrl: "https://box.test/v1", apiKey: "test-key", polling: { intervalMs: 1, timeoutMs: 5 } }, { clock: new Clock(), fetch })
    await expect(value.inspect({ accountId: "account", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    await expect(value.writeFile({ accountId: "account", providerRef: sandboxRef, path: "/tmp/a", contents: new Uint8Array(), signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("allows a command its requested timeout plus the polling transport allowance", async () => {
    const value = new BoxSandboxInfrastructure({ apiBaseUrl: "https://box.test/v1", apiKey: "test-key", polling: { intervalMs: 1, timeoutMs: 5 } }, { clock: new Clock(), fetch: async () => { await Bun.sleep(10); return command("ok") } })
    await expect(value.runCommand({ accountId: "account", providerRef: sandboxRef, script: "true", timeoutMs: 20, signal: signal() })).resolves.toMatchObject({ exitCode: 0 })
  })

  test("maps the bounded terminal command result without exposing a Box command DTO", async () => {
    const { value, requests } = infrastructure(() => command("ok\n"))
    await expect(value.runCommand({ accountId: "account", providerRef: sandboxRef, script: "printf ok", cwd: "/workspace", timeoutMs: 120_000, maxStdoutBytes: 10, maxStderrBytes: 10, signal: signal() })).resolves.toEqual({ exitCode: 0, stdout: new TextEncoder().encode("ok\n"), stderr: new Uint8Array(), timedOut: false, stdoutTruncated: false, stderrTruncated: false })
    expect(await requests[0]!.json()).toEqual({ command: "printf ok", timeoutSeconds: 120 })
  })

  test("does not turn a provider success:false response into a successful terminal result", async () => {
    const { value } = infrastructure(() => command("unexpected\n", { success: false }))
    await expect(value.runCommand({ accountId: "account", providerRef: sandboxRef, script: "printf ok", timeoutMs: 1_000, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("normalizes only Box's known getcwd warning before returning primitive stderr", async () => {
    const { value } = infrastructure(() => command("ok\n", { stderr: "sh: 0: getcwd() failed: No such file or directory\n" }))
    await expect(value.runCommand({ accountId: "account", providerRef: sandboxRef, script: "printf ok", timeoutMs: 1_000, signal: signal() })).resolves.toMatchObject({ stderr: new Uint8Array() })
  })

  test("writes trusted bytes as adapter-local base64 while preserving their exact length", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 255])
    let received: { path: string; content: string; encoding: string } | undefined
    const { value } = infrastructure(async request => {
      const body = await request.json() as { path: string; content: string; encoding: string }
      received = body
      return Response.json({ ok: true, type: "file.written", success: true, path: body.path, encoding: "base64", size: Buffer.from(body.content, "base64").byteLength })
    })
    await value.writeFile({ accountId: "account", providerRef: sandboxRef, path: "/tmp/runtime.js", contents: bytes, mode: 0o640, signal: signal() })
    expect(received).toEqual({ path: "/tmp/runtime.js", content: Buffer.from(bytes).toString("base64"), encoding: "base64" })
  })

  test("requires a running exact source immediately before native snapshot dispatch", async () => {
    let posts = 0
    const { value } = infrastructure(request => {
      if (request.method === "GET") return box("archived")
      posts++
      throw new Error("snapshot must not dispatch")
    })
    await expect(value.snapshots.create({ accountId: "account", snapshotId: "snap_silver-forest-2p9x" as never, providerRef: sandboxRef, expectedState: "running", signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    expect(posts).toBe(0)
  })

  test("rejects malformed native snapshot and deletion envelopes", async () => {
    const { value } = infrastructure(async request => {
      if (request.method === "GET" && new URL(request.url).pathname.includes("/boxes/")) return box("ready")
      if (request.method === "POST") {
        const body = await request.json() as { name: string }
        return Response.json({ ok: true, type: "snapshot.named.saving", status: "ready", snapshot: { name: body.name, sourceBoxId: sandboxRef.boxId, status: "saving" } }, { status: 202 })
      }
      if (request.method === "DELETE") return Response.json({ ok: true, type: "box.deleting", operation: { id: `bdop_${"a".repeat(32)}`, kind: "snapshot", targetId: sandboxRef.boxId, status: "completed" } }, { status: 202 })
      return Response.json({ ok: true, type: "snapshot.named.info", snapshot: { name: "waterbox-user-snapshot", sourceBoxId: sandboxRef.boxId, status: "ready" } })
    })
    await expect(value.snapshots.create({ accountId: "account", snapshotId: "snap_silver-forest-2p9x" as never, providerRef: sandboxRef, expectedState: "running", signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    await expect(value.snapshots.inspect({ accountId: "account", snapshotId: "snap_silver-forest-2p9x" as never, providerRef: { kind: "box-named-snapshot-v2", name: "waterbox-user-snapshot" }, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    await expect(value.delete({ accountId: "account", providerRef: sandboxRef, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("does not dispatch a native snapshot when a core-running source stops before the native revalidation", async () => {
    let reads = 0
    let posts = 0
    const { fetch } = infrastructure(request => {
      if (request.method === "GET") return box(++reads === 1 ? "ready" : "archived")
      posts++
      throw new Error("snapshot mutation must not dispatch")
    })
    const provider = new BoxSandboxProvider({ apiBaseUrl: "https://box.test/v1", apiKey: "test-key", polling: { intervalMs: 1, timeoutMs: 20 } }, { clock: new Clock(), fetch, artifact })
    const sandboxes = new InMemorySandboxRepository()
    const identity: Identity = { accountId: "account" }
    const sandboxId = "sbx_calm-cactus-7k3m" as SandboxId
    await sandboxes.createIfAbsent({ accountId: identity.accountId, sandboxId, provider: provider.name, providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", providerRef: sandboxRef, state: "running", version: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" })
    const service = new SandboxService({
      sandboxes,
      snapshots: new InMemorySnapshotRepository(),
      idempotency: new InMemoryIdempotencyRepository(),
      providers: new Map([[provider.name, provider]]),
      defaultProvider: provider.name,
      providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      clock: new FixedClock(),
      ids: new SequenceIdGenerator([], ["snap_silver-forest-2p9x"]),
    })
    await expect(service.createSnapshot(identity, sandboxId, {})).rejects.toMatchObject({ code: "provider_failure" })
    expect(reads).toBe(2)
    expect(posts).toBe(0)
  })
})

describe("assembled Box compatibility", () => {
  test("maps an omitted native snapshot source observation without changing the durable source", async () => {
    const { fetch } = infrastructure(async request => {
      const path = new URL(request.url).pathname
      if (request.method === "GET" && path.endsWith(`/boxes/${sandboxRef.boxId}`)) return box("ready")
      if (request.method === "POST" && path.endsWith("/named-snapshots")) {
        const body = await request.json() as { name: string }
        return Response.json({ ok: true, type: "snapshot.named.saving", status: "saving", snapshot: { name: body.name, sourceBoxId: sandboxRef.boxId, status: "ready", snapshotId: "native-snapshot" } }, { status: 202 })
      }
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    const provider = new BoxSandboxProvider({ apiBaseUrl: "https://box.test/v1", apiKey: "test-key", polling: { intervalMs: 1, timeoutMs: 20 } }, { clock: new Clock(), fetch, artifact })
    const sandboxes = new InMemorySandboxRepository(), snapshots = new InMemorySnapshotRepository()
    const identity: Identity = { accountId: "account" }
    const sandboxId = "sbx_calm-cactus-7k3m" as SandboxId
    await sandboxes.createIfAbsent({ accountId: identity.accountId, sandboxId, provider: provider.name, providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", providerRef: sandboxRef, state: "running", version: 1, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" })
    const service = new SandboxService({ sandboxes, snapshots, idempotency: new InMemoryIdempotencyRepository(), providers: new Map([[provider.name, provider]]), defaultProvider: provider.name, providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", clock: new FixedClock(), ids: new SequenceIdGenerator([], ["snap_silver-forest-2p9x"]) })

    const created = await service.createSnapshot(identity, sandboxId, {})
    expect(created).toMatchObject({ state: "ready" })
    expect((await snapshots.get(identity.accountId, "snap_silver-forest-2p9x" as never))?.state).toBe("ready")
    expect((await sandboxes.get(identity.accountId, sandboxId))?.state).toBe("running")
  })

  test("uses the shared backend for preparation while preserving the high-level composition surface", async () => {
    let verifies = 0
    let installer = ""
    const { fetch } = infrastructure(async request => {
      if (new URL(request.url).pathname.endsWith("/files")) {
        const body = await request.json() as { path: string; content: string }
        return Response.json({ ok: true, type: "file.written", success: true, path: body.path, encoding: "base64", size: Buffer.from(body.content, "base64").byteLength })
      }
      const body = await request.json() as { command: string }
      if (body.command.includes("waterbox-bootstrap-installed")) { installer = body.command; return command("waterbox-bootstrap-installed\n") }
      if (body.command.includes("waterbox-bootstrap")) return command(++verifies === 1 ? "waterbox-bootstrap-incomplete\n" : "waterbox-bootstrap-ok\n")
      throw new Error("unexpected command")
    })
    const provider = new BoxSandboxProvider({ apiBaseUrl: "https://box.test/v1", apiKey: "test-key", polling: { intervalMs: 1, timeoutMs: 20 } }, { clock: new Clock(), fetch, artifact })
    await expect(provider.prepareSandbox({ accountId: "account", providerRef: sandboxRef, signal: signal() })).resolves.toEqual({ state: "running", providerRef: sandboxRef })
    expect(provider.name).toBe("box")
    expect(provider.stopResume).toBeDefined()
    expect(provider.snapshots).toBeDefined()
    const encodedLauncher = installer.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > '\/usr\/local\/bin\/waterbox'/)?.[1]
    expect(encodedLauncher).toBeDefined()
    expect(Buffer.from(encodedLauncher!, "base64").toString("utf8")).toBe([
      "#!/bin/sh",
      "set -eu",
      "test -d '/run/waterbox/bash-jobs'",
      "cd '/home/user/workspace'",
      "exec sudo -n env WORKSPACE_ROOT='/home/user/workspace' /usr/local/bin/node '/usr/local/lib/waterbox-cli.js' \"$@\"",
      "",
    ].join("\n"))
    expect(installer).toContain("install -m 0644 '/tmp/waterbox-runtime-")
    expect(installer).toContain("mv -f \"$tmp\" '/usr/local/lib/waterbox-cli.js'")
    expect(installer).toContain("chmod 0755 '/usr/local/bin/waterbox'")
    expect(installer).toContain("chmod 0644 '/usr/local/lib/waterbox-bootstrap.json'")
  })

  test("repairs the incomplete runtime inherited by a restored Box sandbox before a missing CLI can write verifier stderr", async () => {
    let verifies = 0
    const { fetch } = infrastructure(async request => {
      if (new URL(request.url).pathname.endsWith("/files")) {
        const body = await request.json() as { path: string; content: string }
        return Response.json({ ok: true, type: "file.written", success: true, path: body.path, encoding: "base64", size: Buffer.from(body.content, "base64").byteLength })
      }
      const body = await request.json() as { command: string }
      if (body.command.includes("waterbox-bootstrap-installed")) return command("waterbox-bootstrap-installed\n")
      if (body.command.includes("waterbox-bootstrap")) {
        verifies++
        if (verifies === 1) {
          expect(body.command.indexOf("! test -f '/usr/local/lib/waterbox-cli.js'")).toBeGreaterThan(-1)
          expect(body.command.indexOf("! test -f '/usr/local/lib/waterbox-cli.js'")).toBeLessThan(body.command.indexOf("node -e"))
          return command("waterbox-bootstrap-incomplete\n")
        }
        return command("waterbox-bootstrap-ok\n")
      }
      throw new Error("unexpected command")
    })
    const provider = new BoxSandboxProvider({ apiBaseUrl: "https://box.test/v1", apiKey: "test-key", polling: { intervalMs: 1, timeoutMs: 20 } }, { clock: new Clock(), fetch, artifact })
    await expect(provider.prepareSandbox({ accountId: "account", providerRef: sandboxRef, signal: signal() })).resolves.toEqual({ state: "running", providerRef: sandboxRef })
    expect(verifies).toBe(2)
  })

  test("injects Box's non-interactive provisioner while keeping the launcher protocol shared", () => {
    const profile = BOX_RUNTIME_PROFILE
    expect(BOX_RUNTIME_PATH_PROVISIONER.provision(profile)).toBe([
      "uid=$(id -u); gid=$(id -g)",
      "sudo -n true",
      "sudo -n install -d -m 0755 -o \"$uid\" -g \"$gid\" '/home/user/workspace'",
      "sudo -n install -d -m 0755 -o \"$uid\" -g \"$gid\" '/usr/local/lib'",
      "sudo -n install -d -m 0755 -o \"$uid\" -g \"$gid\" '/usr/local/bin'",
      "sudo -n install -d -m 0700 '/run/waterbox/bash-jobs'",
    ].join("\n"))
    expect(profile.workspacePath).toBe("/home/user/workspace")
    expect(profile.persistentPaths.workspace).toBe("/home/user/workspace")
    expect(BOX_RUNTIME_PATH_PROVISIONER.launch?.(profile)).toBe("sudo -n env WORKSPACE_ROOT='/home/user/workspace' /usr/local/bin/node '/usr/local/lib/waterbox-cli.js' \"$@\"" )
  })

  test("routes canonical MCP tool invocations, ciphertext transfer, and Bash observation through the configured Box composition", async () => {
    const transferId = "123e4567-e89b-42d3-a456-426614174000"
    let toolIndex = 0
    const commands: string[] = []
    const { fetch } = infrastructure(async request => {
      if (new URL(request.url).pathname.endsWith("/files")) {
        const body = await request.json() as { path: string; content: string }
        return Response.json({ ok: true, type: "file.written", success: true, path: body.path, encoding: "base64", size: Buffer.from(body.content, "base64").byteLength })
      }
      const body = await request.json() as { command: string }
      commands.push(body.command)
      if (body.command.endsWith("transfer-initiate")) return command(JSON.stringify({ transferId, publicKey: `age1${"q".repeat(58)}`, algorithm: "age-x25519", expiresAt: "2026-10-01T00:00:00.000Z" }) + "\n")
      if (body.command.includes("transfer-consume")) return command(JSON.stringify({ transferId, targetPath: "secret", bytes: 6 }) + "\n")
      if (body.command.includes("__internal-bash-observe")) return command(JSON.stringify({ jobId: `job_${"a".repeat(32)}`, state: "completed", chunkBase64: "b2s=", nextOffset: 2, outputSize: 2, exitCode: 0, timedOut: false, durationMs: 1 }) + "\n")
      if (body.command.includes("__internal-bash-cleanup")) return command(JSON.stringify({ jobId: `job_${"a".repeat(32)}`, cleaned: true }) + "\n")
      const events = [
        { type: "result", title: "read", output: "", metadata: { filePath: "a", offset: 1 } },
        { type: "result", title: "write", output: "", metadata: { filePath: "a", bytes: 0 } },
        { type: "result", title: "edit", output: "", metadata: { filePath: "a", replacements: 0, bytes: 0 } },
        { type: "result", title: "patch", output: "", metadata: { added: [], updated: [], deleted: [], moved: [] } },
        { type: "result", title: "glob", output: "", metadata: { pattern: "*", path: ".", count: 0, truncated: false } },
        { type: "result", title: "grep", output: "", metadata: { pattern: "x", path: ".", matches: 0, truncated: false } },
        { type: "result", title: "bash", output: "", outcome: "completed", metadata: { command: "true", workdir: "/home/user/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } },
      ]
      return command(JSON.stringify(events[toolIndex++]) + "\n")
    })
    const provider = new BoxSandboxProvider({ apiBaseUrl: "https://box.test/v1", apiKey: "test-key", polling: { intervalMs: 1, timeoutMs: 20 } }, { clock: new Clock(), fetch, artifact })
    const inputs = [["read", { filePath: "a" }], ["write", { filePath: "a", content: "" }], ["edit", { filePath: "a", oldString: "a", newString: "b" }], ["patch", { patchText: "x" }], ["glob", { pattern: "*" }], ["grep", { pattern: "x" }], ["bash", { command: "true" }]] as const
    for (const [toolName, arguments_] of inputs) { for await (const _event of provider.executeTool({ accountId: "account", providerRef: sandboxRef, toolName, arguments: arguments_, signal: signal() } as never)) {} }
    const ciphertext = Buffer.from("cipher").toString("base64")
    await provider.secureFileTransfer.initiate({ accountId: "account", providerRef: sandboxRef, signal: signal() })
    await provider.secureFileTransfer.consume({ accountId: "account", providerRef: sandboxRef, transferId, targetPath: "secret", ciphertext, signal: signal() })
    await provider.bashJobs.observe({ accountId: "account", providerRef: sandboxRef, jobId: `job_${"a".repeat(32)}`, offset: 0, maxBytes: 2, signal: signal() })
    await provider.bashJobs.cleanup({ accountId: "account", providerRef: sandboxRef, jobId: `job_${"a".repeat(32)}`, signal: signal() })
    const canonicalToolCommand = commands.find(command_ => command_.startsWith("'/usr/local/bin/waterbox' run "))
    expect(canonicalToolCommand).toBeDefined()
    const encodedInvocation = canonicalToolCommand!.match(/^'\/usr\/local\/bin\/waterbox' run '([^']+)'$/)?.[1]
    expect(encodedInvocation).toBeDefined()
    expect(decodeInvocation(encodedInvocation!)).toEqual({ protocolVersion: 2, tool: "read", arguments: { filePath: "a" } })
  })
})
