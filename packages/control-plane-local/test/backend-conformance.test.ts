import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEmbeddedApiBackend, createLocalControlPlane } from "@waterbox/control-plane-local"
import { FixedClock, FakeSandboxProvider, SequenceIdGenerator } from "@waterbox/core/test-support"
import { SqliteRepositoryStore } from "@waterbox/repository-sqlite"
import { ProviderError, type ProviderCleanupBashJobInput, type ProviderConsumeSecureTransferInput, type ProviderExecuteInput, type ProviderObserveBashJobInput, type ProviderOperationInput } from "@waterbox/core/provider"
import type { SecureTransferDelivered, SecureTransferInitiated, ToolEventByName, ToolName } from "@waterbox/contracts"
import { MAX_API_ERROR_RESPONSE_BYTES, WaterboxClient, WaterboxClientError, createRemoteApiBackend, type ApiBackend } from "@waterbox/client"

const accountId = "acct_client_conformance"
const bearer = "ephemeral-client-conformance-bearer"
const sandboxId = "sbx_calm-cactus-7k3m"
const secondSandboxId = "sbx_bright-river-4n8p"
const snapshotId = "snap_silver-forest-2p9x"
const secondSnapshotId = "snap_bright-river-4n8p"
const signal = new AbortController().signal
const ephemeralRecipient = "age1qckl3yp8ytpej8474nuvzzrg33jnakfyesj8fkyf329hjyn75sgqvxh2sv"
const artifactBytes = new TextEncoder().encode("waterbox-conformance-runtime-artifact")
const conformanceArtifact = {
  bytes: artifactBytes,
  sha256: createHash("sha256").update(artifactBytes).digest("hex"),
  cliProtocolVersion: 2 as const,
  artifactVersion: "conformance-runtime-v1",
}
type ConformanceArtifact = typeof conformanceArtifact
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

function requireConformanceArtifact(value: ConformanceArtifact): ConformanceArtifact {
  if (!value || value.cliProtocolVersion !== 2 || value.artifactVersion !== "conformance-runtime-v1"
    || !(value.bytes instanceof Uint8Array) || createHash("sha256").update(value.bytes).digest("hex") !== value.sha256) {
    throw new TypeError("Conformance runtime artifact is invalid")
  }
  return value
}

class ConformanceProvider extends FakeSandboxProvider {
  readonly consumedArtifacts: Array<{ artifact: ConformanceArtifact; token: string }> = []
  readonly ciphertexts: string[] = []
  bashMode: "completed" | "dispatched" | "fallback" = "completed"
  bashOffsets: number[] = []
  bashCleanups = 0
  bashCleanupBeforeTerminal = false
  bashCleanupError?: unknown
  bashObservations = 0
  bashOutput = "observed"
  secureConsumeError?: unknown
  readonly #recipient: string
  readonly #artifact: ConformanceArtifact
  readonly #artifactToken: string
  constructor(recipient: string, artifact: ConformanceArtifact) {
    super(); this.#recipient = recipient
    this.#artifact = requireConformanceArtifact(artifact)
    this.#artifactToken = `${artifact.sha256}:${artifact.cliProtocolVersion}:${artifact.artifactVersion}`
    this.bashJobs = { observe: input => this.observeBash(input), cleanup: input => this.cleanupBash(input) }
  }
  declare readonly bashJobs: {
    observe(input: ProviderObserveBashJobInput): ReturnType<ConformanceProvider["observeBash"]>
    cleanup(input: ProviderCleanupBashJobInput): Promise<void>
  }

