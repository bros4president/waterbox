import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "@waterbox/cli"
import { decodeInvocation, decodeSecureTransferInput } from "@waterbox/cli/protocol"
import { ProviderError } from "@waterbox/core/provider"
import { FakeSandboxInfrastructure } from "../src/test-support.ts"
import { WaterboxSandboxBackend, type SandboxRuntimeArtifact } from "../src/index.ts"

const signal = new AbortController().signal
const bytes = new TextEncoder().encode("#!/usr/bin/env node\nconsole.log('waterbox')\n")
const artifact: SandboxRuntimeArtifact = { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), cliProtocolVersion: 2, artifactVersion: "0.1.0" }
const sandboxInput = { accountId: "account", providerRef: { fakeSandbox: "sbx_calm-cactus-a1" }, signal } as const
const completed = (stdout: unknown) => ({ exitCode: 0, stdout: new TextEncoder().encode(`${JSON.stringify(stdout)}\n`), stderr: new Uint8Array(), timedOut: false, stdoutTruncated: false, stderrTruncated: false })
const line = (value: string, exitCode = 0) => ({ exitCode, stdout: new TextEncoder().encode(value), stderr: new Uint8Array(), timedOut: false, stdoutTruncated: false, stderrTruncated: false })

async function backendWith(handler: NonNullable<FakeSandboxInfrastructure["commandHandler"]>) {
  const infrastructure = new FakeSandboxInfrastructure()
  await infrastructure.create({ accountId: "account", sandboxId: "sbx_calm-cactus-a1" as never, idempotencyKey: "create", signal })
  infrastructure.commandHandler = handler
  return { infrastructure, backend: new WaterboxSandboxBackend(infrastructure, { artifact }) }
}

