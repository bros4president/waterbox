import { describe, expect, test } from "bun:test"
import { assertCommandInput, assertCommandResult, assertJsonReference, assertTerminalCommandConformance, assertTrustedWriteConformance, assertWriteFileInput, collectOwnedInventory, exerciseInfrastructureLifecycle, FULL_LINUX_RUNTIME_PROFILE, MAX_COMMAND_OUTPUT_BYTES, quotePosixShellWord } from "../src/index.ts"
import { FakeSandboxInfrastructure, PrimitiveError } from "../src/test-support.ts"

const signal = new AbortController().signal
const create = { accountId: "account", sandboxId: "sbx_calm-cactus-a1" as const, idempotencyKey: "operation", signal }

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}

describe("provider-neutral sandbox primitives", () => {
  test("implements exact inspection, bounded terminal commands, trusted writes, and lifecycle groups", async () => {
    const infrastructure = new FakeSandboxInfrastructure()
    const sandbox = await infrastructure.create(create)
    expect((await infrastructure.inspect({ accountId: "account", providerRef: sandbox.providerRef, signal })).state).toBe("running")
    await infrastructure.writeFile({ accountId: "account", providerRef: sandbox.providerRef, path: "/workspace/ciphertext", contents: new Uint8Array([1, 2]), mode: 0o640, signal })
    expect(infrastructure.files.get("/workspace/ciphertext")).toEqual({ contents: new Uint8Array([1, 2]), mode: 0o640 })
    const terminal = await infrastructure.runCommand({ accountId: "account", providerRef: sandbox.providerRef, script: "printf ok", timeoutMs: 1_000, maxStdoutBytes: MAX_COMMAND_OUTPUT_BYTES, signal })
    expect(terminal).toEqual({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), timedOut: false, stdoutTruncated: false, stderrTruncated: false })
    await infrastructure.stopResume.stop({ accountId: "account", providerRef: sandbox.providerRef, signal })
    await expect(infrastructure.snapshots.create({ accountId: "account", providerRef: sandbox.providerRef, snapshotId: "snap_silver-forest-a1" as const, expectedState: "running", signal })).rejects.toBeInstanceOf(PrimitiveError)
    await infrastructure.stopResume.resume({ accountId: "account", providerRef: sandbox.providerRef, signal })
    const snapshot = await infrastructure.snapshots.create({ accountId: "account", providerRef: sandbox.providerRef, snapshotId: "snap_silver-forest-a1" as const, expectedState: "running", signal })
    expect(snapshot.state).toBe("ready")
    expect((await infrastructure.delete({ accountId: "account", providerRef: sandbox.providerRef, signal })).state).toBe("terminated")
  })

  test("rejects unsafe command metadata and revalidates running state at snapshot dispatch", async () => {
    const infrastructure = new FakeSandboxInfrastructure()
    const sandbox = await infrastructure.create(create)
    expect(() => assertCommandInput({ accountId: "account", providerRef: sandbox.providerRef, script: "pwd", cwd: "relative", environment: { "BAD-NAME": "value" }, timeoutMs: 1, signal })).toThrow(TypeError)
    // This exact inspection is stale once a concurrent stop arrives immediately before dispatch.
    await infrastructure.inspect({ accountId: "account", providerRef: sandbox.providerRef, signal })
    infrastructure.beforeSnapshotDispatch = () => { void infrastructure.stopResume.stop({ accountId: "account", providerRef: sandbox.providerRef, signal }) }
    await expect(infrastructure.snapshots.create({ accountId: "account", providerRef: sandbox.providerRef, snapshotId: "snap_silver-forest-a1" as never, expectedState: "running", signal })).rejects.toBeInstanceOf(PrimitiveError)
    expect(infrastructure.snapshotCreateCalls).toBe(1)
  })

  test("rejects null durable sandbox and snapshot references", () => {
    expect(() => assertJsonReference(null)).toThrow(TypeError)
    expect(() => assertJsonReference({ nested: null } as never)).toThrow(TypeError)
    for (const invalid of [undefined, () => undefined, Symbol("ref"), 1n, NaN, Infinity, new Date(), Object.create(null)]) {
      expect(() => assertJsonReference(invalid as never)).toThrow(TypeError)
    }
  })

  test("does not admit a null source snapshot reference at create dispatch", async () => {
    const infrastructure = new FakeSandboxInfrastructure()
    await expect(infrastructure.create({ ...create, sourceSnapshotRef: null as never })).rejects.toThrow(TypeError)
    expect(infrastructure.createInputs).toHaveLength(0)
  })

  test("rejects malformed terminal facts and untrusted file byte shapes", async () => {
    const infrastructure = new FakeSandboxInfrastructure()
    const sandbox = await infrastructure.create(create)
    const command = { accountId: "account", providerRef: sandbox.providerRef, script: "false", timeoutMs: 1, maxStdoutBytes: 1, maxStderrBytes: 1, signal }
    expect(() => assertTerminalCommandConformance(command, { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array(), timedOut: false, stdoutTruncated: false, stderrTruncated: false })).not.toThrow()
    expect(() => assertCommandResult({ exitCode: null, stdout: new Uint8Array(2), stderr: new Uint8Array(), timedOut: true, stdoutTruncated: true, stderrTruncated: false }, command)).toThrow(TypeError)
    expect(() => assertCommandResult({ exitCode: 0, stdout: [] as never, stderr: new Uint8Array(), timedOut: false, stdoutTruncated: false, stderrTruncated: false }, command)).toThrow(TypeError)
    expect(() => assertTrustedWriteConformance({ accountId: "account", providerRef: sandbox.providerRef, path: "/workspace/a", contents: [] as never, signal })).toThrow(TypeError)
  })

  test("uses one script value and quotes every interpolated POSIX shell word", () => {
    expect(quotePosixShellWord("plain value")).toBe("'plain value'")
    expect(quotePosixShellWord("'; touch unsafe #")).toBe("''\"'\"'; touch unsafe #'")
    expect(() => quotePosixShellWord("a\u0000b")).toThrow(TypeError)
  })

  test("settles the capability-based full-Linux profile without Box-specific binaries or sudo", () => {
    expect(FULL_LINUX_RUNTIME_PROFILE).toEqual({
      workspacePath: "/workspace",
      artifactMode: 0o640,
      persistentPaths: {
        runtimeDirectory: "/workspace/.waterbox",
        cliPath: "/workspace/.waterbox/waterbox-cli.js",
        launcherPath: "/workspace/.waterbox/waterbox",
        manifestPath: "/workspace/.waterbox/manifest.json",
        workspace: "/workspace",
      },
      ephemeralPaths: {
        uploadStagingDirectory: "/tmp",
        jobsDirectory: "/run/waterbox/bash-jobs",
      },
      requires: ["node-24", "rg", "absolute-workspace", "persistent-files", "detached-jobs"],
      executableDiscovery: "PATH then adapter-validated absolute executable",
      privilegeStrategy: "adapter-provided non-interactive capability",
    })
  })

  test("shared lifecycle conformance uses no provider transport shape", async () => {
    const infrastructure = new FakeSandboxInfrastructure()
    const result = await exerciseInfrastructureLifecycle(infrastructure, {
      accountId: "account",
      sandboxId: "sbx_blue-river-b2" as never,
      restoredSandboxId: "sbx_warm-meadow-c3" as never,
      snapshotId: "snap_warm-meadow-b2" as never,
      idempotencyKey: "operation",
      signal,
    })
    expect(result.restored.state).toBe("running")
    expect(result.sourceRestored.state).toBe("running")
    expect(infrastructure.createInputs[1]?.sourceSnapshotRef).toEqual({ fakeSnapshot: "snap_warm-meadow-b2" })
    expect(await collectOwnedInventory(infrastructure.inventory.listSandboxes({ accountId: "account", pageSize: 2, signal }), { accountId: "account", pageSize: 2, signal }, () => true)).toHaveLength(2)
    expect(await collectOwnedInventory(infrastructure.inventory.listSnapshots({ accountId: "account", pageSize: 2, signal }), { accountId: "account", pageSize: 2, signal }, () => true)).toEqual([
      { state: "deleted", providerRef: { fakeSnapshot: "snap_warm-meadow-b2" } },
    ])
  })
})
