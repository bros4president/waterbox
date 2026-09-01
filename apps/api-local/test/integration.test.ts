import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BashToolEventSchema,
  EditToolEventSchema,
  GlobToolEventSchema,
  GrepToolEventSchema,
  PatchToolEventSchema,
  ReadToolEventSchema,
  WriteToolEventSchema,
  type ToolName,
  type ToolEventByName,
} from "@waterbox/contracts"
import type {
  ProviderCreateSandboxInput,
  ProviderCreateSnapshotInput,
  ProviderExecuteInput,
  ProviderOperationInput,
  ProviderSnapshotOperationInput,
  SandboxProvider,
} from "@waterbox/core/provider"
import { ProviderError } from "@waterbox/core/provider"
import { FixedClock, SequenceIdGenerator } from "@waterbox/core/test-support"
import { createDaemon } from "@waterbox/daemon"
import { createLocalControlPlane } from "@waterbox/control-plane-local"
import { fixedDevelopmentIdentityResolver, loadDevelopmentRuntimeArtifact } from "../src/app.ts"
import { LocalConfigurationError, parseLocalApiConfig, type LocalApiConfig } from "../src/config.ts"
import { startLocalServer } from "../src/server.ts"

const sandboxId = "sbx_calm-cactus-7k3m"
const secondSandboxId = "sbx_bright-river-4n8p"
const snapshotId = "snap_silver-forest-2p9x"
const apiKey = "development-secret-never-print"
const accountId = "acct_local_test"
const internalUrl = "https://protected.invalid/daemon?_token=provider-secret"
const runtimeBytes = new TextEncoder().encode('#!/usr/bin/env node\nconst WORKSPACE_ROOT="/workspace",worker="__internal-bash-worker",node="/usr/local/bin/node",cli="/usr/local/lib/waterbox-cli.js";void[WORKSPACE_ROOT,worker,node,cli]\n')
const runtimeArtifact = { bytes: runtimeBytes, sha256: createHash("sha256").update(runtimeBytes).digest("hex"), cliProtocolVersion: 2 as const, artifactVersion: "0.1.0" }
const eventSchemas = { read: ReadToolEventSchema, write: WriteToolEventSchema, edit: EditToolEventSchema, patch: PatchToolEventSchema, glob: GlobToolEventSchema, grep: GrepToolEventSchema, bash: BashToolEventSchema }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

