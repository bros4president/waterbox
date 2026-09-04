import { afterEach, describe, expect, test } from "bun:test"
import { BashToolResultSchema, ReadToolResultSchema, WriteToolResultSchema } from "@waterbox/contracts"
import { Encrypter } from "age-encryption"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decodeInvocation, encodeInvocation, encodeSecureTransferInput, MAX_DECODED_INVOCATION_BYTES, runCli } from "../src/index.ts"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
async function fixture() { const root = await mkdtemp(join(tmpdir(), "waterbox-cli-")); roots.push(root); return root }
async function invoke(root: string, tool: Parameters<typeof encodeInvocation>[0], args: any) {
  let stdout = "", stderr = ""
  const worker = new URL("./async-worker.ts", import.meta.url).pathname
  const code = await runCli(["run", encodeInvocation(tool, args)], {
    workspaceRoot: root,
    ...(tool === "bash" ? { asyncBash: { jobRoot: join(root, "jobs"), workerExecutable: process.execPath, workerArguments: [worker, root, join(root, "jobs")], yieldAfterMs: 2_000 } } : {}),
    io: { stdout: value => { stdout += value }, stderr: value => { stderr += value } },
  })
  return { code, stdout, stderr }
}

describe("Waterbox one-shot CLI", () => {
  test("round-trips canonical invocations without exposing JSON to the shell", () => {
    const args = { command: `printf '%s\\n' "$HOME" && echo \`quoted\`\nnext`, workdir: "/workspace" }
    const encoded = encodeInvocation("bash", args)
    expect(encoded).toMatch(/^j2\.[A-Za-z0-9_-]+$/)
    expect(encoded).not.toContain("printf")
    expect(decodeInvocation(encoded)).toEqual({ protocolVersion: 2, tool: "bash", arguments: args })
  })

  test("executes canonical write, read, and buffered bash results", async () => {
    const root = await fixture()
    const written = await invoke(root, "write", { filePath: "a.txt", content: "alpha\n" })
    expect(written.code).toBe(0)
    WriteToolResultSchema.parse(JSON.parse(written.stdout))
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("alpha\n")
    ReadToolResultSchema.parse(JSON.parse((await invoke(root, "read", { filePath: "a.txt" })).stdout))
    const bash = JSON.parse((await invoke(root, "bash", { command: "printf out; printf err >&2" })).stdout)
    BashToolResultSchema.parse(bash)
    expect(bash.output).toContain("out")
    expect(bash.output).toContain("err")
    expect(bash.outcome).toBe("completed")
  })

  test.skipIf(process.platform === "win32")("always uses a worker and returns quick commands as completed", async () => {
    const root = await fixture()
    const jobRoot = join(root, "jobs")
    const omitted = JSON.parse((await invoke(root, "bash", { command: "printf sync" })).stdout)
    const longDeadline = JSON.parse((await invoke(root, "bash", { command: "printf sync", timeout: 120_000 })).stdout)
    expect(omitted.outcome).toBe("completed")
    expect(longDeadline).toMatchObject({ outcome: "completed", output: "sync", metadata: { timedOut: false } })
    expect(await readdir(jobRoot)).toEqual([])
  })

  test.skipIf(process.platform === "win32")("returns after worker spawn while detached output grows to terminal status", async () => {
    const root = await fixture()
    const jobRoot = join(root, "jobs")
    const dispatcher = join(import.meta.dir, "async-dispatcher.ts")
    const started = Date.now()
    const child = Bun.spawn([process.execPath, dispatcher, root, jobRoot, encodeInvocation("bash", {
      command: "printf first; sleep 0.8; printf second; printf err >&2",
    })], { stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(0)
    expect(Date.now() - started).toBeLessThan(500)
    const receipt = BashToolResultSchema.parse(JSON.parse(await new Response(child.stdout).text()))
    if (receipt.outcome !== "dispatched") throw new Error("Expected receipt")
    const localOutputPath = join(jobRoot, receipt.metadata.jobId, "output.log")
    const localStatusPath = join(jobRoot, receipt.metadata.jobId, "status.json")
    expect("timeout" in receipt.metadata).toBe(false)
    expect(receipt.metadata.outputPath).toBe(`/run/waterbox/bash-jobs/${receipt.metadata.jobId}/output.log`)
    expect(receipt.metadata.statusPath).toBe(`/run/waterbox/bash-jobs/${receipt.metadata.jobId}/status.json`)
    expect(await Bun.file(localOutputPath).exists()).toBe(true)
    const states = new Set<string>()
    let sawFirstWithoutSecond = false
    for (let attempt = 0; attempt < 500; attempt++) {
      const status = JSON.parse(await readFile(localStatusPath, "utf8"))
      states.add(status.state)
      const output = await readFile(localOutputPath, "utf8")
      if (output.includes("first") && !output.includes("second")) sawFirstWithoutSecond = true
      if (status.state === "completed" || status.state === "failed") break
      await Bun.sleep(5)
    }
    expect(sawFirstWithoutSecond).toBe(true)
    expect(states.has("running")).toBe(true)
    expect(JSON.parse(await readFile(localStatusPath, "utf8"))).toMatchObject({ state: "completed" })
    expect(await readFile(localOutputPath, "utf8")).toBe("firstseconderr")
    let offset = 0, collected = ""
    while (true) {
      let stdout = ""
      expect(await runCli(["__internal-bash-observe", receipt.metadata.jobId, String(offset), "4"], {
        workspaceRoot: root, asyncBash: { jobRoot }, io: { stdout: value => { stdout += value }, stderr: () => {} },
      })).toBe(0)
      const sample = JSON.parse(stdout)
      const bytes = Buffer.from(sample.chunkBase64, "base64")
      expect(sample.nextOffset - offset).toBe(bytes.byteLength)
      collected += bytes.toString("utf8")
      offset = sample.nextOffset
      if ((sample.state === "completed" || sample.state === "failed") && offset === sample.outputSize) break
    }
    expect(collected).toBe("firstseconderr")
    let cleanup = ""
    expect(await runCli(["__internal-bash-cleanup", receipt.metadata.jobId], {
      workspaceRoot: root, asyncBash: { jobRoot }, io: { stdout: value => { cleanup += value }, stderr: () => {} },
    })).toBe(0)
    expect(JSON.parse(cleanup)).toEqual({ jobId: receipt.metadata.jobId, cleaned: true })
    expect(await readdir(jobRoot)).toEqual([])
  })

  test.skipIf(process.platform === "win32")("returns nonzero and timed-out workers as completed results", async () => {
    const root = await fixture()
    const nonzero = JSON.parse((await invoke(root, "bash", { command: "printf failed; exit 7", timeout: 120_000 })).stdout)
    expect(nonzero).toMatchObject({ outcome: "completed", output: "failed", metadata: { exitCode: 7, timedOut: false } })
    const timedOut = JSON.parse((await invoke(root, "bash", { command: "sleep 30", timeout: 20 })).stdout)
    expect(timedOut).toMatchObject({ outcome: "completed", metadata: { timedOut: true } })
  })

  test.skipIf(process.platform === "win32")("bounds completed output and removes its private job files", async () => {
    const root = await fixture()
    const result = JSON.parse((await invoke(root, "bash", { command: "yes x | head -c 1100000", timeout: 120_000 })).stdout)
    expect(result).toMatchObject({ outcome: "completed", metadata: { outputTruncated: true } })
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1_048_576)
    expect(await readdir(join(root, "jobs"))).toEqual([])
  })

  test.skipIf(process.platform === "win32")("bounds UTF-8 replacement expansion in completed output", async () => {
    const root = await fixture()
    const result = JSON.parse((await invoke(root, "bash", {
      command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(Buffer.alloc(1048576, 128))'`,
      timeout: 120_000,
    })).stdout)
    expect(result).toMatchObject({ outcome: "completed", metadata: { outputTruncated: true } })
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(1_048_576)
    expect(result.output).toContain("\uFFFD")
  })

  test.skipIf(process.platform === "win32")("leaves the spawned worker and files owned by an aborted wait", async () => {
    const root = await fixture()
    const jobRoot = join(root, "jobs")
    const worker = new URL("./async-worker.ts", import.meta.url).pathname
    const controller = new AbortController()
    const call = runCli(["run", encodeInvocation("bash", { command: "sleep 1; printf survived" })], {
      workspaceRoot: root,
      signal: controller.signal,
      asyncBash: { jobRoot, workerExecutable: process.execPath, workerArguments: [worker, root, jobRoot], yieldAfterMs: 2_000 },
      io: { stdout: () => {}, stderr: () => {} },
    })
    let jobId: string | undefined
    for (let attempt = 0; attempt < 400 && jobId === undefined; attempt += 1) {
      const [candidate] = await readdir(jobRoot).catch(() => [])
      if (candidate !== undefined) {
        try {
          const status = JSON.parse(await readFile(join(jobRoot, candidate, "status.json"), "utf8"))
          if (status.state === "running") jobId = candidate
        } catch {}
      }
      if (jobId === undefined) await Bun.sleep(5)
    }
    expect(jobId).toBeDefined()
    controller.abort()
    expect(await call).toBe(2)
    const outputPath = join(jobRoot, jobId!, "output.log")
    let output = ""
    for (let attempt = 0; attempt < 40 && output !== "survived"; attempt += 1) {
      await Bun.sleep(50)
      output = await readFile(outputPath, "utf8")
    }
    expect(output).toBe("survived")
  })

  test.skipIf(process.platform === "win32")("returns failure and removes files when the detached worker executable cannot spawn", async () => {
    const root = await fixture()
    const jobRoot = join(root, "jobs")
    let stdout = ""
    expect(await runCli(["run", encodeInvocation("bash", { command: "true" })], {
      workspaceRoot: root,
      asyncBash: { jobRoot, workerExecutable: "/missing/waterbox-worker" },
      io: { stdout: value => { stdout += value }, stderr: () => {} },
    })).toBe(1)
    expect(JSON.parse(stdout)).toMatchObject({ type: "error", code: "internal_error" })
    expect(await readdir(jobRoot)).toEqual([])
  })

  test("strictly rejects malformed, noncanonical, and oversized payloads", async () => {
    const root = await fixture()
    for (const payload of ["j1.e30", "j2.", "j2.%%%", "j2.e30", `j2.${"a".repeat(100_000)}`]) {
      let stdout = ""
      expect(await runCli(["run", payload], { workspaceRoot: root, io: { stdout: value => { stdout += value }, stderr: () => {} } })).toBe(2)
      expect(JSON.parse(stdout)).toMatchObject({ type: "error", code: "invalid_invocation" })
    }
    expect(() => encodeInvocation("write", { filePath: "x", content: "x".repeat(MAX_DECODED_INVOCATION_BYTES) })).toThrow()
    for (const argv of [
      ["__internal-bash-observe", "../job_bad", "0", "1"],
      ["__internal-bash-observe", `job_${"a".repeat(32)}`, "-1", "1"],
      ["__internal-bash-observe", `job_${"a".repeat(32)}`, "0", "65537"],
      ["__internal-bash-observe", `job_${"a".repeat(32)}`, "9007199254740992", "1"],
    ]) {
      let stdout = ""
      expect(await runCli(argv, { workspaceRoot: root, io: { stdout: value => { stdout += value }, stderr: () => {} } })).toBe(2)
      expect(JSON.parse(stdout)).toMatchObject({ code: "invalid_invocation" })
    }
  })

  test("provides machine-readable health and version commands", async () => {
    const root = await fixture()
    for (const command of ["health", "version"]) {
      let stdout = ""
      expect(await runCli([command], { workspaceRoot: root, io: { stdout: value => { stdout += value }, stderr: () => {} } })).toBe(0)
      expect(JSON.parse(stdout).protocolVersion).toBe(2)
    }
  })

  test("initiates and consumes one secure file without printing its contents", async () => {
    const root = await fixture()
    const stateRoot = join(root, "transfer-state")
    const transferId = crypto.randomUUID()
    const secureTransfer = { stateRoot, randomUUID: () => transferId, scheduleExpiry: async () => {}, cancelExpiry: async () => {} }
    let initiatedOutput = ""
    expect(await runCli(["transfer-initiate"], { workspaceRoot: root, secureTransfer, io: { stdout: value => { initiatedOutput += value }, stderr: () => {} } })).toBe(0)
    const initiated = JSON.parse(initiatedOutput)
    const secret = "cli-secret-value"
    const encrypter = new Encrypter()
    encrypter.addRecipient(initiated.publicKey)
    const ciphertextPath = `/tmp/waterbox-transfer-${transferId}.age`
    roots.push(ciphertextPath)
    await writeFile(ciphertextPath, await encrypter.encrypt(secret))
    let consumedOutput = ""
    const payload = encodeSecureTransferInput({ transferId, targetPath: "secret.txt", ciphertextPath })
    expect(await runCli(["transfer-consume", payload], { workspaceRoot: root, secureTransfer, io: { stdout: value => { consumedOutput += value }, stderr: () => {} } })).toBe(0)
    expect(consumedOutput).not.toContain(secret)
    expect(await readFile(join(root, "secret.txt"), "utf8")).toBe(secret)
  })
})
