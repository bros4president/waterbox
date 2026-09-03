import { describe, expect, test } from "bun:test"
import type { Identity, SandboxId } from "@waterbox/contracts"
import { SandboxService } from "@waterbox/core"
import { FixedClock, InMemoryIdempotencyRepository, InMemorySandboxCreationRepository, InMemorySandboxRepository, InMemorySnapshotRepository, SequenceIdGenerator } from "@waterbox/core/test-support"
import { WaterboxSandboxBackend, type SandboxRuntimeArtifact } from "@waterbox/provider-runtime"
import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"
import { VERCEL_RUNTIME_PROFILE, VercelSandboxInfrastructure, VercelSandboxProvider, type VercelProviderClock } from "../src/index.ts"

const signal = () => new AbortController().signal
class Clock implements VercelProviderClock { now(): number { return 0 }; async sleep(_milliseconds: number, value: AbortSignal): Promise<void> { value.throwIfAborted() } }
class AdvancingClock implements VercelProviderClock {
  #now = 0
  now(): number { return this.#now }
  async sleep(milliseconds: number, value: AbortSignal): Promise<void> { value.throwIfAborted(); this.#now += milliseconds }
}
const config = { apiOrigin: "https://vercel.test", token: "test-token", teamId: "team", projectId: "project", polling: { intervalMs: 1, timeoutMs: 10, requestTimeoutMs: 5 } }
const createInput = { accountId: "account", sandboxId: "sbx_calm-river-a1" as never, idempotencyKey: "once", signal: signal() }
const artifactBytes = new TextEncoder().encode("#!/usr/bin/env node\nconsole.log('waterbox')\n")
const artifact: SandboxRuntimeArtifact = { bytes: artifactBytes, sha256: createHash("sha256").update(artifactBytes).digest("hex"), cliProtocolVersion: 2, artifactVersion: "0.1.0" }

function fixture(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => { const request = new Request(input, init); requests.push(request); return handler(request) }
  return { value: new VercelSandboxInfrastructure(config, { fetch, clock: new Clock() }), requests }
}
function sandbox(request: Request, status = "running", session = "session-1") {
  return Response.json({ sandbox: { name: request.url.includes("/v4/") ? undefined : decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!), currentSessionId: session, status, tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: session, projectId: "project" } })
}
function created(name: string, status = "running", session = "session-1") { return Response.json({ sandbox: { name, currentSessionId: session, status, tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: session, projectId: "project" } }) }
function owner() { return "e3ec51d770cb238a91c2aed7" }
function account() { return "9af211329b2fc82e5efe9060" }
function name() { return "waterbox-sbx-calm-river-a1-e3ec51d770cb" }

describe("Vercel primitive REST adapter", () => {
  test("assembles the native primitive through the shared runtime with Vercel-only path mechanics", async () => {
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    const commands: { args: string[]; cwd?: string }[] = []
    let output = 0
    const provider = new VercelSandboxProvider(config, {
      clock: new Clock(),
      artifact,
      fetch: async (input, init) => {
        const request = new Request(input, init), path = new URL(request.url).pathname
        if (request.method === "GET" && path === `/v2/sandboxes/${name()}`) return created(name())
        if (request.method === "POST" && path.endsWith("/fs/write")) return Response.json({ ok: true })
        if (request.method === "POST" && path.endsWith("/cmd")) { const body = await request.json() as { args: string[]; cwd?: string }; commands.push(body); return Response.json({ command: { id: `command-${commands.length}`, sessionId: "session-1", exitCode: null } }) }
        if (request.method === "GET" && /\/cmd\/command-\d+$/.test(path)) return Response.json({ command: { id: path.split("/").at(-1), sessionId: "session-1", exitCode: 0 } })
        if (request.method === "GET" && path.endsWith("/logs")) return new Response(JSON.stringify({ stream: "stdout", data: ["", "waterbox-bootstrap-incomplete\n", "waterbox-bootstrap-installed\n", "waterbox-bootstrap-ok\n"][output++] }) + "\n", { headers: { "content-type": "application/x-ndjson" } })
        throw new Error(`unexpected ${request.method} ${path}`)
      },
    })
    const prepared = await provider.prepareSandbox({ accountId: "account", providerRef, signal: signal() })
    expect(prepared).toMatchObject({ state: "running" })
    expect(VERCEL_RUNTIME_PROFILE.workspacePath).toBe("/workspace")
    expect(VERCEL_RUNTIME_PROFILE.persistentPaths.workspace).toBe("/workspace")
    const scripts = commands.map(command => command.args[1] ?? "")
    expect(commands[0]?.cwd).toBe("/")
    expect(scripts[0]).toContain(`install_bin -d -m 0755 -o "$uid" -g "$gid" '/workspace'`)
    expect(commands.slice(1).every(command => command.cwd === "/workspace")).toBeTrue()
    const installer = scripts.find(script => script.includes("base64 -d > '/workspace/.waterbox/waterbox'"))
    const launcher = Buffer.from(installer?.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > '\/workspace\/\.waterbox\/waterbox'/)?.[1] ?? "", "base64").toString("utf8")
    expect(launcher).toContain("cd '/workspace'")
    expect(scripts.some(script => script.includes("if test \"$uid\" = 0"))).toBeTrue()
    expect(scripts.every(script => !script.includes("Vercel"))).toBeTrue()
  })

  test("validates configuration before a request and persists a named, session-free reference", async () => {
    expect(() => new VercelSandboxInfrastructure({ ...config, apiOrigin: "http://vercel.test" }, { clock: new Clock() })).toThrow("configuration")
    const { value, requests } = fixture(async request => {
      if (request.method === "POST") return created((await request.clone().json() as { name: string }).name)
      throw new Error("unexpected")
    })
    const result = await value.create(createInput)
    expect(result).toMatchObject({ state: "running", providerRef: { kind: "vercel-sandbox-v1", name: name() } })
    expect(JSON.stringify(result.providerRef)).not.toContain("session-1")
    expect(new URL(requests[0]!.url).pathname).toBe("/v4/sandboxes")
    const body = await requests[0]!.json() as Record<string, unknown>
    expect(body).toMatchObject({ name: name(), projectId: "project", persistent: true })
    expect(body).not.toHaveProperty("snapshotExpiration")
    expect(body).not.toHaveProperty("timeout")
    expect(body).not.toHaveProperty("keepLastSnapshots")
  })

  test("sends exact timeout milliseconds only for a configured automatic stop", async () => {
    const requests: Request[] = []
    const value = new VercelSandboxInfrastructure({ ...config, automaticStopMs: 7_200_000 }, {
      clock: new Clock(),
      fetch: async (input, init) => {
        const request = new Request(input, init); requests.push(request)
        return created((await request.clone().json() as { name: string }).name)
      },
    })
    await value.create(createInput)
    const body = await requests[0]!.json() as Record<string, unknown>
    expect(body).toMatchObject({ timeout: 7_200_000 })
    expect(body).not.toHaveProperty("snapshotExpiration")
  })

  test("keeps a longest Friendly Words sandbox ID deterministic and within Vercel's native name bound", async () => {
    const friendlyId = "sbx_quintessential-quintessential-gigantspinosaurus"
    const sandboxId = friendlyId as never
    const idempotencyKey = "friendly-words-longest"
    let body: { name: string; tags: Record<string, string> } | undefined
    const value = new VercelSandboxInfrastructure(config, {
      clock: new Clock(),
      fetch: async (_input, init) => {
        body = await new Request("https://vercel.test", init).json() as { name: string; tags: Record<string, string> }
        return Response.json({ sandbox: { name: body.name, currentSessionId: "session-1", status: "running", tags: body.tags }, session: { id: "session-1", projectId: "project" } })
      },
    })
    await value.create({ accountId: "account", sandboxId, idempotencyKey, signal: signal() })
    const owner = createHash("sha256").update(`account:${sandboxId}:${idempotencyKey}`).digest("hex").slice(0, 24)
    expect(body?.name).toBe(`waterbox-${friendlyId.replace(/[^a-z0-9-]/g, "-").slice(0, 42)}-${owner.slice(0, 12)}`)
    expect(body?.name.length).toBeLessThanOrEqual(64)
  })

  test("reconciles only a response-lost create by exact owned non-resuming name lookup", async () => {
    let posted = 0
    const { value, requests } = fixture(request => {
      if (request.method === "POST") { posted++; throw new TypeError("connection lost") }
      return created(name())
    })
    await expect(value.create(createInput)).resolves.toMatchObject({ providerRef: { name: name() } })
    expect(posted).toBe(1)
    expect(new URL(requests[1]!.url).searchParams.get("resume")).toBe("false")
    const mismatch = fixture(request => request.method === "POST" ? Promise.reject(new TypeError("connection lost")) : Response.json({ sandbox: { name: name(), currentSessionId: "s", status: "running", tags: { "waterbox-owner": "wrong", "waterbox-account": account() } }, session: { id: "s", projectId: "project" } }))
    await expect(mismatch.value.create(createInput)).rejects.toMatchObject({ kind: "ambiguous_execution" })
    const malformed = fixture(() => Response.json({ sandbox: {} }))
    await expect(malformed.value.create(createInput)).rejects.toMatchObject({ kind: "ambiguous_execution" })
    expect(malformed.requests).toHaveLength(1)
  })

  test("uses read-only inspection, correlates terminal commands, and bounds NDJSON logs without retrying command POST", async () => {
    let commands = 0
    const { value, requests } = fixture(request => {
      const path = new URL(request.url).pathname
      if (path === `/v2/sandboxes/${name()}`) return created(name())
      if (path.endsWith("/cmd") && request.method === "POST") { commands++; return Response.json({ command: { id: "command-1", sessionId: "session-1", exitCode: null } }) }
      if (path.endsWith("/cmd/command-1")) return Response.json({ command: { id: "command-1", sessionId: "session-1", exitCode: 0 } })
      if (path.endsWith("/logs")) return new Response(`${JSON.stringify({ stream: "stdout", data: "ok\n" })}\n${JSON.stringify({ stream: "stderr", data: "warn\n" })}\n`, { headers: { "content-type": "application/x-ndjson" } })
      throw new Error(`unexpected ${path}`)
    })
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    await expect(value.inspect({ accountId: "account", providerRef, signal: signal() })).resolves.toMatchObject({ state: "running" })
    let result: Awaited<ReturnType<typeof value.runCommand>> | undefined
    result = await value.runCommand({ accountId: "account", providerRef, script: "printf ok", cwd: "/workspace", environment: { SAFE: "yes" }, timeoutMs: 1000, maxStdoutBytes: 10, maxStderrBytes: 10, signal: signal() })
    expect(result).toEqual({ exitCode: 0, stdout: new TextEncoder().encode("ok\n"), stderr: new TextEncoder().encode("warn\n"), timedOut: false, stdoutTruncated: false, stderrTruncated: false })
    expect(commands).toBe(1)
    const post = requests.find(request => new URL(request.url).pathname.endsWith("/cmd") && request.method === "POST")!
    expect(await post.json()).toEqual({ command: "/bin/sh", args: ["-c", "printf ok"], cwd: "/workspace", env: { SAFE: "yes" }, sudo: false, timeout: 1000 })
    expect(new URL(requests[0]!.url).searchParams.get("resume")).toBe("false")
    expect(new URL(requests.find(request => new URL(request.url).pathname.endsWith("/cmd/command-1"))!.url).searchParams.get("wait")).toBe("true")
  })

  test("contains native automatic-stop transients in bounded non-resuming inspection", async () => {
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    const statuses = ["stopping", "snapshotting", "stopped"] as const
    let reads = 0
    const { value, requests } = fixture(request => created(name(), statuses[Math.min(reads++, statuses.length - 1)], "session-1"))

    await expect(value.inspect({ accountId: "account", providerRef, signal: signal() })).resolves.toEqual({ state: "stopped", providerRef })
    expect(reads).toBe(3)
    expect(requests.every(request => request.method === "GET" && new URL(request.url).searchParams.get("resume") === "false")).toBe(true)

    const failed = fixture(() => created(name(), "failed", "session-1"))
    await expect(failed.value.inspect({ accountId: "account", providerRef, signal: signal() })).resolves.toEqual({ state: "failed", providerRef })
    let absentReads = 0
    const absent = fixture((_request) => ++absentReads === 2 ? Response.json({}, { status: 404 }) : created(name(), "stopping", "session-1"))
    await expect(absent.value.inspect({ accountId: "account", providerRef, signal: signal() })).resolves.toEqual({ state: "terminated", providerRef })
    expect(absent.requests).toHaveLength(2)
    expect(absent.requests.every(request => request.method === "GET" && new URL(request.url).searchParams.get("resume") === "false")).toBe(true)

    const boundedRequests: Request[] = []
    const bounded = new VercelSandboxInfrastructure({ ...config, polling: { intervalMs: 1, timeoutMs: 2, requestTimeoutMs: 1 } }, {
      clock: new AdvancingClock(),
      fetch: async (input, init) => { const request = new Request(input, init); boundedRequests.push(request); return created(name(), "stopping", "session-1") },
    })
    await expect(bounded.inspect({ accountId: "account", providerRef, signal: signal() })).rejects.toMatchObject({ kind: "failure", message: "Vercel sandbox inspection did not reach a stable state" })
    expect(boundedRequests).toHaveLength(3)
    expect(boundedRequests.every(request => request.method === "GET" && new URL(request.url).searchParams.get("resume") === "false")).toBe(true)
  })

  test("carries automatic stopping through exact stopped observation before one ordinary-tool resume", async () => {
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    const automaticStatuses = ["stopping", "snapshotting", "stopped"] as const
    const requests: Request[] = []
    let automaticRead = 0
    const provider = new VercelSandboxProvider(config, {
      clock: new Clock(),
      artifact,
      fetch: async (input, init) => {
        const request = new Request(input, init), url = new URL(request.url), path = url.pathname
        requests.push(request)
        if (request.method === "GET" && path === `/v2/sandboxes/${name()}`) {
          if (url.searchParams.get("resume") === "true") return created(name(), "running", "session-2")
          if (automaticRead < automaticStatuses.length) return created(name(), automaticStatuses[automaticRead++]!, "session-1")
          return created(name(), "running", "session-2")
        }
        if (request.method === "POST" && path.endsWith("/cmd")) return Response.json({ command: { id: "command-user", sessionId: "session-2", exitCode: null } })
        if (request.method === "GET" && path.endsWith("/cmd/command-user")) return Response.json({ command: { id: "command-user", sessionId: "session-2", exitCode: 0 } })
        if (request.method === "GET" && path.endsWith("/cmd/command-user/logs")) {
          const event = { type: "result", title: "complete", output: "ok", metadata: { filePath: "marker.txt", type: "text", offset: 1, lines: 1, totalLines: 1 } }
          return new Response(`${JSON.stringify({ stream: "stdout", data: `${JSON.stringify(event)}\n` })}\n`, { headers: { "content-type": "application/x-ndjson" } })
        }
        throw new Error(`unexpected ${request.method} ${path}`)
      },
    })
    const sandboxes = new InMemorySandboxRepository(), snapshots = new InMemorySnapshotRepository(), idempotency = new InMemoryIdempotencyRepository()
    const identity: Identity = { accountId: "account" }
    const sandboxId = "sbx_calm-river-a1" as SandboxId
    await sandboxes.createIfAbsent({ accountId: identity.accountId, sandboxId, provider: provider.name, providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", providerRef, state: "running", version: 1, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" })
    const service = new SandboxService({ sandboxes, snapshots, idempotency, sandboxCreations: new InMemorySandboxCreationRepository(sandboxes, idempotency), providers: new Map([[provider.name, provider]]), defaultProvider: provider.name, providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", clock: new FixedClock(), ids: new SequenceIdGenerator() })

    await expect(service.probeSandbox(identity, sandboxId)).resolves.toMatchObject({ state: "stopped" })
    expect((await sandboxes.get(identity.accountId, sandboxId))?.state).toBe("stopped")
    const inspectionRequests = requests.slice()
    expect(inspectionRequests).toHaveLength(3)
    expect(inspectionRequests.every(request => request.method === "GET" && new URL(request.url).searchParams.get("resume") === "false")).toBe(true)

    const events = []
    for await (const event of await service.executeTool(identity, sandboxId, "read", { filePath: "marker.txt" })) events.push(event)
    expect(events).toHaveLength(1)
    expect((await sandboxes.get(identity.accountId, sandboxId))?.state).toBe("running")
    expect(requests.filter(request => request.method === "GET" && new URL(request.url).searchParams.get("resume") === "true")).toHaveLength(1)
    expect(requests.filter(request => request.method === "POST" && new URL(request.url).pathname.endsWith("/cmd"))).toHaveLength(1)
  })

  test("accepts command logs only at exact v2 status 200", async () => {
    let commands = 0
    const { value } = fixture(request => {
      const path = new URL(request.url).pathname
      if (path === `/v2/sandboxes/${name()}`) return created(name())
      if (path.endsWith("/cmd") && request.method === "POST") { commands++; return Response.json({ command: { id: "command-206", sessionId: "session-1", exitCode: null } }) }
      if (path.endsWith("/cmd/command-206")) return Response.json({ command: { id: "command-206", sessionId: "session-1", exitCode: 0 } })
      if (path.endsWith("/logs")) return new Response(`${JSON.stringify({ stream: "stdout", data: "partial" })}\n`, { status: 206, headers: { "content-type": "application/x-ndjson" } })
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    await expect(value.runCommand({ accountId: "account", providerRef, script: "true", timeoutMs: 1000, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    expect(commands).toBe(1)
  })

  test("surfaces a definite cwd rejection after exactly one unchanged command POST", async () => {
    const requests: Request[] = []
    const { value } = fixture(async request => {
      requests.push(request)
      const path = new URL(request.url).pathname
      if (path === `/v2/sandboxes/${name()}`) return created(name())
      if (path.endsWith("/cmd") && request.method === "POST") return Response.json({}, { status: 400 })
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    await expect(value.runCommand({ accountId: "account", providerRef, script: "true", cwd: "/workspace", timeoutMs: 1000, signal: signal() })).rejects.toMatchObject({ kind: "failure" })
    const commands = requests.filter(request => request.method === "POST" && new URL(request.url).pathname.endsWith("/cmd"))
    expect(commands).toHaveLength(1)
    expect(await commands[0]!.clone().json()).toMatchObject({ cwd: "/workspace" })
  })

  test("never replays dispatched Vercel mutations when their acknowledgements are unprovable", async () => {
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    const snapshotProviderRef = { kind: "vercel-snapshot-v1", id: "snapshot-mutation", owner: owner(), sourceName: name() } as const
    type Operation = "create" | "command" | "write" | "stop" | "resume" | "delete" | "snapshot-create" | "snapshot-delete"
    const operations: readonly Operation[] = ["create", "command", "write", "stop", "resume", "delete", "snapshot-create", "snapshot-delete"]
    const invoke = (operation: Operation, value: VercelSandboxInfrastructure, operationSignal: AbortSignal) => {
      switch (operation) {
        case "create": return value.create({ ...createInput, signal: operationSignal })
        case "command": return value.runCommand({ accountId: "account", providerRef, script: "true", timeoutMs: 1000, signal: operationSignal })
        case "write": return value.writeFile({ accountId: "account", providerRef, path: "/tmp/a", contents: new Uint8Array(), signal: operationSignal })
        case "stop": return value.stopResume.stop({ accountId: "account", providerRef, signal: operationSignal })
        case "resume": return value.stopResume.resume({ accountId: "account", providerRef, signal: operationSignal })
        case "delete": return value.delete({ accountId: "account", providerRef, signal: operationSignal })
        case "snapshot-create": return value.snapshots.create({ accountId: "account", snapshotId: "snap_calm-river-a4" as never, providerRef, expectedState: "running", signal: operationSignal })
        case "snapshot-delete": return value.snapshots.delete({ accountId: "account", snapshotId: "snap_calm-river-a4" as never, providerRef: snapshotProviderRef, signal: operationSignal })
      }
    }
    const isMutation = (operation: Operation, request: Request) => {
      const path = new URL(request.url).pathname
      return operation === "create" ? request.method === "POST" && path === "/v4/sandboxes"
        : operation === "command" ? request.method === "POST" && path.endsWith("/cmd")
        : operation === "write" ? request.method === "POST" && path.endsWith("/fs/write")
        : operation === "stop" ? request.method === "POST" && path.endsWith("/stop")
        : operation === "resume" ? request.method === "GET" && path === `/v2/sandboxes/${name()}` && new URL(request.url).searchParams.get("resume") === "true"
        : operation === "delete" ? request.method === "DELETE" && path === `/v2/sandboxes/${name()}`
        : operation === "snapshot-create" ? request.method === "POST" && path.endsWith("/snapshot")
        : request.method === "DELETE" && path.endsWith("/snapshots/snapshot-mutation")
    }
    const baseline = (request: Request) => {
      const path = new URL(request.url).pathname
      if (path === `/v2/sandboxes/${name()}`) return created(name())
      if (path.endsWith("/snapshots/snapshot-mutation")) return Response.json({ id: "snapshot-mutation", sourceSessionId: "session-1", status: "created" })
      throw new Error(`unexpected baseline ${request.method} ${path}`)
    }
    const cases: readonly [string, (controller: AbortController) => Response | Promise<Response>][] = [
      ["lost response", () => Promise.reject(new TypeError("response lost after dispatch"))],
      ["server failure", () => Response.json({ error: "internal" }, { status: 500 })],
      ["malformed acknowledgement", () => Response.json({})],
      ["unexpected successful status", () => Response.json({}, { status: 204 })],
      ["caller abort racing loss", controller => { controller.abort(new DOMException("caller left", "AbortError")); return Promise.reject(new TypeError("response lost after dispatch")) }],
    ]
    for (const operation of operations) {
      for (const [caseName, response] of cases) {
        // File-write and sandbox-delete acknowledgements are bodyless; a
        // syntactically empty exact-status 200 is therefore not malformed.
        if ((operation === "write" || operation === "delete") && caseName === "malformed acknowledgement") continue
        let dispatched = 0
        const controller = new AbortController()
        const { value } = fixture(request => {
          if (isMutation(operation, request)) { dispatched++; return response(controller) }
          return baseline(request)
        })
        // Vercel create is the one intentional exception: a transport-lost
        // create may be resolved by an exact owned-name read. Here the abort
        // case cannot safely complete that read, and every other case remains
        // unprovable without a mutation replay.
        if (operation === "create" && caseName === "lost response") {
          await expect(invoke(operation, value, controller.signal)).resolves.toMatchObject({ providerRef: { name: name() } })
        } else {
          await expect(invoke(operation, value, controller.signal)).rejects.toMatchObject({ kind: "ambiguous_execution" })
        }
        expect(dispatched, `${operation}: ${caseName}`).toBe(1)
      }
    }
  })

  test("uploads exact gzip-tar bytes/mode and keeps session replacement internal", async () => {
    const { value, requests } = fixture(async request => {
      const path = new URL(request.url).pathname
      if (path === `/v2/sandboxes/${name()}`) return created(name(), request.url.includes("resume=true") ? "running" : "running", request.url.includes("resume=true") ? "session-2" : "session-1")
      if (path.endsWith("/fs/write")) return Response.json({ ok: true })
      if (path.endsWith("/stop")) return Response.json({ session: { id: "session-1", status: "stopped" }, snapshot: { id: "auto-1", sourceSessionId: "session-1", status: "created" } })
      throw new Error(`unexpected ${path}`)
    })
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    const bytes = Uint8Array.from([0, 1, 255, 4])
    await value.writeFile({ accountId: "account", providerRef, path: "/tmp/file.bin", contents: bytes, mode: 0o640, signal: signal() })
    const upload = requests.find(request => new URL(request.url).pathname.endsWith("/fs/write"))!
    const tar = new Uint8Array(gunzipSync(await upload.arrayBuffer())), header = tar.subarray(0, 512)
    expect(new TextDecoder().decode(header.subarray(0, 12)).replace(/\0.*$/, "")).toBe("tmp/file.bin")
    expect(Number.parseInt(new TextDecoder().decode(header.subarray(100, 108)).replace(/\0.*$/, "").trim(), 8)).toBe(0o640)
    expect(tar.slice(512, 516)).toEqual(bytes)
    const stopped = await value.stopResume.stop({ accountId: "account", providerRef, signal: signal() })
    expect(stopped.providerRef).toMatchObject({ automaticSnapshotId: "auto-1" })
    const resumed = await value.stopResume.resume({ accountId: "account", providerRef: stopped.providerRef, signal: signal() })
    expect(JSON.stringify(resumed.providerRef)).not.toContain("session-2")
    expect(new URL(requests.at(-1)!.url).searchParams.get("resume")).toBe("true")
  })

  test("requires a running source, uses v3 snapshots, accepts tombstones, and makes every lost mutation ambiguous", async () => {
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    let snapshotRequests = 0
    const requests: string[] = [], { value } = fixture(request => {
      const path = new URL(request.url).pathname
      requests.push(path)
      if (path === `/v2/sandboxes/${name()}`) return created(name())
      if (path.endsWith("/snapshot") && request.method === "POST") { snapshotRequests++; return Response.json({ session: { id: "session-1", status: "snapshotting" }, snapshot: { id: "snapshot-1", sourceSessionId: "session-1", status: "created" } }, { status: 201 }) }
      if (path.endsWith("/snapshots/snapshot-1")) return Response.json({ id: "snapshot-1", sourceSessionId: "session-1", status: "deleted" })
      throw new Error(`unexpected ${path}`)
    })
    let snapCreated: Awaited<ReturnType<NonNullable<typeof value.snapshots>["create"]>>
    try { snapCreated = await value.snapshots.create({ accountId: "account", snapshotId: "snap_calm-river-a1" as never, providerRef, expectedState: "running", signal: signal() }) } catch (error) { throw new Error(`${error instanceof Error ? error.message : error}: ${requests.join(",")}`) }
    expect(snapCreated).toMatchObject({ state: "ready", providerRef: { id: "snapshot-1" } })
    await expect(value.snapshots.inspect({ accountId: "account", snapshotId: "snap_calm-river-a1" as never, providerRef: snapCreated.providerRef, signal: signal() })).resolves.toMatchObject({ state: "deleted" })
    expect(snapshotRequests).toBe(1)
    const lost = fixture(request => new URL(request.url).pathname === `/v2/sandboxes/${name()}` ? created(name()) : Promise.reject(new TypeError("lost after dispatch"))).value
    await expect(lost.runCommand({ accountId: "account", providerRef, script: "true", timeoutMs: 1000, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    await expect(lost.writeFile({ accountId: "account", providerRef, path: "/tmp/a", contents: new Uint8Array(), signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    await expect(lost.stopResume.stop({ accountId: "account", providerRef, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("reconciles a manual snapshot source through non-resuming transient reads and returns its exact stopped observation", async () => {
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    let reads = 0; const requests: Request[] = []
    const { value } = fixture(request => {
      requests.push(request); const path = new URL(request.url).pathname
      if (path === `/v2/sandboxes/${name()}`) {
        reads++
        const status = reads === 1 ? "running" : reads === 2 ? "snapshotting" : "stopped"
        return created(name(), status, "session-1")
      }
      if (path.endsWith("/snapshot")) return Response.json({ session: { id: "session-1", status: "snapshotting" }, snapshot: { id: "manual-2", sourceSessionId: "session-1", status: "created" } }, { status: 201 })
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    const result = await value.snapshots.create({ accountId: "account", snapshotId: "snap_calm-river-a2" as never, providerRef, expectedState: "running", signal: signal() })
    expect(result.sourceSandbox).toMatchObject({ state: "stopped", providerRef })
    const sourceReads = requests.filter(request => new URL(request.url).pathname === `/v2/sandboxes/${name()}`)
    expect(sourceReads).toHaveLength(3)
    expect(sourceReads.every(request => new URL(request.url).searchParams.get("resume") === "false")).toBe(true)
  })

  test("carries Vercel's stopped snapshot source through the shared backend into durable service state", async () => {
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    let reads = 0
    const { value } = fixture(request => {
      const path = new URL(request.url).pathname
      if (path === `/v2/sandboxes/${name()}`) return created(name(), ++reads < 3 ? "running" : "stopped", "session-1")
      if (path.endsWith("/snapshot")) return Response.json({ session: { id: "session-1", status: "snapshotting" }, snapshot: { id: "cross-layer-snapshot", sourceSessionId: "session-1", status: "created" } }, { status: 201 })
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    const provider = new WaterboxSandboxBackend(value, { artifact })
    const sandboxes = new InMemorySandboxRepository(), snapshots = new InMemorySnapshotRepository(), idempotency = new InMemoryIdempotencyRepository()
    const identity: Identity = { accountId: "account" }
    const sandboxId = "sbx_calm-river-a1" as SandboxId
    await sandboxes.createIfAbsent({ accountId: identity.accountId, sandboxId, provider: provider.name, providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", providerRef, state: "running", version: 1, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" })
    const service = new SandboxService({ sandboxes, snapshots, idempotency, sandboxCreations: new InMemorySandboxCreationRepository(sandboxes, idempotency), providers: new Map([[provider.name, provider]]), defaultProvider: provider.name, providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", clock: new FixedClock(), ids: new SequenceIdGenerator([], ["snap_calm-river-a5"]) })

    const snapshot = await service.createSnapshot(identity, sandboxId, {})

    expect(snapshot.state).toBe("ready")
    expect((await snapshots.get(identity.accountId, snapshot.snapshotId))?.state).toBe("ready")
    expect((await sandboxes.get(identity.accountId, sandboxId))?.state).toBe("stopped")
    expect((await service.getSandbox(identity, sandboxId)).state).toBe("stopped")
  })

  test("explicit resume polls replacement-session transients without a second resume request", async () => {
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    let reads = 0; const requests: Request[] = []
    const { value } = fixture(request => { requests.push(request); const path = new URL(request.url).pathname; if (path === `/v2/sandboxes/${name()}`) return created(name(), ++reads === 1 ? "pending" : "running", "session-2"); throw new Error(`unexpected ${path}`) })
    await expect(value.stopResume.resume({ accountId: "account", providerRef, signal: signal() })).resolves.toMatchObject({ state: "running", providerRef })
    const readsByResume = requests.filter(request => new URL(request.url).pathname === `/v2/sandboxes/${name()}`)
    expect(readsByResume.map(request => new URL(request.url).searchParams.get("resume"))).toEqual(["true", "false"])
  })

  test("distinguishes definite resume rejection from polling failures after acceptance", async () => {
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    for (const status of [400, 429]) {
      const rejected = fixture(() => Response.json({}, { status }))
      await expect(rejected.value.stopResume.resume({ accountId: "account", providerRef, signal: signal() }), `pre-dispatch ${status}`).rejects.toMatchObject({ kind: status === 429 ? "limit" : "failure" })
      expect(rejected.requests, `pre-dispatch ${status}`).toHaveLength(1)

      const accepted = fixture(request => new URL(request.url).searchParams.get("resume") === "true"
        ? created(name(), "pending", "session-2")
        : Response.json({}, { status }))
      await expect(accepted.value.stopResume.resume({ accountId: "account", providerRef, signal: signal() }), `post-dispatch ${status}`).rejects.toMatchObject({ kind: "ambiguous_execution" })
      expect(accepted.requests.map(request => new URL(request.url).searchParams.get("resume")), `post-dispatch ${status}`).toEqual(["true", "false"])
    }

    const terminalFailure = fixture(request => new URL(request.url).searchParams.get("resume") === "true"
      ? created(name(), "pending", "session-2")
      : created(name(), "failed", "session-2"))
    await expect(terminalFailure.value.stopResume.resume({ accountId: "account", providerRef, signal: signal() })).rejects.toMatchObject({ kind: "known_state", knownObservation: { resource: "sandbox", observation: { state: "failed", providerRef } } })

    const terminalAbsence = fixture(request => new URL(request.url).searchParams.get("resume") === "true"
      ? created(name(), "pending", "session-2")
      : Response.json({}, { status: 404 }))
    await expect(terminalAbsence.value.stopResume.resume({ accountId: "account", providerRef, signal: signal() })).rejects.toMatchObject({ kind: "exact_absence", knownObservation: { resource: "sandbox", observation: { state: "terminated", providerRef } } })
  })

  test("retains resuming after an accepted resume hits a polling rejection without redispatch", async () => {
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    let resumeDispatches = 0
    let reads = 0
    const { value } = fixture(request => {
      const url = new URL(request.url)
      if (url.pathname !== `/v2/sandboxes/${name()}`) throw new Error(`unexpected ${request.method} ${url.pathname}`)
      if (url.searchParams.get("resume") === "true") {
        resumeDispatches++
        return created(name(), "pending", "session-2")
      }
      reads++
      return reads === 1 ? Response.json({}, { status: 429 }) : created(name(), "stopped", "session-2")
    })
    const provider = new WaterboxSandboxBackend(value, { artifact })
    const sandboxes = new InMemorySandboxRepository(), snapshots = new InMemorySnapshotRepository(), idempotency = new InMemoryIdempotencyRepository()
    const identity: Identity = { accountId: "account" }
    const sandboxId = "sbx_calm-river-a1" as SandboxId
    await sandboxes.createIfAbsent({ accountId: identity.accountId, sandboxId, provider: provider.name, providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", providerRef, state: "stopped", version: 1, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" })
    const service = new SandboxService({ sandboxes, snapshots, idempotency, sandboxCreations: new InMemorySandboxCreationRepository(sandboxes, idempotency), providers: new Map([[provider.name, provider]]), defaultProvider: provider.name, providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", clock: new FixedClock(), ids: new SequenceIdGenerator() })

    await expect(service.resumeSandbox(identity, sandboxId)).rejects.toMatchObject({ code: "ambiguous_execution" })
    expect((await sandboxes.get(identity.accountId, sandboxId))?.state).toBe("resuming")
    expect((await service.getSandbox(identity, sandboxId)).state).toBe("resuming")
    expect(resumeDispatches).toBe(1)
  })

  test("reconciles a 409 snapshot delete only through an exact deleted tombstone read", async () => {
    const ref = { kind: "vercel-snapshot-v1", id: "snapshot-tombstone", owner: owner(), sourceName: name() } as const
    let reads = 0, deletes = 0
    const { value } = fixture(request => { const path = new URL(request.url).pathname; if (path.endsWith("/snapshots/snapshot-tombstone") && request.method === "GET") return Response.json({ id: "snapshot-tombstone", sourceSessionId: "session-1", status: ++reads === 1 ? "created" : "deleted" }); if (path.endsWith("/snapshots/snapshot-tombstone") && request.method === "DELETE") { deletes++; return Response.json({}, { status: 409 }) }; throw new Error(`unexpected ${path}`) })
    await expect(value.snapshots.delete({ accountId: "account", snapshotId: "snap_calm-river-a3" as never, providerRef: ref, signal: signal() })).resolves.toMatchObject({ state: "deleted" })
    expect(deletes).toBe(1)
  })

  test("deletes only an ownership-proven tracked automatic snapshot before its sandbox, never an explicit snapshot", async () => {
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account(), automaticSnapshotId: "auto-old" } as const
    const paths: string[] = []
    const { value } = fixture(request => {
      const path = new URL(request.url).pathname; paths.push(`${request.method} ${path}`)
      if (path === `/v2/sandboxes/${name()}` && request.method === "GET") {
        if (paths.filter(item => item === `GET ${path}`).length > 1) return Response.json({}, { status: 404 })
        return Response.json({ sandbox: { name: name(), currentSessionId: "session-new", currentSnapshotId: "auto-old", status: "stopped", tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: "session-new", projectId: "project" } })
      }
      if (path.endsWith("/snapshots/auto-old") && request.method === "GET") return Response.json({ id: "auto-old", sourceSessionId: "session-old", sourceSandboxName: name(), creationMethod: "automatic", tags: { "waterbox-owner": owner(), "waterbox-account": account() }, status: "created" })
      if (path.endsWith("/snapshots/auto-old") && request.method === "DELETE") return Response.json({ snapshot: { id: "auto-old", sourceSessionId: "session-old", status: "deleted" } })
      if (path === `/v2/sandboxes/${name()}` && request.method === "DELETE") return Response.json({ ok: true })
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    await expect(value.delete({ accountId: "account", providerRef, signal: signal() })).resolves.toMatchObject({ state: "terminated" })
    expect(paths.indexOf("DELETE /v2/sandboxes/snapshots/auto-old")).toBeLessThan(paths.indexOf(`DELETE /v2/sandboxes/${name()}`))
    expect(paths.some(path => path.includes("explicit-snapshot"))).toBe(false)
    let noProofReads = 0
    const noProof = fixture(request => {
      const path = new URL(request.url).pathname
      if (path === `/v2/sandboxes/${name()}` && request.method === "GET") return ++noProofReads === 1 ? Response.json({ sandbox: { name: name(), currentSessionId: "session-new", status: "stopped", tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: "session-new", projectId: "project" } }) : Response.json({}, { status: 404 })
      if (path.endsWith("/snapshots/auto-old")) return Response.json({ id: "auto-old", sourceSessionId: "session-old", sourceSandboxName: name(), creationMethod: "automatic", tags: { "waterbox-owner": owner(), "waterbox-account": account() }, status: "created" })
      if (path === `/v2/sandboxes/${name()}` && request.method === "DELETE") return Response.json({ ok: true })
      return Response.json({}, { status: 404 })
    })
    await expect(noProof.value.delete({ accountId: "account", providerRef, signal: signal() })).resolves.toMatchObject({ state: "terminated" })
    const explicitPaths: string[] = []; let explicitReads = 0
    const explicitCurrent = fixture(request => {
      const path = new URL(request.url).pathname; explicitPaths.push(`${request.method} ${path}`)
      if (path === `/v2/sandboxes/${name()}` && request.method === "GET") return ++explicitReads === 1 ? Response.json({ sandbox: { name: name(), currentSessionId: "session-new", currentSnapshotId: "auto-old", status: "stopped", tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: "session-new", projectId: "project" } }) : Response.json({}, { status: 404 })
      if (path.endsWith("/snapshots/auto-old") && request.method === "GET") return Response.json({ id: "auto-old", sourceSessionId: "session-old", sourceSandboxName: name(), creationMethod: "manual", tags: { "waterbox-owner": owner(), "waterbox-account": account() }, status: "created" })
      if (path === `/v2/sandboxes/${name()}` && request.method === "DELETE") return Response.json({ ok: true })
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    await expect(explicitCurrent.value.delete({ accountId: "account", providerRef, signal: signal() })).resolves.toMatchObject({ state: "terminated" })
    expect(explicitPaths).not.toContain("DELETE /v2/sandboxes/snapshots/auto-old")
    const cleanupPaths: string[] = []
    const cleanupLost = fixture(request => {
      const path = new URL(request.url).pathname; cleanupPaths.push(`${request.method} ${path}`)
      if (path === `/v2/sandboxes/${name()}`) return Response.json({ sandbox: { name: name(), currentSessionId: "session-new", currentSnapshotId: "auto-old", status: "stopped", tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: "session-new", projectId: "project" } })
      if (path.endsWith("/snapshots/auto-old") && request.method === "GET") return Response.json({ id: "auto-old", sourceSessionId: "session-old", sourceSandboxName: name(), creationMethod: "automatic", tags: { "waterbox-owner": owner(), "waterbox-account": account() }, status: "created" })
      if (path.endsWith("/snapshots/auto-old") && request.method === "DELETE") throw new TypeError("response lost after cleanup dispatch")
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    await expect(cleanupLost.value.delete({ accountId: "account", providerRef, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    expect(cleanupPaths).not.toContain(`DELETE /v2/sandboxes/${name()}`)
    const controller = new AbortController()
    const cleanupAbort = fixture(request => {
      const path = new URL(request.url).pathname
      if (path === `/v2/sandboxes/${name()}`) return Response.json({ sandbox: { name: name(), currentSessionId: "session-new", currentSnapshotId: "auto-old", status: "stopped", tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: "session-new", projectId: "project" } })
      if (path.endsWith("/snapshots/auto-old") && request.method === "GET") return Response.json({ id: "auto-old", sourceSessionId: "session-old", sourceSandboxName: name(), creationMethod: "automatic", tags: { "waterbox-owner": owner(), "waterbox-account": account() }, status: "created" })
      if (path.endsWith("/snapshots/auto-old") && request.method === "DELETE") { controller.abort(new DOMException("caller left", "AbortError")); throw new TypeError("response lost after cleanup dispatch") }
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    await expect(cleanupAbort.value.delete({ accountId: "account", providerRef, signal: controller.signal })).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("finds an unpersisted current automatic snapshot through the exact owned sandbox only", async () => {
    const paths: string[] = []; const captured: { deleteContentType: string | null } = { deleteContentType: null }; let reads = 0
    const { value } = fixture(request => {
      const path = new URL(request.url).pathname; paths.push(`${request.method} ${path}`)
      if (path === `/v2/sandboxes/${name()}` && request.method === "GET") return ++reads === 1
        ? Response.json({ sandbox: { name: name(), currentSessionId: "session-1", currentSnapshotId: "auto-current", status: "stopped", tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: "session-1", projectId: "project" } })
        : Response.json({}, { status: 404 })
      if (path.endsWith("/snapshots/auto-current") && request.method === "GET") return Response.json({ id: "auto-current", sourceSessionId: "session-1", creationMethod: "automatic", status: "created" })
      if (path.endsWith("/snapshots/auto-current") && request.method === "DELETE") return Response.json({ snapshot: { id: "auto-current", sourceSessionId: "session-1", status: "deleted" } })
      if (path === `/v2/sandboxes/${name()}` && request.method === "DELETE") { captured.deleteContentType = request.headers.get("content-type"); return new Response(null, { status: 200 }) }
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    await expect(value.delete({ accountId: "account", providerRef, signal: signal() })).resolves.toMatchObject({ state: "terminated" })
    expect(paths).toContain("DELETE /v2/sandboxes/snapshots/auto-current")
    expect(paths).toContain(`DELETE /v2/sandboxes/${name()}`)
    expect(captured.deleteContentType).toBe("application/json")
  })

  test("uses the exact current automatic snapshot instead of a stale persisted reference", async () => {
    const paths: string[] = []; let reads = 0
    const { value } = fixture(request => {
      const path = new URL(request.url).pathname; paths.push(`${request.method} ${path}`)
      if (path === `/v2/sandboxes/${name()}` && request.method === "GET") return ++reads === 1
        ? Response.json({ sandbox: { name: name(), currentSessionId: "session-2", currentSnapshotId: "auto-new", status: "stopped", tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: "session-2", projectId: "project" } })
        : Response.json({}, { status: 404 })
      if (path.endsWith("/snapshots/auto-new") && request.method === "GET") return Response.json({ id: "auto-new", sourceSessionId: "session-2", creationMethod: "automatic", status: "created" })
      if (path.endsWith("/snapshots/auto-new") && request.method === "DELETE") return Response.json({ snapshot: { id: "auto-new", sourceSessionId: "session-2", status: "deleted" } })
      if (path === `/v2/sandboxes/${name()}` && request.method === "DELETE") return new Response(null, { status: 200 })
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account(), automaticSnapshotId: "auto-old" } as const
    await expect(value.delete({ accountId: "account", providerRef, signal: signal() })).resolves.toMatchObject({ state: "terminated" })
    expect(paths).toContain("DELETE /v2/sandboxes/snapshots/auto-new")
    expect(paths.some(path => path.includes("auto-old"))).toBe(false)
  })

  test("uses the owned sandbox current-snapshot link when Vercel automatic snapshots omit copied tags/names, and reconciles tombstone races without DELETE replay", async () => {
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account(), automaticSnapshotId: "auto-old" } as const
    const liveShapePaths: string[] = []; let liveShapeReads = 0
    const liveShape = fixture(request => {
      const path = new URL(request.url).pathname; liveShapePaths.push(`${request.method} ${path}`)
      if (path === `/v2/sandboxes/${name()}` && request.method === "GET") return ++liveShapeReads === 1
        ? Response.json({ sandbox: { name: name(), currentSessionId: "session-new", currentSnapshotId: "auto-old", status: "stopped", tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: "session-new", projectId: "project" } })
        : Response.json({}, { status: 404 })
      if (path.endsWith("/snapshots/auto-old") && request.method === "GET") return Response.json({ id: "auto-old", sourceSessionId: "session-old", creationMethod: "automatic", status: "created" })
      if (path.endsWith("/snapshots/auto-old") && request.method === "DELETE") return Response.json({ snapshot: { id: "auto-old", sourceSessionId: "session-old", status: "deleted" } })
      if (path === `/v2/sandboxes/${name()}` && request.method === "DELETE") return Response.json({ ok: true })
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    await expect(liveShape.value.delete({ accountId: "account", providerRef, signal: signal() })).resolves.toMatchObject({ state: "terminated" })
    expect(liveShapePaths.indexOf("DELETE /v2/sandboxes/snapshots/auto-old")).toBeLessThan(liveShapePaths.indexOf(`DELETE /v2/sandboxes/${name()}`))

    for (const status of [400, 409]) {
      const paths: string[] = []; let sandboxReads = 0, snapshotReads = 0, snapshotDeletes = 0
      const { value } = fixture(request => {
        const path = new URL(request.url).pathname; paths.push(`${request.method} ${path}`)
        if (path === `/v2/sandboxes/${name()}` && request.method === "GET") return ++sandboxReads === 1
          ? Response.json({ sandbox: { name: name(), currentSessionId: "session-new", currentSnapshotId: "auto-old", status: "stopped", tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: "session-new", projectId: "project" } })
          : Response.json({}, { status: 404 })
        if (path.endsWith("/snapshots/auto-old") && request.method === "GET") return Response.json({ id: "auto-old", sourceSessionId: "session-old", creationMethod: "automatic", sourceSandboxName: name(), tags: { "waterbox-owner": owner(), "waterbox-account": account() }, status: ++snapshotReads === 1 ? "created" : "deleted" })
        if (path.endsWith("/snapshots/auto-old") && request.method === "DELETE") { snapshotDeletes++; return Response.json({}, { status }) }
        if (path === `/v2/sandboxes/${name()}` && request.method === "DELETE") return Response.json({ ok: true })
        throw new Error(`unexpected ${request.method} ${path}`)
      })
      await expect(value.delete({ accountId: "account", providerRef, signal: signal() }), `delete cleanup ${status}`).resolves.toMatchObject({ state: "terminated" })
      expect(snapshotDeletes, `delete cleanup ${status}`).toBe(1)
      expect(paths.filter(path => path === "DELETE /v2/sandboxes/snapshots/auto-old"), `delete cleanup ${status}`).toHaveLength(1)
    }

    for (const status of [400, 409]) {
      const paths: string[] = []; let phase: "running" | "stopped" = "running", snapshotReads = 0, snapshotDeletes = 0
      const { value } = fixture(request => {
        const path = new URL(request.url).pathname; paths.push(`${request.method} ${path}`)
        if (path === `/v2/sandboxes/${name()}` && request.method === "GET") return phase === "running"
          ? created(name(), "running", "session-1")
          : Response.json({ sandbox: { name: name(), currentSessionId: "session-2", currentSnapshotId: "auto-new", status: "stopped", tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: "session-2", projectId: "project" } })
        if (path.endsWith("/sessions/session-1/stop")) { phase = "stopped"; return Response.json({ session: { id: "session-1", status: "stopped" }, snapshot: { id: "auto-new", sourceSessionId: "session-1", status: "created" } }) }
        if (path.endsWith("/snapshots/auto-old") && request.method === "GET") return Response.json({ id: "auto-old", sourceSessionId: "session-old", creationMethod: "automatic", sourceSandboxName: name(), tags: { "waterbox-owner": owner(), "waterbox-account": account() }, status: ++snapshotReads === 1 ? "created" : "deleted" })
        if (path.endsWith("/snapshots/auto-old") && request.method === "DELETE") { snapshotDeletes++; return Response.json({}, { status }) }
        throw new Error(`unexpected ${request.method} ${path}`)
      })
      await expect(value.stopResume.stop({ accountId: "account", providerRef, signal: signal() }), `superseded cleanup ${status}`).resolves.toMatchObject({ state: "stopped", providerRef: { automaticSnapshotId: "auto-new" } })
      expect(snapshotDeletes, `superseded cleanup ${status}`).toBe(1)
      expect(paths.filter(path => path === "DELETE /v2/sandboxes/snapshots/auto-old"), `superseded cleanup ${status}`).toHaveLength(1)
    }
  })

  test("uses bounded project-scoped pagination and exposes only account-owned inventory", async () => {
    const { value, requests } = fixture(request => {
      const url = new URL(request.url), cursor = url.searchParams.get("cursor"), path = url.pathname
      if (path === "/v2/sandboxes") return Response.json({ sandboxes: cursor ? [{ name: name(), currentSessionId: "session-1", status: "stopped", tags: { "waterbox-owner": owner(), "waterbox-account": account() } }] : [{ name: "other", currentSessionId: "other-session", status: "running", tags: { "waterbox-owner": "other", "waterbox-account": "other" } }], pagination: { count: 2, next: cursor ? null : "page-2" } })
      if (path === "/v2/sandboxes/snapshots") return Response.json({ snapshots: [{ id: "owned-snapshot", sourceSessionId: "session-1", sourceSandboxName: name(), creationMethod: "manual", tags: { "waterbox-owner": owner(), "waterbox-account": account() }, status: "created" }, { id: "auto-snapshot", sourceSessionId: "session-1", sourceSandboxName: name(), creationMethod: "automatic", tags: { "waterbox-owner": owner(), "waterbox-account": account() }, status: "created" }, { id: "other-snapshot", sourceSessionId: "other-session", status: "created" }], pagination: { count: 3, next: null } })
      throw new Error(`unexpected ${path}`)
    })
    const sandboxes = []
    for await (const item of value.inventory.listSandboxes({ accountId: "account", pageSize: 2, signal: signal() })) sandboxes.push(item)
    const snapshots = []
    for await (const item of value.inventory.listSnapshots({ accountId: "account", pageSize: 2, signal: signal() })) snapshots.push(item)
    expect(sandboxes).toHaveLength(1); expect(snapshots).toEqual([expect.objectContaining({ state: "ready", providerRef: expect.objectContaining({ id: "owned-snapshot" }) })])
    expect(requests.filter(request => new URL(request.url).pathname === "/v2/sandboxes").every(request => new URL(request.url).searchParams.get("project") === "project" && new URL(request.url).searchParams.get("teamId") === "team" && new URL(request.url).searchParams.get("limit") === "2")).toBe(true)
  })

  test("best-effort kills a dispatched command after caller cancellation but preserves ambiguity", async () => {
    const controller = new AbortController(), providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    const paths: string[] = []
    const { value } = fixture(request => {
      const path = new URL(request.url).pathname; paths.push(`${request.method} ${path}`)
      if (path === `/v2/sandboxes/${name()}`) return created(name())
      if (path.endsWith("/cmd") && request.method === "POST") return Response.json({ command: { id: "command-cancel", sessionId: "session-1", exitCode: null } })
      if (path.endsWith("/cmd/command-cancel") && request.method === "GET") { controller.abort(new DOMException("caller left", "AbortError")); throw new TypeError("request cancelled") }
      if (path.endsWith("/cmd/command-cancel/kill")) return Response.json({ command: { id: "command-cancel", sessionId: "session-1", exitCode: null } })
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    await expect(value.runCommand({ accountId: "account", providerRef, script: "sleep 30", timeoutMs: 1000, signal: controller.signal })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    expect(paths.filter(path => path === "POST /v2/sandboxes/sessions/session-1/cmd/command-cancel/kill")).toHaveLength(1)
  })

  test("covers command timeout plus transport allowance and kills a nonterminal command", async () => {
    let now = 0; const paths: string[] = []
    const clock: VercelProviderClock = { now: () => now, sleep: async (_milliseconds, signal) => { signal.throwIfAborted(); now += 6 } }
    const value = new VercelSandboxInfrastructure(config, { clock, fetch: async (requestInput, init) => {
      const request = new Request(requestInput, init), path = new URL(request.url).pathname; paths.push(`${request.method} ${path}`)
      if (path === `/v2/sandboxes/${name()}`) return created(name())
      if (path.endsWith("/cmd") && request.method === "POST") return Response.json({ command: { id: "command-long", sessionId: "session-1", exitCode: null } })
      if (path.endsWith("/cmd/command-long") && request.method === "GET") return Response.json({ command: { id: "command-long", sessionId: "session-1", exitCode: null } })
      if (path.endsWith("/cmd/command-long/kill")) return Response.json({})
      throw new Error(`unexpected ${request.method} ${path}`)
    } })
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    await expect(value.runCommand({ accountId: "account", providerRef, script: "sleep 30", timeoutMs: 10, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    expect(paths).toContain("POST /v2/sandboxes/sessions/session-1/cmd/command-long/kill")
  })

  test("kills a command when a wait request consumes its remaining observation bound", async () => {
    const paths: string[] = []
    const value = new VercelSandboxInfrastructure(config, { clock: new Clock(), fetch: async (requestInput, init) => {
      const request = new Request(requestInput, init), path = new URL(request.url).pathname; paths.push(`${request.method} ${path}`)
      if (path === `/v2/sandboxes/${name()}`) return created(name())
      if (path.endsWith("/cmd") && request.method === "POST") return Response.json({ command: { id: "command-held", sessionId: "session-1", exitCode: null } })
      if (path.endsWith("/cmd/command-held") && request.method === "GET") return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))
      if (path.endsWith("/cmd/command-held/kill")) return Response.json({})
      throw new Error(`unexpected ${request.method} ${path}`)
    } })
    const providerRef = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    await expect(value.runCommand({ accountId: "account", providerRef, script: "sleep 30", timeoutMs: 1, signal: signal() })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    expect(paths).toContain("POST /v2/sandboxes/sessions/session-1/cmd/command-held/kill")
  })

  test("replaces a prior tracked automatic snapshot only after proving and deleting that prior automatic artifact", async () => {
    const paths: string[] = []; let phase: "first" | "second-active" | "second-stopped" = "first"
    const { value } = fixture(request => {
      const path = new URL(request.url).pathname; paths.push(`${request.method} ${path}`)
      if (path === `/v2/sandboxes/${name()}` && request.method === "GET") {
        if (phase === "first") return created(name(), "running", "session-1")
        if (phase === "second-active") return created(name(), "running", "session-2")
        return Response.json({ sandbox: { name: name(), currentSessionId: "session-2", currentSnapshotId: "auto-2", status: "stopped", tags: { "waterbox-owner": owner(), "waterbox-account": account() } }, session: { id: "session-2", projectId: "project" } })
      }
      if (path.endsWith("/sessions/session-1/stop")) { phase = "second-active"; return Response.json({ session: { id: "session-1", status: "stopped" }, snapshot: { id: "auto-1", sourceSessionId: "session-1", status: "created" } }) }
      if (path.endsWith("/sessions/session-2/stop")) { phase = "second-stopped"; return Response.json({ session: { id: "session-2", status: "stopped" }, snapshot: { id: "auto-2", sourceSessionId: "session-2", status: "created" } }) }
      if (path.endsWith("/snapshots/auto-1") && request.method === "GET") return Response.json({ id: "auto-1", sourceSessionId: "session-1", sourceSandboxName: name(), creationMethod: "automatic", tags: { "waterbox-owner": owner(), "waterbox-account": account() }, status: "created" })
      if (path.endsWith("/snapshots/auto-1") && request.method === "DELETE") return Response.json({ snapshot: { id: "auto-1", sourceSessionId: "session-1", status: "deleted" } })
      throw new Error(`unexpected ${request.method} ${path}`)
    })
    const original = { kind: "vercel-sandbox-v1", name: name(), owner: owner(), account: account() } as const
    const first = await value.stopResume.stop({ accountId: "account", providerRef: original, signal: signal() })
    const second = await value.stopResume.stop({ accountId: "account", providerRef: first.providerRef, signal: signal() })
    expect(second.providerRef).toMatchObject({ automaticSnapshotId: "auto-2" })
    expect(paths.indexOf("DELETE /v2/sandboxes/snapshots/auto-1")).toBeGreaterThan(paths.indexOf("POST /v2/sandboxes/sessions/session-2/stop"))
    expect(paths.some(path => path.includes("auto-2") && path.startsWith("DELETE"))).toBe(false)
  })
})