class DaemonBackedProvider implements SandboxProvider {
  readonly name = "fake"
  readonly stopResume = { stop: (input: ProviderOperationInput) => this.stop(input), resume: (input: ProviderOperationInput) => this.resume(input) }
  readonly snapshots = { create: (input: ProviderCreateSnapshotInput) => this.createSnapshot(input), inspect: (input: ProviderSnapshotOperationInput) => this.inspectSnapshot(input), delete: (input: ProviderSnapshotOperationInput) => this.deleteSnapshot(input) }
  readonly states = new Map<string, "running" | "stopped" | "terminated">()
  readonly snapshotStates = new Map<string, "ready" | "deleted">()
  prepareError?: unknown
  lastToolSignal?: AbortSignal
  constructor(readonly daemonUrl: string) {}
  async createSandbox(input: ProviderCreateSandboxInput) { this.states.set(input.sandboxId, "running"); return { state: "running" as const, providerRef: { id: input.sandboxId, url: internalUrl } } }
  async prepareSandbox(input: ProviderOperationInput) {
    if (this.prepareError !== undefined) throw this.prepareError
    return { state: "running" as const, providerRef: input.providerRef }
  }
  async inspectSandbox(input: ProviderOperationInput) { const id = refId(input.providerRef); return { state: this.states.get(id) ?? "running", providerRef: input.providerRef } }
  async stop(input: ProviderOperationInput) { this.states.set(refId(input.providerRef), "stopped"); return { state: "stopped" as const, providerRef: input.providerRef } }
  async resume(input: ProviderOperationInput) { this.states.set(refId(input.providerRef), "running"); return { state: "running" as const, providerRef: input.providerRef } }
  async deleteSandbox(input: ProviderOperationInput) { this.states.set(refId(input.providerRef), "terminated"); return { state: "terminated" as const, providerRef: input.providerRef } }
  async createSnapshot(input: ProviderCreateSnapshotInput) { this.snapshotStates.set(input.snapshotId, "ready"); return { state: "ready" as const, providerRef: { id: input.snapshotId, source: refId(input.sandboxRef) } } }
  async inspectSnapshot(input: ProviderSnapshotOperationInput) { return { state: this.snapshotStates.get(input.snapshotId) ?? "ready", providerRef: input.providerRef } }
  async deleteSnapshot(input: ProviderSnapshotOperationInput) { this.snapshotStates.set(input.snapshotId, "deleted"); return { state: "deleted" as const, providerRef: input.providerRef } }
  async *executeTool<N extends ToolName>(input: ProviderExecuteInput<N>): AsyncIterable<ToolEventByName[N]> {
    this.lastToolSignal = input.signal
    if (input.toolName === "bash" && "command" in input.arguments && input.arguments.command === "waterbox-test-wait-for-cancel") {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(input.signal.reason ?? new DOMException("Aborted", "AbortError"))
        input.signal.addEventListener("abort", abort, { once: true })
        if (input.signal.aborted) abort()
      })
    }
    const response = await fetch(`${this.daemonUrl}/v1/tools/${input.toolName}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input.arguments), signal: input.signal,
    })
    if (!response.ok) throw new Error("Fake daemon operation failed")
    if (input.toolName !== "bash") {
      yield eventSchemas[input.toolName].parse(await response.json()) as ToolEventByName[N]
      return
    }
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    let pending = ""
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        pending += item.value
        let newline: number
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
          if (line) yield BashToolEventSchema.parse(JSON.parse(line)) as ToolEventByName[N]
        }
      }
    } finally { reader.releaseLock() }
  }
}

function refId(value: unknown): string {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") throw new Error("Invalid fake reference")
  return value.id
}

async function fixture(ids = [sandboxId, secondSandboxId]) {
  const directory = await mkdtemp(join(tmpdir(), "waterbox-api-local-"))
  const daemon = createDaemon({ workspaceRoot: directory })
  const daemonServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: daemon.handleRequest })
  const provider = new DaemonBackedProvider(`http://127.0.0.1:${daemonServer.port}`)
  const config: LocalApiConfig = {
    host: "127.0.0.1", port: 0, sqlitePath: join(directory, "control-plane.sqlite"), developmentApiKey: apiKey, accountId,
    box: { apiBaseUrl: "https://ascii.dev/api/box/v1", apiKey: "unused-test-placeholder", polling: { intervalMs: 1, timeoutMs: 10 } },
  }
  const create = () => createLocalControlPlane({
    sqlitePath: config.sqlitePath,
    accountId: config.accountId,
    provider: { kind: "injected", implementation: provider },
  }, fixedDevelopmentIdentityResolver(apiKey, accountId), { clock: new FixedClock(), ids: new SequenceIdGenerator(ids, [snapshotId]) })
  const plane = await create()
  const logs: string[] = []
  const running = await startLocalServer(plane, { host: "127.0.0.1", port: 0, log: (line) => logs.push(line) })
  const baseUrl = `http://127.0.0.1:${running.server.port}`
  cleanup.push(async () => { await running.close(); daemon.shutdown(); await daemonServer.stop(true); await rm(directory, { recursive: true, force: true }) })
  return { directory, config, create, provider, running, baseUrl, logs }
}

