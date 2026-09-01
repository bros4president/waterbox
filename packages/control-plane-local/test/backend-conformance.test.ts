import { afterEach, describe, expect, test } from "bun:test"
import { createEmbeddedApiBackend, createLocalControlPlane } from "@waterbox/control-plane-local"
import { FixedClock, FakeSandboxProvider, SequenceIdGenerator } from "@waterbox/core/test-support"
import type { ProviderConsumeSecureTransferInput, ProviderExecuteInput, ProviderOperationInput } from "@waterbox/core/provider"
import type { SecureTransferDelivered, SecureTransferInitiated, ToolEventByName, ToolName } from "@waterbox/contracts"
import { WaterboxClient, createRemoteApiBackend, type ApiBackend } from "@waterbox/client"

const accountId = "acct_client_conformance"
const bearer = "ephemeral-client-conformance-bearer"
const sandboxId = "sbx_calm-cactus-7k3m"
const secondSandboxId = "sbx_bright-river-4n8p"
const snapshotId = "snap_silver-forest-2p9x"
const signal = new AbortController().signal
const ephemeralRecipient = "age1qckl3yp8ytpej8474nuvzzrg33jnakfyesj8fkyf329hjyn75sgqvxh2sv"
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

class ConformanceProvider extends FakeSandboxProvider {
  readonly ciphertexts: string[] = []
  readonly #recipient: string
  constructor(recipient: string) { super(); this.#recipient = recipient }

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
    return (async function* () { yield results[input.toolName] as unknown as ToolEventByName[N] })()
  }

  protected override async initiateSecureTransfer(_input: ProviderOperationInput): Promise<SecureTransferInitiated> {
    return { transferId: "123e4567-e89b-42d3-a456-426614174000", publicKey: this.#recipient, algorithm: "age-x25519", expiresAt: "2099-01-01T00:00:00.000Z" }
  }

  protected override async consumeSecureTransfer(input: ProviderConsumeSecureTransferInput): Promise<SecureTransferDelivered> {
    this.ciphertexts.push(input.ciphertext)
    return { transferId: input.transferId, targetPath: input.targetPath, bytes: 9 }
  }
}

type Mode = "embedded" | "network"

async function fixture(mode: Mode) {
  const provider = new ConformanceProvider(ephemeralRecipient)
  const config = { sqlitePath: ":memory:", accountId, provider: { kind: "injected" as const, implementation: provider } }
  const internals = { clock: new FixedClock(), ids: new SequenceIdGenerator([sandboxId, secondSandboxId], [snapshotId]) }
  let backend: ApiBackend
  if (mode === "embedded") {
    backend = await createEmbeddedApiBackend(config, internals)
  } else {
    const resolver = { async resolveBearer(value: string | undefined, requestSignal: AbortSignal) { requestSignal.throwIfAborted(); return value === bearer ? { accountId } : undefined } }
    const plane = await createLocalControlPlane(config, resolver, internals)
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: plane.fetch })
    backend = createRemoteApiBackend(`http://127.0.0.1:${server.port}/`, request => {
      const headers = new Headers(request.headers); headers.set("authorization", `Bearer ${bearer}`)
      return fetch(new Request(request, { headers }))
    })
    cleanup.push(async () => { await server.stop(true); await plane.close() })
  }
  const client = new WaterboxClient(backend, { bashObservationIntervalMs: 0, bashCleanupDeadlineMs: 50 })
  cleanup.push(() => client.close())
  return { client, provider }
}

for (const mode of ["embedded", "network"] as const) {
  describe(`${mode} ApiBackend conformance`, () => {
    test("runs the identical complete supported command surface", async () => {
      const { client, provider } = await fixture(mode)
      const created = await client.createSandbox({}, { idempotencyKey: "conformance-create", signal })
      expect(created).toMatchObject({ sandboxId, state: "running" })
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
      expect((await client.deleteSnapshot({ snapshotId }, { signal })).state).toBe("deleted")

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
  })
}