  override async prepareSandbox(input: ProviderOperationInput) {
    const artifact = requireConformanceArtifact(this.#artifact)
    const observation = await super.prepareSandbox(input)
    this.consumedArtifacts.push({ artifact, token: this.#artifactToken })
    return observation
  }

  override executeTool<N extends ToolName>(input: ProviderExecuteInput<N>): AsyncIterable<ToolEventByName[N]> {
    this.executeCalls++; this.toolInputs.push(input)
    const results = {
      read: { type: "result", title: "Read", output: "alpha", metadata: { filePath: "/workspace/a", offset: 1 } },
      write: { type: "result", title: "Write", output: "ok", metadata: { filePath: "/workspace/a", bytes: 5 } },
      edit: { type: "result", title: "Edit", output: "ok", metadata: { filePath: "/workspace/a", replacements: 1, bytes: 4 } },
      patch: { type: "result", title: "Patch", output: "ok", metadata: { added: ["b"], updated: [], deleted: [], moved: [] } },
      glob: { type: "result", title: "Glob", output: "a", metadata: { pattern: "*", path: "/workspace", count: 1, truncated: false } },
      grep: { type: "result", title: "Grep", output: "a:1", metadata: { pattern: "alpha", path: "/workspace", matches: 1, truncated: false } },
      bash: { type: "result", title: "Bash", output: "done", outcome: "completed", metadata: { command: "printf done", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } },
    } as const
    if (input.toolName === "bash" && this.bashMode !== "completed") {
      const jobId = "job_0123456789abcdef0123456789abcdef"
      const receipt = { type: "result", title: "Bash", output: "dispatched", outcome: "dispatched", metadata: { command: "printf done", workdir: "/workspace", jobId, outputPath: `/run/waterbox/bash-jobs/${jobId}/output.log`, statusPath: `/run/waterbox/bash-jobs/${jobId}/status.json` } }
      return (async function* () { yield receipt as unknown as ToolEventByName[N] })()
    }
    return (async function* () { yield results[input.toolName] as unknown as ToolEventByName[N] })()
  }

  protected override async initiateSecureTransfer(_input: ProviderOperationInput): Promise<SecureTransferInitiated> {
    return { transferId: "123e4567-e89b-42d3-a456-426614174000", publicKey: this.#recipient, algorithm: "age-x25519", expiresAt: "2099-01-01T00:00:00.000Z" }
  }

  protected override async consumeSecureTransfer(input: ProviderConsumeSecureTransferInput): Promise<SecureTransferDelivered> {
    this.ciphertexts.push(input.ciphertext)
    if (this.secureConsumeError !== undefined) throw this.secureConsumeError
    return { transferId: input.transferId, targetPath: input.targetPath, bytes: 9 }
  }

  private async observeBash(input: ProviderObserveBashJobInput) {
    this.bashOffsets.push(input.offset)
    if (this.bashMode === "fallback") throw new ProviderError("failure", "private-observation-detail")
    const bytes = new TextEncoder().encode(this.bashOutput)
    this.bashObservations++
    if (this.bashObservations === 1) return { jobId: input.jobId, state: "running" as const, chunkBase64: "", nextOffset: input.offset, outputSize: bytes.length }
    const chunk = bytes.subarray(input.offset, input.offset + input.maxBytes)
    return { jobId: input.jobId, state: "completed" as const, chunkBase64: Buffer.from(chunk).toString("base64"), nextOffset: input.offset + chunk.length, outputSize: bytes.length, exitCode: 0, signal: null, timedOut: false, durationMs: 3 }
  }

  private async cleanupBash(_input: ProviderCleanupBashJobInput) {
    this.bashCleanups++
    if (this.bashObservations < 2) this.bashCleanupBeforeTerminal = true
    if (this.bashCleanupError !== undefined) throw this.bashCleanupError
  }
}

type Mode = "embedded" | "network"

async function authenticationTransport(mode: Mode) {
  let release: (() => void) | undefined
  const provider = new ConformanceProvider(ephemeralRecipient, conformanceArtifact)
  const plane = await createLocalControlPlane({ sqlitePath: ":memory:", accountId, provider: { kind: "injected", implementation: provider } }, {
    async resolveBearer(value, requestSignal) {
      if (value === "delayed") await new Promise<void>((resolve, reject) => {
        release = resolve
        requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true })
      })
      requestSignal.throwIfAborted()
      return value === bearer ? { accountId } : undefined
    },
  })
  if (mode === "embedded") {
    const embedded = await createEmbeddedApiBackend({ sqlitePath: ":memory:", accountId, provider: { kind: "injected", implementation: new ConformanceProvider(ephemeralRecipient, conformanceArtifact) } })
    cleanup.push(async () => { await embedded.close(); await plane.close() })
    return { rawFetch: (request: Request) => plane.fetch(request), authorizedFetch: (request: Request) => embedded.fetch(request), release: () => release?.() }
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: plane.fetch })
  cleanup.push(async () => { await server.stop(true); await plane.close() })
  const rawFetch = (request: Request) => fetch(new Request(request.url.replace("http://waterbox.local", `http://127.0.0.1:${server.port}`), request))
  return { rawFetch, authorizedFetch(request: Request) { const headers = new Headers(request.headers); headers.set("authorization", `Bearer ${bearer}`); return rawFetch(new Request(request, { headers })) }, release: () => release?.() }
}

async function fixture(mode: Mode, options: { provider?: ConformanceProvider; decorate?: (response: Response, request: Request) => Response | Promise<Response>; sqlitePath?: string; ids?: SequenceIdGenerator } = {}) {
  const provider = options.provider ?? new ConformanceProvider(ephemeralRecipient, conformanceArtifact)
  const config = { sqlitePath: options.sqlitePath ?? ":memory:", accountId, provider: { kind: "injected" as const, implementation: provider } }
  const internals = { clock: new FixedClock(), ids: options.ids ?? new SequenceIdGenerator([sandboxId, secondSandboxId], [snapshotId, secondSnapshotId]) }
  let backend: ApiBackend
  if (mode === "embedded") {
    const inner = await createEmbeddedApiBackend(config, internals)
    backend = options.decorate === undefined ? inner : { origin: inner.origin, async fetch(request) { return options.decorate!(await inner.fetch(request), request) }, close: () => inner.close() }
  } else {
    const resolver = { async resolveBearer(value: string | undefined, requestSignal: AbortSignal) { requestSignal.throwIfAborted(); return value === bearer ? { accountId } : undefined } }
    const plane = await createLocalControlPlane(config, resolver, internals)
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: plane.fetch })
    backend = createRemoteApiBackend(`http://127.0.0.1:${server.port}/`, async request => {
      const headers = new Headers(request.headers); headers.set("authorization", `Bearer ${bearer}`)
      const response = await fetch(new Request(request, { headers }))
      return options.decorate === undefined ? response : options.decorate(response, request)
    })
    cleanup.push(async () => { await server.stop(true); await plane.close() })
  }
  const client = new WaterboxClient(backend, { bashObservationIntervalMs: 0, bashCleanupDeadlineMs: 50 })
  cleanup.push(() => client.close())
  return { client, provider, backend }
}