function request(baseUrl: string, path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${apiKey}`, ...init.headers } })
}
async function json(baseUrl: string, path: string, init: RequestInit = {}) {
  const response = await request(baseUrl, path, init)
  expect(response.status, await response.clone().text()).toBeLessThan(300)
  return response.json()
}
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

describe("local API composition", () => {
  test("listener startup failure and repeated shutdown close the control plane once", async () => {
    let startupCloses = 0
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") })
    try {
      await expect(startLocalServer({
        fetch: async () => new Response("unused"),
        close: async () => { startupCloses++ },
      }, { host: "127.0.0.1", port: occupied.port! })).rejects.toThrow()
      expect(startupCloses).toBe(1)
    } finally {
      await occupied.stop(true)
    }

    let shutdownCloses = 0
    const running = await startLocalServer({
      fetch: async () => new Response("ok"),
      close: async () => { shutdownCloses++ },
    }, { host: "127.0.0.1", port: 0 })
    await running.close()
    await running.close()
    expect(shutdownCloses).toBe(1)
  })

  test("throwing address logging stops the bound listener and closes once without replacing the error", async () => {
    const loggerError = new Error("deterministic logger failure")
    let closes = 0
    let loggedAddress = ""
    let caught: unknown
    try {
      await startLocalServer({
        fetch: async () => new Response("unused"),
        close: async () => { closes++; throw new Error("cleanup failure must not replace logger failure") },
      }, {
        host: "127.0.0.1",
        port: 0,
        log(message) { loggedAddress = message; throw loggerError },
      })
    } catch (error) { caught = error }

    expect(caught).toBe(loggerError)
    expect(closes).toBe(1)
    const port = Number(loggedAddress.match(/:(\d+)$/)?.[1])
    expect(Number.isInteger(port) && port > 0).toBeTrue()
    const rebound = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("rebound") })
    await rebound.stop(true)
  })

  test("reads the fixed package-relative artifact and fails safely when it is missing", async () => {
    let reads = 0; let readUrl: URL | undefined
    const artifact = await loadDevelopmentRuntimeArtifact({
      async load(url, artifactVersion) { readUrl = url; reads++; return { ...runtimeArtifact, artifactVersion } },
    })
    expect(reads).toBe(1)
    expect(readUrl?.pathname.endsWith("/packages/sandbox-cli/dist/waterbox-cli.js")).toBe(true)
    expect(artifact.sha256).toBe(runtimeArtifact.sha256)
    await expect(loadDevelopmentRuntimeArtifact({ async load() { throw new Error("missing") } })).rejects.toThrow("Waterbox local runtime artifact is unavailable")

    const directory = await mkdtemp(join(tmpdir(), "waterbox-api-local-clean-"))
    const config: LocalApiConfig = {
      host: "127.0.0.1", port: 0, sqlitePath: join(directory, "control-plane.sqlite"), developmentApiKey: "placeholder-development-key", accountId,
      box: { apiBaseUrl: "https://api.box.invalid", apiKey: "placeholder-not-a-live-key", polling: { intervalMs: 1, timeoutMs: 10 } },
    }
    const plane = await createLocalControlPlane({
      sqlitePath: config.sqlitePath,
      accountId: config.accountId,
      provider: { kind: "box", config: config.box, runtimeArtifact: artifact },
    }, fixedDevelopmentIdentityResolver(config.developmentApiKey, config.accountId))
    try { expect((await plane.fetch(new Request("http://local.test/health"))).status).toBe(200) }
    finally { plane.close(); await rm(directory, { recursive: true, force: true }) }
  })

  test("strict configuration is secret-safe and fixed identity rejects other keys", async () => {
    const raw = { WATERBOX_SQLITE_PATH: "/tmp/waterbox.sqlite", WATERBOX_DEV_API_KEY: apiKey, WATERBOX_DEV_ACCOUNT_ID: accountId, BOX_API_KEY: "box-secret" }
    let error: unknown
    try { parseLocalApiConfig({ ...raw, WATERBOX_API_PORT: "not-a-port" }) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(LocalConfigurationError)
    expect(String(error)).not.toContain(apiKey)
    expect(String(error)).not.toContain("box-secret")
    const context = await fixture()
    expect((await fetch(`${context.baseUrl}/v1/sandboxes`)).status).toBe(401)
    expect((await fetch(`${context.baseUrl}/v1/sandboxes`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
  })

  test("health/OpenAPI use a real listener and SQLite survives reconstruction", async () => {
    const context = await fixture()
    expect((await fetch(`${context.baseUrl}/health`)).status).toBe(200)
    expect((await (await fetch(`${context.baseUrl}/openapi.json`)).json()).openapi).toBe("3.1.0")
    await json(context.baseUrl, "/v1/sandboxes", { ...post({}), headers: { "content-type": "application/json", "idempotency-key": "persist-1" } })
    await context.running.close()
    const reconstructed = await context.create()
    const replacement = await startLocalServer(reconstructed, { host: "127.0.0.1", port: 0 })
    cleanup.push(() => replacement.close())
    const replacementUrl = `http://127.0.0.1:${replacement.server.port}`
    expect((await json(replacementUrl, "/v1/sandboxes")).items).toHaveLength(1)
    expect((await json(replacementUrl, `/v1/sandboxes/${sandboxId}`)).sandboxId).toBe(sandboxId)
  })

  test("returns recovery sandbox IDs for definite and ambiguous post-checkpoint create failures", async () => {
    for (const kind of ["failure", "ambiguous_execution"] as const) {
      const context = await fixture([sandboxId])
      const secret = `private-${kind}-detail`
      context.provider.prepareError = new ProviderError(kind, secret)

      const response = await request(context.baseUrl, "/v1/sandboxes", {
        ...post({}),
        headers: { "content-type": "application/json", "idempotency-key": `prepare-${kind}` },
      })
      expect(response.status).toBe(502)
      const text = await response.text()
      expect(text).not.toContain(secret)
      expect(JSON.parse(text)).toEqual({
        error: {
          code: kind === "failure" ? "provider_failure" : "ambiguous_execution",
          message: kind === "failure" ? "The provider operation failed" : "The provider execution outcome is unknown",
          requestId: expect.any(String),
          sandboxId,
        },
      })

      const recovered = await json(context.baseUrl, `/v1/sandboxes/${sandboxId}`)
      expect(recovered.state).toBe(kind === "failure" ? "failed" : "preparing")
      expect((await json(context.baseUrl, `/v1/sandboxes/${sandboxId}`, { method: "DELETE" })).state).toBe("terminated")
    }
  })

  test("runs lifecycle, snapshots, snapshot fork, and every tool without leaking internals", async () => {
    const context = await fixture()
    const created = await json(context.baseUrl, "/v1/sandboxes", post({}))
    expect(created.sandboxId).toBe(sandboxId)
    await json(context.baseUrl, `/v1/sandboxes/${sandboxId}/tools/write`, post({ filePath: "a.txt", content: "alpha\n" }))
    await json(context.baseUrl, `/v1/sandboxes/${sandboxId}/tools/read`, post({ filePath: "a.txt" }))
    await json(context.baseUrl, `/v1/sandboxes/${sandboxId}/tools/edit`, post({ filePath: "a.txt", oldString: "alpha", newString: "beta" }))
    await json(context.baseUrl, `/v1/sandboxes/${sandboxId}/tools/patch`, post({ patchText: "*** Begin Patch\n*** Add File: b.txt\n+bravo\n*** End Patch" }))
    await json(context.baseUrl, `/v1/sandboxes/${sandboxId}/tools/glob`, post({ pattern: "*.txt", path: "." }))
    await json(context.baseUrl, `/v1/sandboxes/${sandboxId}/tools/grep`, post({ pattern: "beta", path: "." }))
    await (await request(context.baseUrl, `/v1/sandboxes/${sandboxId}/tools/bash`, post({ command: "printf done" }))).text()
    expect((await json(context.baseUrl, `/v1/sandboxes/${sandboxId}/stop`, { method: "POST" })).state).toBe("stopped")
    expect((await json(context.baseUrl, `/v1/sandboxes/${sandboxId}/resume`, { method: "POST" })).state).toBe("running")
    expect((await json(context.baseUrl, `/v1/sandboxes/${sandboxId}/stop`, { method: "POST" })).state).toBe("stopped")
    await json(context.baseUrl, `/v1/sandboxes/${sandboxId}/tools/read`, post({ filePath: "a.txt" }))
    expect(context.provider.states.get(sandboxId)).toBe("running")
    expect((await json(context.baseUrl, `/v1/sandboxes/${sandboxId}/snapshots`, post({ name: "checkpoint" }))).state).toBe("ready")
    expect((await json(context.baseUrl, "/v1/snapshots")).items).toHaveLength(1)
    expect((await json(context.baseUrl, `/v1/snapshots/${snapshotId}`)).snapshotId).toBe(snapshotId)
    expect((await json(context.baseUrl, "/v1/sandboxes", post({ sourceSnapshotId: snapshotId }))).sandboxId).toBe(secondSandboxId)
    expect((await json(context.baseUrl, `/v1/sandboxes/${secondSandboxId}/tools/read`, post({ filePath: "a.txt" }))).type).toBe("result")
    expect((await json(context.baseUrl, `/v1/snapshots/${snapshotId}`, { method: "DELETE" })).state).toBe("deleted")
    expect((await json(context.baseUrl, `/v1/sandboxes/${sandboxId}`, { method: "DELETE" })).state).toBe("terminated")
    const publicText = JSON.stringify([created, await json(context.baseUrl, "/v1/sandboxes"), await json(context.baseUrl, "/v1/snapshots")])
    expect(publicText).not.toContain(accountId)
    expect(publicText).not.toContain("provider-secret")
    expect(publicText).not.toContain("providerRef")
    expect(context.logs.join("\n")).not.toContain(apiKey)
    expect(context.logs.join("\n")).not.toContain("provider-secret")
  })

  test("bash streams genuinely incrementally through the listener", async () => {
    const context = await fixture([sandboxId])
    await json(context.baseUrl, "/v1/sandboxes", post({}))
    const response = await request(context.baseUrl, `/v1/sandboxes/${sandboxId}/tools/bash`, post({ command: "printf first; sleep 0.25; printf second" }))
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("first")
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toContain("second")
  })

  test("pre-first-chunk client disconnect aborts provider and remote bash", async () => {
    const context = await fixture([sandboxId])
    await json(context.baseUrl, "/v1/sandboxes", post({}))
    const controller = new AbortController()
    const pending = request(context.baseUrl, `/v1/sandboxes/${sandboxId}/tools/bash`, { ...post({ command: "waterbox-test-wait-for-cancel" }), signal: controller.signal })
    await Bun.sleep(50)
    controller.abort(new DOMException("client disconnected", "AbortError"))
    await expect(pending).rejects.toThrow()
    for (let attempt = 0; attempt < 100 && !context.provider.lastToolSignal?.aborted; attempt++) await Bun.sleep(10)
    expect(context.provider.lastToolSignal?.aborted).toBeTrue()
  })
})