describe("shared Waterbox runtime backend", () => {
  test("prepares fresh and stale runtimes verify-first, while an already-current runtime does not upload", async () => {
    let phase: "fresh" | "ready" | "stale" = "fresh"
    const { infrastructure, backend } = await backendWith(input => {
      if (input.script.includes("waterbox-bootstrap-installed")) return line("waterbox-bootstrap-installed\n")
      if (input.script.includes("waterbox-bootstrap")) return line(phase === "ready" ? "waterbox-bootstrap-ok\n" : infrastructure.writes.length < (phase === "stale" ? 2 : 1) ? "waterbox-bootstrap-incomplete\n" : "waterbox-bootstrap-ok\n")
      throw new Error("unexpected runtime command")
    })
    await expect(backend.prepareSandbox(sandboxInput)).resolves.toMatchObject({ state: "running" })
    expect(infrastructure.writes).toHaveLength(1)
    const bootstrap = infrastructure.commands.find(command => command.script.includes("waterbox-bootstrap-installed"))?.script
    expect(bootstrap).toContain("install -d -m 0700 '/run/waterbox/bash-jobs'")
    const launcher = Buffer.from(bootstrap?.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > '\/workspace\/\.waterbox\/waterbox'/)?.[1] ?? "", "base64").toString("utf8")
    expect(launcher).toContain("test -d '/run/waterbox/bash-jobs'")
    phase = "ready"
    await backend.prepareSandbox(sandboxInput)
    expect(infrastructure.writes).toHaveLength(1)
    phase = "stale"
    await backend.prepareSandbox(sandboxInput)
    expect(infrastructure.writes).toHaveLength(2)
    expect(infrastructure.writes.every(write => write.contents.every((byte, index) => byte === bytes[index]))).toBe(true)
  })

  test("repairs a snapshot-restored runtime whose retained manifest names a missing CLI without invoking its hash first", async () => {
    let verifies = 0
    const { infrastructure, backend } = await backendWith(input => {
      if (input.script.includes("waterbox-bootstrap-installed")) return line("waterbox-bootstrap-installed\n")
      if (input.script.includes("waterbox-bootstrap")) {
        verifies++
        if (verifies === 1) {
          // A restored snapshot can retain the manifest while its CLI was
          // removed. Hashing first writes an ENOENT diagnostic to stderr,
          // which safely but incorrectly made the verifier ambiguous.
          expect(input.script.indexOf("! test -f '/workspace/.waterbox/waterbox-cli.js'")).toBeGreaterThan(-1)
          expect(input.script.indexOf("! test -f '/workspace/.waterbox/waterbox-cli.js'")).toBeLessThan(input.script.indexOf("node -e"))
          return line("waterbox-bootstrap-incomplete\n")
        }
        return line("waterbox-bootstrap-ok\n")
      }
      throw new Error("unexpected runtime command")
    })
    await expect(backend.prepareSandbox(sandboxInput)).resolves.toMatchObject({ state: "running" })
    expect(infrastructure.writes).toHaveLength(1)
    expect(infrastructure.commands.filter(command => command.script.includes("waterbox-bootstrap-installed"))).toHaveLength(1)
    expect(verifies).toBe(2)
  })

  test("recovers an ambiguous install only through final verification and never replays a user command", async () => {
    let verifies = 0
    const { infrastructure, backend } = await backendWith(input => {
      if (input.script.includes("waterbox-bootstrap-installed")) throw new ProviderError("ambiguous_execution", "lost result")
      if (input.script.includes("waterbox-bootstrap")) {
        verifies++
        return line(verifies === 1 ? "waterbox-bootstrap-incomplete\n" : "waterbox-bootstrap-ok\n")
      }
      throw new Error("unexpected command")
    })
    await expect(backend.prepareSandbox(sandboxInput)).resolves.toMatchObject({ state: "running" })
    expect(infrastructure.commands.filter(command => command.script.includes("waterbox-bootstrap-installed"))).toHaveLength(1)
    expect(verifies).toBe(2)
  })

  test("leaves an ambiguous upload recoverable by a later verify-first preparation", async () => {
    let writes = 0
    const { infrastructure, backend } = await backendWith(input => {
      if (input.script.includes("waterbox-bootstrap-installed")) return line("waterbox-bootstrap-installed\n")
      if (input.script.includes("waterbox-bootstrap")) return line(writes >= 2 ? "waterbox-bootstrap-ok\n" : "waterbox-bootstrap-incomplete\n")
      throw new Error("unexpected command")
    })
    infrastructure.writeHandler = () => { writes++; if (writes === 1) throw new ProviderError("ambiguous_execution", "upload response lost") }
    await expect(backend.prepareSandbox(sandboxInput)).rejects.toMatchObject({ kind: "ambiguous_execution" })
    await expect(backend.prepareSandbox(sandboxInput)).resolves.toMatchObject({ state: "running" })
    expect(infrastructure.commands.filter(command => command.script.includes("waterbox-bootstrap-installed"))).toHaveLength(1)
  })

  test("encodes and validates every canonical tool result once", async () => {
    const { infrastructure, backend } = await backendWith(input => {
      const invocation = decodeInvocation(input.script.match(/'([^']+)'$/)?.[1] ?? "")
      const events: Record<string, unknown> = {
        read: { title: "read", output: "", metadata: { filePath: "a", offset: 1 } },
        write: { title: "write", output: "", metadata: { filePath: "a", bytes: 0 } },
        edit: { title: "edit", output: "", metadata: { filePath: "a", replacements: 0, bytes: 0 } },
        patch: { title: "patch", output: "", metadata: { added: [], updated: [], deleted: [], moved: [] } },
        glob: { title: "glob", output: "", metadata: { pattern: "*", path: ".", count: 0, truncated: false } },
        grep: { title: "grep", output: "", metadata: { pattern: "x", path: ".", matches: 0, truncated: false } },
        bash: { title: "bash", output: "", outcome: "completed", metadata: { command: "true", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } },
      }
      return completed(events[invocation.tool]!)
    })
    const inputs = [
      ["read", { filePath: "a" }], ["write", { filePath: "a", content: "" }], ["edit", { filePath: "a", oldString: "a", newString: "b" }], ["patch", { patchText: "x" }], ["glob", { pattern: "*" }], ["grep", { pattern: "x" }], ["bash", { command: "true" }],
    ] as const
    for (const [toolName, arguments_] of inputs) {
      await expect(backend.executeTool({ ...sandboxInput, toolName, arguments: arguments_ } as never)).resolves.toMatchObject({ title: toolName, output: "" })
    }
    expect(infrastructure.commands).toHaveLength(7)
  })

  test.skipIf(process.platform === "win32")("parses plain results serialized by the real CLI, including escaped maximum Bash output", async () => {
    const root = await mkdtemp(join(tmpdir(), "waterbox-provider-runtime-"))
    const worker = new URL("../../sandbox-cli/test/async-worker.ts", import.meta.url).pathname
    let yieldAfterMs = 2_000
    try {
      const { backend } = await backendWith(async input => {
        const payload = input.script.match(/'([^']+)'$/)?.[1] ?? ""
        const invocation = decodeInvocation(payload)
        let stdout = ""
        const code = await runCli(["run", payload], {
          workspaceRoot: root,
          asyncBash: { jobRoot: join(root, "jobs"), workerExecutable: process.execPath, workerArguments: [worker, root, join(root, "jobs")], yieldAfterMs },
          io: { stdout: value => { stdout += value }, stderr: () => {} },
        })
        expect(code).toBe(0)
        expect(invocation.tool).toBe("bash")
        return line(stdout)
      })

      await expect(backend.executeTool({ ...sandboxInput, toolName: "bash", arguments: { command: "printf quick" } })).resolves.toMatchObject({ outcome: "completed", output: "quick", metadata: { exitCode: 0 } })
      await expect(backend.executeTool({ ...sandboxInput, toolName: "bash", arguments: { command: "printf failed; exit 7" } })).resolves.toMatchObject({ outcome: "completed", output: "failed", metadata: { exitCode: 7 } })
      yieldAfterMs = 0
      await expect(backend.executeTool({ ...sandboxInput, toolName: "bash", arguments: { command: "sleep 0.1" } })).resolves.toMatchObject({ outcome: "dispatched", metadata: { jobId: expect.stringMatching(/^job_/) } })
      yieldAfterMs = 2_000
      const escaped = await backend.executeTool({ ...sandboxInput, toolName: "bash", arguments: { command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(Buffer.alloc(1048576, 0))'` } })
      expect(escaped).toMatchObject({ outcome: "completed", metadata: { outputTruncated: false } })
      expect(Buffer.byteLength(escaped.output)).toBe(1_048_576)
      expect(escaped.output).toBe("\0".repeat(1_048_576))
      expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThanOrEqual(8 * 1_024 * 1_024)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preserves an ambiguous command dispatch when caller cancellation races it", async () => {
    const controller = new AbortController()
    const { backend } = await backendWith(() => {
      controller.abort(new DOMException("caller left", "AbortError"))
      throw new ProviderError("ambiguous_execution", "response lost")
    })
    await expect(backend.executeTool({ ...sandboxInput, signal: controller.signal, toolName: "read", arguments: { filePath: "a" } })).rejects.toMatchObject({ kind: "ambiguous_execution" })
    await expect(backend.executeTool({ ...sandboxInput, signal: AbortSignal.abort(new DOMException("before dispatch", "AbortError")), toolName: "read", arguments: { filePath: "a" } })).rejects.toMatchObject({ name: "AbortError" })
  })

  test("writes only ciphertext, consumes it once, and composes bounded Bash observation and cleanup", async () => {
    const ciphertext = Buffer.from("ciphertext-only").toString("base64")
    const transferId = "123e4567-e89b-42d3-a456-426614174000"
    let consumed = false
    const { infrastructure, backend } = await backendWith(input => {
      if (input.script.endsWith("transfer-initiate")) return completed({ transferId, publicKey: `age1${"q".repeat(58)}`, algorithm: "age-x25519", expiresAt: "2026-09-01T00:00:00.000Z" })
      if (input.script.includes("transfer-consume")) {
        const encoded = input.script.match(/'([^']+)'$/)?.[1] ?? ""
        const transfer = decodeSecureTransferInput(encoded)
        if (consumed) return line(JSON.stringify({ protocolVersion: 2, type: "error", status: 409, code: "transfer_consumed" }) + "\n", 2)
        consumed = true
        return completed({ transferId: transfer.transferId, targetPath: transfer.targetPath, bytes: 15 })
      }
      if (input.script.includes("__internal-bash-observe")) return completed({ jobId: `job_${"a".repeat(32)}`, state: "completed", chunkBase64: Buffer.from("ok").toString("base64"), nextOffset: 2, outputSize: 2, exitCode: 0, timedOut: false, durationMs: 1 })
      if (input.script.includes("__internal-bash-cleanup")) return completed({ jobId: `job_${"a".repeat(32)}`, cleaned: true })
      throw new Error("unexpected command")
    })
    await backend.secureFileTransfer.initiate(sandboxInput)
    await expect(backend.secureFileTransfer.consume({ ...sandboxInput, transferId, targetPath: "secret", ciphertext })).resolves.toMatchObject({ transferId, targetPath: "secret" })
    await expect(backend.secureFileTransfer.consume({ ...sandboxInput, transferId, targetPath: "secret", ciphertext })).rejects.toMatchObject({ kind: "consumed" })
    expect(infrastructure.writes).toHaveLength(2)
    expect(infrastructure.writes.every(write => Buffer.from(write.contents).toString("base64") === ciphertext)).toBe(true)
    expect(infrastructure.commands.every(command => !command.script.includes(ciphertext))).toBe(true)
    await expect(backend.bashJobs.observe({ ...sandboxInput, jobId: `job_${"a".repeat(32)}`, offset: 0, maxBytes: 2 })).resolves.toMatchObject({ state: "completed", nextOffset: 2 })
    await expect(backend.bashJobs.cleanup({ ...sandboxInput, jobId: `job_${"a".repeat(32)}` })).resolves.toBeUndefined()
  })

  test("maps malformed transfer initiation, optional groups, and definite versus ambiguous tool results safely", async () => {
    const { infrastructure, backend } = await backendWith(input => {
      if (input.script.endsWith("transfer-initiate")) return completed({ transferId: "not-a-transfer" })
      if (input.script.includes("timeout")) return { exitCode: null, stdout: new Uint8Array(), stderr: new Uint8Array(), timedOut: true, stdoutTruncated: false, stderrTruncated: false }
      return line(JSON.stringify({ protocolVersion: 2, type: "error", status: 400, code: "invalid_input" }) + "\n", 2)
    })
    await expect(backend.secureFileTransfer.initiate(sandboxInput)).rejects.toMatchObject({ kind: "failure" })
    expect(await backend.stopResume?.stop(sandboxInput)).toMatchObject({ state: "stopped", providerRef: sandboxInput.providerRef })
    expect(await backend.stopResume?.resume(sandboxInput)).toMatchObject({ state: "running", providerRef: sandboxInput.providerRef })
    const snapshot = await backend.snapshots?.create({ accountId: "account", snapshotId: "snap_silver-forest-a1" as never, sandboxRef: sandboxInput.providerRef, signal })
    expect(snapshot).toMatchObject({ state: "ready", providerRef: { fakeSnapshot: "snap_silver-forest-a1" } })
    const rejected = backend.executeTool({ ...sandboxInput, toolName: "read", arguments: { filePath: "a" } })
    await expect(rejected).rejects.toMatchObject({ kind: "failure" })
    infrastructure.commandHandler = input => input.script.includes("run") ? { exitCode: null, stdout: new Uint8Array(), stderr: new Uint8Array(), timedOut: true, stdoutTruncated: false, stderrTruncated: false } : completed({})
    const ambiguous = backend.executeTool({ ...sandboxInput, toolName: "read", arguments: { filePath: "a" } })
    await expect(ambiguous).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("propagates an optional exact snapshot source observation without provider interpretation", async () => {
    const { infrastructure, backend } = await backendWith(() => line("waterbox-bootstrap-ok\n"))
    infrastructure.snapshotSourceObservation = { state: "stopped", providerRef: sandboxInput.providerRef }

    const snapshot = await backend.snapshots?.create({ accountId: "account", snapshotId: "snap_silver-forest-a2" as never, sandboxRef: sandboxInput.providerRef, signal })

    expect(snapshot).toEqual({ state: "ready", providerRef: { fakeSnapshot: "snap_silver-forest-a2" }, sourceSandbox: { state: "stopped", providerRef: sandboxInput.providerRef } })
  })

  test("uses an injected non-interactive path provisioner without a provider branch", async () => {
    const { infrastructure, backend } = await backendWith(input => {
      if (input.script.startsWith("prepare-workspace")) return line("")
      if (input.script.includes("waterbox-bootstrap-installed")) return line("waterbox-bootstrap-installed\n")
      if (input.script.includes("waterbox-bootstrap")) return line(infrastructure.writes.length === 0 ? "waterbox-bootstrap-incomplete\n" : "waterbox-bootstrap-ok\n")
      throw new Error("unexpected command")
    })
    const runtimeProfile = {
      workspacePath: "/home/user/workspace", artifactMode: 0o640 as const,
      persistentPaths: { runtimeDirectory: "/runtime/waterbox", cliPath: "/runtime/waterbox/cli.js", launcherPath: "/runtime/waterbox/launch", manifestPath: "/runtime/waterbox/manifest.json", workspace: "/home/user/workspace" },
      ephemeralPaths: { uploadStagingDirectory: "/staging", jobsDirectory: "/run/waterbox/bash-jobs" },
      requires: ["node-24", "rg", "absolute-workspace", "persistent-files", "detached-jobs"] as const,
      executableDiscovery: "PATH then adapter-validated absolute executable" as const,
      privilegeStrategy: "adapter-provided non-interactive capability" as const,
    }
    const configured = new WaterboxSandboxBackend(infrastructure, { artifact, runtimeProfile, pathProvisioner: { prepareWorkspace: profile => `prepare-workspace ${profile.workspacePath}`, provision: profile => `prepare-owned ${profile.persistentPaths.runtimeDirectory} ${profile.ephemeralPaths.jobsDirectory}` } })
    await configured.prepareSandbox(sandboxInput)
    expect(infrastructure.commands[0]).toMatchObject({ script: "prepare-workspace /home/user/workspace" })
    expect(infrastructure.commands[0]?.cwd).toBe("/")
    expect(infrastructure.commands.slice(1).every(command => command.cwd === "/home/user/workspace")).toBeTrue()
    const bootstrap = infrastructure.commands.find(command => command.script.includes("waterbox-bootstrap-installed"))?.script
    expect(bootstrap).toContain("prepare-owned /runtime/waterbox /run/waterbox/bash-jobs")
    expect(bootstrap).toContain("'/runtime/waterbox/cli.js'")
    const launcher = Buffer.from(bootstrap?.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > '\/runtime\/waterbox\/launch'/)?.[1] ?? "", "base64").toString("utf8")
    expect(launcher).toContain("cd '/home/user/workspace'")
    expect(infrastructure.writes[0]?.path).toMatch(/^\/staging\/waterbox-runtime-/)
  })
})