async function seedProvisioning(sqlitePath: string) {
  const store = new SqliteRepositoryStore(sqlitePath, { create: true })
  await store.sandboxes.createIfAbsent({ accountId, sandboxId, provider: "fake", providerConfigurationId: "pcfg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", providerRef: { privateSandboxId: sandboxId }, state: "provisioning", version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" })
  store.close()
}

for (const mode of ["embedded", "network"] as const) {
  describe(`${mode} ApiBackend conformance`, () => {
    test("requires, validates, propagates, and revalidates the injected runtime artifact", async () => {
      expect(() => new ConformanceProvider(ephemeralRecipient, undefined as unknown as ConformanceArtifact)).toThrow("artifact")
      expect(() => new ConformanceProvider(ephemeralRecipient, { ...conformanceArtifact, sha256: "0".repeat(64) })).toThrow("artifact")
      const mutableBytes = conformanceArtifact.bytes.slice()
      const mutableArtifact = { ...conformanceArtifact, bytes: mutableBytes }
      const provider = new ConformanceProvider(ephemeralRecipient, mutableArtifact)
      mutableBytes[0] = mutableBytes[0]! ^ 0xff
      const { client } = await fixture(mode, { provider })
      await expect(client.createSandbox({}, { idempotencyKey: "mutated-artifact", signal })).rejects.toMatchObject({ code: "provider_failure", recoverySandboxId: sandboxId })
      expect(provider.consumedArtifacts).toEqual([])
    })

    test("enforces missing/wrong bearer and aborts during asynchronous identity resolution", async () => {
      const transport = await authenticationTransport(mode)
      expect((await transport.rawFetch(new Request("http://waterbox.local/v1/sandboxes"))).status).toBe(401)
      expect((await transport.rawFetch(new Request("http://waterbox.local/v1/sandboxes", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401)
      expect((await transport.authorizedFetch(new Request("http://waterbox.local/v1/sandboxes", { headers: { authorization: "Bearer caller-cannot-control" } }))).status).toBe(200)
      const controller = new AbortController()
      const pending = transport.rawFetch(new Request("http://waterbox.local/v1/sandboxes", { headers: { authorization: "Bearer delayed" }, signal: controller.signal }))
      await Bun.sleep(5); controller.abort(new DOMException("identity cancelled", "AbortError"))
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      transport.release()
    })
    test("runs the identical complete supported command surface", async () => {
      const { client, provider, backend } = await fixture(mode)
      const created = await client.createSandbox({}, { idempotencyKey: "conformance-create", signal })
      expect(created).toMatchObject({ sandboxId, state: "running" })
      expect(provider.consumedArtifacts).toHaveLength(1)
      expect(provider.consumedArtifacts[0]?.artifact).toBe(conformanceArtifact)
      expect(provider.consumedArtifacts[0]).toEqual({ artifact: conformanceArtifact, token: `${conformanceArtifact.sha256}:2:${conformanceArtifact.artifactVersion}` })
      expect(await client.probeSandbox({ sandboxId }, { signal })).toMatchObject({ sandboxId, state: "running" })

      expect((await client.read({ sandboxId, filePath: "/workspace/a" }, { signal })).output).toBe("alpha")
      expect((await client.write({ sandboxId, filePath: "/workspace/a", content: "alpha" }, { signal })).metadata.bytes).toBe(5)
      expect((await client.edit({ sandboxId, filePath: "/workspace/a", oldString: "alpha", newString: "beta" }, { signal })).metadata.replacements).toBe(1)
      expect((await client.patch({ sandboxId, patchText: "*** Begin Patch\n*** End Patch" }, { signal })).metadata.added).toEqual(["b"])
      expect((await client.glob({ sandboxId, pattern: "*" }, { signal })).metadata.count).toBe(1)
      expect((await client.grep({ sandboxId, pattern: "alpha" }, { signal })).metadata.matches).toBe(1)
      expect(await client.bash({ sandboxId, command: "printf done" }, { signal })).toMatchObject({ outcome: "completed", output: "done" })

      const snap = await client.createSnapshot({ sandboxId, name: "checkpoint" }, { signal })
      expect(snap.snapshotId).toBe(snapshotId)
      expect((await client.listSnapshots({}, { signal })).items.map(item => item.snapshotId)).toEqual([snapshotId])
      expect((await client.createSandbox({ sourceSnapshotId: snapshotId }, { idempotencyKey: "from-snapshot", signal })).sandboxId).toBe(secondSandboxId)
      expect(provider.createInputs[1]?.sourceSnapshotRef).toBeDefined()
      expect((await client.createSnapshot({ sandboxId: secondSandboxId, name: "second" }, { signal })).snapshotId).toBe(secondSnapshotId)
      const firstPage = await client.listSnapshots({ limit: 1 }, { signal })
      expect(firstPage.items).toHaveLength(1)
      expect(firstPage.nextCursor).toEqual(expect.any(String))
      expect((await client.listSnapshots({ cursor: firstPage.nextCursor, limit: 1 }, { signal })).items).toHaveLength(1)
      expect((await client.deleteSnapshot({ snapshotId }, { signal })).state).toBe("deleted")
      expect((await client.deleteSnapshot({ snapshotId: secondSnapshotId }, { signal })).state).toBe("deleted")

      const plaintext = new TextEncoder().encode("topsecret")
      expect((await client.sendFileSecurely({ sandboxId, plaintext, targetPath: "/workspace/secret" }, { signal })).bytes).toBe(9)
      expect(plaintext.every(byte => byte === 0)).toBeFalse()
      expect(provider.ciphertexts).toHaveLength(1)
      expect(provider.ciphertexts[0]).not.toContain("topsecret")
      expect((await client.deleteSandbox({ sandboxId }, { signal })).state).toBe("terminated")
      expect(provider.toolInputs.map(input => input.toolName)).toEqual(["read", "write", "edit", "patch", "glob", "grep", "bash"])
    })

    test("propagates pre-abort and closes idempotently", async () => {
      const { client } = await fixture(mode)
      const controller = new AbortController(); const reason = new DOMException("cancelled", "AbortError"); controller.abort(reason)
      expect(await client.createSandbox({}, { idempotencyKey: "aborted", signal: controller.signal }).catch(error => error)).toBe(reason)
      await Promise.all([client.close(), client.close()])
    })

    test("preserves recovery errors and leaves same-key replay explicit", async () => {
      const provider = new ConformanceProvider(ephemeralRecipient, conformanceArtifact)
      provider.prepareError = new ProviderError("ambiguous_execution", "private-provider-detail")
      const { client } = await fixture(mode, { provider })
      const error = await client.createSandbox({}, { idempotencyKey: "recover", signal }).catch(value => value)
      expect(error).toBeInstanceOf(WaterboxClientError)
      expect(error).toMatchObject({ status: 502, code: "ambiguous_execution", recoverySandboxId: sandboxId, requestId: expect.any(String) })
      expect(String(error)).not.toContain("private-provider-detail")
      expect(provider.createCalls).toBe(1)
      expect(await client.probeSandbox({ sandboxId }, { signal })).toMatchObject({ sandboxId, state: "preparing" })
      expect(provider.prepareCalls).toBe(1)
      provider.prepareError = undefined
      expect(await client.createSandbox({}, { idempotencyKey: "recover", signal })).toMatchObject({ sandboxId, state: "running" })
      expect(provider.createCalls).toBe(1)
      expect(provider.prepareCalls).toBe(2)
      expect((await client.deleteSandbox({ sandboxId }, { signal })).state).toBe("terminated")
      await expect(client.read({ sandboxId, filePath: "/workspace/a" }, { signal })).rejects.toMatchObject({ code: "invalid_state", requestId: expect.any(String) })

      const definiteProvider = new ConformanceProvider(ephemeralRecipient, conformanceArtifact)
      definiteProvider.prepareError = new ProviderError("failure", "private-definite-detail")
      const definite = await fixture(mode, { provider: definiteProvider })
      const definiteError = await definite.client.createSandbox({}, { idempotencyKey: "definite", signal }).catch(value => value)
      expect(definiteError).toMatchObject({ code: "provider_failure", recoverySandboxId: sandboxId, requestId: expect.any(String) })
      expect(String(definiteError)).not.toContain("private-definite-detail")
    })

    test("does not invent a recovery ID when cancellation wins after the checkpoint and permits explicit replay", async () => {
      const provider = new ConformanceProvider(ephemeralRecipient, conformanceArtifact)
      provider.prepareError = new ProviderError("ambiguous_execution", "private-cancelled-detail")
      const controller = new AbortController()
      const { client } = await fixture(mode, { provider, decorate(response, request) {
        if (request.method === "POST" && new URL(request.url).pathname === "/v1/sandboxes" && response.status === 502) controller.abort(new DOMException("caller cancelled after checkpoint", "AbortError"))
        return response
      } })
      const error = await client.createSandbox({}, { idempotencyKey: "cancelled-checkpoint", signal: controller.signal }).catch(value => value)
      expect(error).toMatchObject({ name: "AbortError" })
      expect((error as { recoverySandboxId?: string }).recoverySandboxId).toBeUndefined()
      provider.prepareError = undefined
      expect(await client.createSandbox({}, { idempotencyKey: "cancelled-checkpoint", signal })).toMatchObject({ sandboxId, state: "running" })
      expect(provider.createCalls).toBe(1)
    })

    test("reconstructs durable preparing state and resumes only by explicit same-key replay", async () => {
      const directory = await mkdtemp(join(tmpdir(), `waterbox-${mode}-reconstruct-`))
      cleanup.push(() => rm(directory, { recursive: true, force: true }))
      const sqlitePath = join(directory, "state.sqlite")
      const provider = new ConformanceProvider(ephemeralRecipient, conformanceArtifact)
      provider.prepareError = new ProviderError("ambiguous_execution", "private-preparation-detail")
      const first = await fixture(mode, { provider, sqlitePath, ids: new SequenceIdGenerator([sandboxId]) })
      await expect(first.client.createSandbox({}, { idempotencyKey: "durable-prepare", signal })).rejects.toMatchObject({ code: "ambiguous_execution", recoverySandboxId: sandboxId })
      await first.client.close()
      provider.prepareError = undefined
      const second = await fixture(mode, { provider, sqlitePath, ids: new SequenceIdGenerator([]) })
      expect(await second.client.createSandbox({}, { idempotencyKey: "durable-prepare", signal })).toMatchObject({ sandboxId, state: "running" })
      expect(provider.createCalls).toBe(1)
      expect(provider.prepareCalls).toBe(2)
    })

    test("keeps probe active and distinct from ordinary get semantics", async () => {
      const { client, provider, backend } = await fixture(mode)
      await client.createSandbox({}, { idempotencyKey: "probe", signal })
      const before = provider.inspectSandboxCalls
      const get = await backend.fetch(new Request(new URL(`/v1/sandboxes/${sandboxId}`, backend.origin), { signal }))
      expect(get.status).toBe(200)
      expect(provider.inspectSandboxCalls).toBe(before)
      await client.probeSandbox({ sandboxId }, { signal })
      expect(provider.inspectSandboxCalls).toBe(before + 1)
      provider.sandboxStates.set(sandboxId, "failed")
      expect((await client.probeSandbox({ sandboxId }, { signal })).state).toBe("failed")
    })

    test("probe prepares referenced provisioning and retains canonical recovery on preparation failure", async () => {
      for (const failure of [false, true]) {
        const directory = await mkdtemp(join(tmpdir(), `waterbox-${mode}-probe-provisioning-`))
        cleanup.push(() => rm(directory, { recursive: true, force: true }))
        const sqlitePath = join(directory, "state.sqlite")
        await seedProvisioning(sqlitePath)
        const provider = new ConformanceProvider(ephemeralRecipient, conformanceArtifact)
        provider.sandboxStates.set(sandboxId, "running")
        if (failure) provider.prepareError = new ProviderError("failure", "private-probe-prepare-detail")
        const { client } = await fixture(mode, { provider, sqlitePath, ids: new SequenceIdGenerator([]) })
        if (failure) {
          const error = await client.probeSandbox({ sandboxId }, { signal }).catch(value => value)
          expect(error).toMatchObject({ code: "provider_failure", recoverySandboxId: sandboxId, requestId: expect.any(String) })
          expect(String(error)).not.toContain("private-probe-prepare-detail")
        } else {
          expect(await client.probeSandbox({ sandboxId }, { signal })).toMatchObject({ sandboxId, state: "running" })
        }
        expect(provider.inspectSandboxCalls).toBe(1)
        expect(provider.prepareCalls).toBe(1)
      }
    })

    test("handles split/multiple NDJSON and rejects empty, malformed, and post-terminal streams", async () => {
      const terminal = JSON.stringify({ type: "result", title: "Read", output: "alpha", metadata: { filePath: "/workspace/a", offset: 1 } })
      const cases: Array<{ body: string; ok: boolean }> = [
        { body: `${JSON.stringify({ type: "result", title: "Read", output: "alpha", metadata: { filePath: "/workspace/a", offset: 1 } })}\n`, ok: true },
        { body: `${JSON.stringify({ type: "result", title: "Read", output: "alpha", metadata: { filePath: "/workspace/a", offset: 1 } })}\n${terminal}\n`, ok: false },
        { body: "", ok: false }, { body: "{malformed}\n", ok: false },
      ]
      for (const item of cases) {
        let cancelled = false
        const { client } = await fixture(mode, { decorate(response, request) {
          if (!request.url.endsWith("/tools/read")) return response
          const bytes = new TextEncoder().encode(item.body)
          return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 3)); controller.enqueue(bytes.slice(3)); if (item.ok || item.body === "") controller.close() }, cancel() { cancelled = true } }), { headers: { "content-type": "application/x-ndjson" } })
        } })
        await client.createSandbox({}, { idempotencyKey: `ndjson-${cases.indexOf(item)}`, signal })
        const result = client.read({ sandboxId, filePath: "/workspace/a" }, { signal })
        if (item.ok) expect((await result).output).toBe("alpha")
        else { await expect(result).rejects.toBeInstanceOf(WaterboxClientError); expect(cancelled || item.body === "").toBeTrue() }
        await client.close()
      }
    })

    test("observes dispatched Bash offsets/progress/cleanup and returns fallback receipts", async () => {
      const provider = new ConformanceProvider(ephemeralRecipient, conformanceArtifact); provider.bashMode = "dispatched"
      const { client } = await fixture(mode, { provider })
      await client.createSandbox({}, { idempotencyKey: "bash-dispatched", signal })
      let progress = 0
      expect(await client.bash({ sandboxId, command: "printf done" }, { signal, onProgress() { progress++ } })).toMatchObject({ outcome: "completed", output: "observed" })
      expect(provider.bashOffsets).toEqual([0, 0])
      for (let attempt = 0; attempt < 20 && provider.bashCleanups === 0; attempt++) await Bun.sleep(5)
      expect(provider.bashCleanups).toBe(1)
      expect(provider.bashCleanupBeforeTerminal).toBeFalse()
      expect(progress).toBeGreaterThan(0)
      provider.bashMode = "fallback"
      expect(await client.bash({ sandboxId, command: "printf done" }, { signal })).toMatchObject({ outcome: "dispatched" })
      expect(provider.bashCleanups).toBe(1)
      provider.bashMode = "dispatched"; provider.bashOutput = "x".repeat(1_048_577); provider.bashOffsets = []; provider.bashObservations = 0; provider.bashCleanupError = new Error("best-effort cleanup failure")
      expect(await client.bash({ sandboxId, command: "printf done" }, { signal })).toMatchObject({ outcome: "completed", metadata: { outputTruncated: true } })
      expect(provider.bashOffsets.length).toBeGreaterThan(1)
      for (let attempt = 0; attempt < 20 && provider.bashCleanups < 2; attempt++) await Bun.sleep(5)
      expect(provider.bashCleanups).toBe(2)
    })

    test("retains only canonical errors and cancels malformed error bodies", async () => {
      let cancelled = false
      const { client } = await fixture(mode, { decorate(response, request) {
        if (!request.url.endsWith(`/v1/sandboxes/${sandboxId}/probe`)) return response
        return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(MAX_API_ERROR_RESPONSE_BYTES + 1)) }, cancel() { cancelled = true } }), { status: 502, headers: { "content-type": "application/json" } })
      } })
      await client.createSandbox({}, { idempotencyKey: "malformed-error", signal })
      const error = await client.probeSandbox({ sandboxId }, { signal }).catch(value => value)
      expect(error).toBeInstanceOf(WaterboxClientError)
      expect(error).toMatchObject({ status: 502 })
      expect(error.code).toBeUndefined()
      expect(error.requestId).toBeUndefined()
      expect(String(error)).not.toContain("private")
      expect(cancelled).toBeTrue()
    })

    test("keeps secure plaintext local and preserves ambiguous consumption safely", async () => {
      const provider = new ConformanceProvider(ephemeralRecipient, conformanceArtifact); provider.secureConsumeError = new ProviderError("ambiguous_execution", "private-transfer-detail")
      const { client } = await fixture(mode, { provider })
      await client.createSandbox({}, { idempotencyKey: "secure-ambiguous", signal })
      const plaintext = new TextEncoder().encode("never-on-wire")
      const error = await client.sendFileSecurely({ sandboxId, plaintext, targetPath: "/workspace/secret" }, { signal }).catch(value => value)
      expect(error).toMatchObject({ code: "ambiguous_execution", requestId: expect.any(String) })
      expect(String(error)).not.toContain("private-transfer-detail")
      expect(provider.ciphertexts).toHaveLength(1)
      expect(provider.ciphertexts[0]).not.toContain("never-on-wire")
      expect(new TextDecoder().decode(plaintext)).toBe("never-on-wire")
    })
  })
}
