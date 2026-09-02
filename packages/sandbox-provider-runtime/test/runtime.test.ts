import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
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

  test("encodes and validates every canonical tool event once", async () => {
    const { infrastructure, backend } = await backendWith(input => {
      const invocation = decodeInvocation(input.script.match(/'([^']+)'$/)?.[1] ?? "")
      const events: Record<string, unknown> = {
        read: { type: "result", title: "read", output: "", metadata: { filePath: "a", offset: 1 } },
        write: { type: "result", title: "write", output: "", metadata: { filePath: "a", bytes: 0 } },
        edit: { type: "result", title: "edit", output: "", metadata: { filePath: "a", replacements: 0, bytes: 0 } },
        patch: { type: "result", title: "patch", output: "", metadata: { added: [], updated: [], deleted: [], moved: [] } },
        glob: { type: "result", title: "glob", output: "", metadata: { pattern: "*", path: ".", count: 0, truncated: false } },
        grep: { type: "result", title: "grep", output: "", metadata: { pattern: "x", path: ".", matches: 0, truncated: false } },
        bash: { type: "result", title: "bash", output: "", outcome: "completed", metadata: { command: "true", workdir: "/workspace", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, outputTruncated: false } },
      }
      return completed(events[invocation.tool]!)
    })
    const inputs = [
      ["read", { filePath: "a" }], ["write", { filePath: "a", content: "" }], ["edit", { filePath: "a", oldString: "a", newString: "b" }], ["patch", { patchText: "x" }], ["glob", { pattern: "*" }], ["grep", { pattern: "x" }], ["bash", { command: "true" }],
    ] as const
    for (const [toolName, arguments_] of inputs) {
      const events = []
      for await (const event of backend.executeTool({ ...sandboxInput, toolName, arguments: arguments_ } as never)) events.push(event)
      expect(events).toHaveLength(1)
    }
    expect(infrastructure.commands).toHaveLength(7)
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
    const first = async (events: AsyncIterable<unknown>) => { for await (const event of events) return event }
    const rejected = backend.executeTool({ ...sandboxInput, toolName: "read", arguments: { filePath: "a" } })
    await expect(first(rejected)).rejects.toMatchObject({ kind: "failure" })
    infrastructure.commandHandler = input => input.script.includes("run") ? { exitCode: null, stdout: new Uint8Array(), stderr: new Uint8Array(), timedOut: true, stdoutTruncated: false, stderrTruncated: false } : completed({})
    const ambiguous = backend.executeTool({ ...sandboxInput, toolName: "read", arguments: { filePath: "a" } })
    await expect(first(ambiguous)).rejects.toMatchObject({ kind: "ambiguous_execution" })
  })

  test("propagates an optional exact snapshot source observation without provider interpretation", async () => {
    const { infrastructure, backend } = await backendWith(() => line("waterbox-bootstrap-ok\n"))
    infrastructure.snapshotSourceObservation = { state: "stopped", providerRef: sandboxInput.providerRef }

    const snapshot = await backend.snapshots?.create({ accountId: "account", snapshotId: "snap_silver-forest-a2" as never, sandboxRef: sandboxInput.providerRef, signal })

    expect(snapshot).toEqual({ state: "ready", providerRef: { fakeSnapshot: "snap_silver-forest-a2" }, sourceSandbox: { state: "stopped", providerRef: sandboxInput.providerRef } })
  })

  test("uses an injected non-interactive path provisioner without a provider branch", async () => {
    const { infrastructure, backend } = await backendWith(input => {
      if (input.script.includes("waterbox-bootstrap-installed")) return line("waterbox-bootstrap-installed\n")
      if (input.script.includes("waterbox-bootstrap")) return line(infrastructure.writes.length === 0 ? "waterbox-bootstrap-incomplete\n" : "waterbox-bootstrap-ok\n")
      throw new Error("unexpected command")
    })
    const runtimeProfile = {
      workspacePath: "/workspace", artifactMode: 0o640 as const,
      persistentPaths: { runtimeDirectory: "/runtime/waterbox", cliPath: "/runtime/waterbox/cli.js", launcherPath: "/runtime/waterbox/launch", manifestPath: "/runtime/waterbox/manifest.json", workspace: "/workspace" },
      ephemeralPaths: { uploadStagingDirectory: "/staging", jobsDirectory: "/run/waterbox/bash-jobs" },
      requires: ["node-24", "rg", "absolute-workspace", "persistent-files", "detached-jobs"] as const,
      executableDiscovery: "PATH then adapter-validated absolute executable" as const,
      privilegeStrategy: "adapter-provided non-interactive capability" as const,
    }
    const configured = new WaterboxSandboxBackend(infrastructure, { artifact, runtimeProfile, pathProvisioner: { provision: profile => `prepare-owned ${profile.persistentPaths.runtimeDirectory} ${profile.ephemeralPaths.jobsDirectory}` } })
    await configured.prepareSandbox(sandboxInput)
    const bootstrap = infrastructure.commands.find(command => command.script.includes("waterbox-bootstrap-installed"))?.script
    expect(bootstrap).toContain("prepare-owned /runtime/waterbox /run/waterbox/bash-jobs")
    expect(bootstrap).toContain("'/runtime/waterbox/cli.js'")
    expect(infrastructure.writes[0]?.path).toMatch(/^\/staging\/waterbox-runtime-/)
  })
})
