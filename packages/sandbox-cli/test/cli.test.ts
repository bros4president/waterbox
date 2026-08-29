import { afterEach, describe, expect, test } from "bun:test"
import { BashToolEventSchema, ReadToolEventSchema, WriteToolEventSchema } from "@waterbox/contracts"
import { Encrypter } from "age-encryption"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decodeInvocation, encodeInvocation, encodeSecureTransferInput, MAX_DECODED_INVOCATION_BYTES, runCli } from "../src/index.ts"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
async function fixture() { const root = await mkdtemp(join(tmpdir(), "waterbox-cli-")); roots.push(root); return root }
async function invoke(root: string, tool: Parameters<typeof encodeInvocation>[0], args: any) {
  let stdout = "", stderr = ""
  const code = await runCli(["run", encodeInvocation(tool, args)], { workspaceRoot: root, io: { stdout: value => { stdout += value }, stderr: value => { stderr += value } } })
  return { code, stdout, stderr }
}

describe("Waterbox one-shot CLI", () => {
  test("round-trips canonical invocations without exposing JSON to the shell", () => {
    const args = { command: `printf '%s\\n' "$HOME" && echo \`quoted\`\nnext`, workdir: "/workspace" }
    const encoded = encodeInvocation("bash", args)
    expect(encoded).toMatch(/^j1\.[A-Za-z0-9_-]+$/)
    expect(encoded).not.toContain("printf")
    expect(decodeInvocation(encoded)).toEqual({ protocolVersion: 1, tool: "bash", arguments: args })
  })

  test("executes canonical write, read, and buffered bash results", async () => {
    const root = await fixture()
    const written = await invoke(root, "write", { filePath: "a.txt", content: "alpha\n" })
    expect(written.code).toBe(0)
    WriteToolEventSchema.parse(JSON.parse(written.stdout))
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("alpha\n")
    ReadToolEventSchema.parse(JSON.parse((await invoke(root, "read", { filePath: "a.txt" })).stdout))
    const bash = JSON.parse((await invoke(root, "bash", { command: "printf out; printf err >&2" })).stdout)
    expect(BashToolEventSchema.parse(bash).type).toBe("result")
    expect(bash.output).toContain("out")
    expect(bash.output).toContain("err")
  })

  test("strictly rejects malformed, noncanonical, and oversized payloads", async () => {
    const root = await fixture()
    for (const payload of ["j1.", "j1.%%%", "j1.e30", `j1.${"a".repeat(100_000)}`]) {
      let stdout = ""
      expect(await runCli(["run", payload], { workspaceRoot: root, io: { stdout: value => { stdout += value }, stderr: () => {} } })).toBe(2)
      expect(JSON.parse(stdout)).toMatchObject({ type: "error", code: "invalid_invocation" })
    }
    expect(() => encodeInvocation("write", { filePath: "x", content: "x".repeat(MAX_DECODED_INVOCATION_BYTES) })).toThrow()
  })

  test("provides machine-readable health and version commands", async () => {
    const root = await fixture()
    for (const command of ["health", "version"]) {
      let stdout = ""
      expect(await runCli([command], { workspaceRoot: root, io: { stdout: value => { stdout += value }, stderr: () => {} } })).toBe(0)
      expect(JSON.parse(stdout).protocolVersion).toBe(1)
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
