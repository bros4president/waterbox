import { afterEach, describe, expect, test } from "bun:test"
import { Encrypter } from "age-encryption"
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { consumeSecureFileTransfer, expirePendingSecureTransfer, initiateSecureFileTransfer, RuntimeError, SECURE_TRANSFER_TTL_MS } from "../src/index.ts"

const cleanup: string[] = []
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function fixture(now = new Date("2026-08-29T00:00:00.000Z")) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "waterbox-secure-workspace-"))
  const stateRoot = await mkdtemp(join(tmpdir(), "waterbox-secure-state-"))
  cleanup.push(workspaceRoot, stateRoot)
  const transferId = crypto.randomUUID()
  const options = { workspaceRoot, stateRoot, now: () => now, randomUUID: () => transferId, scheduleExpiry: async () => {}, cancelExpiry: async () => {} }
  const initiated = await initiateSecureFileTransfer(options)
  return { workspaceRoot, stateRoot, transferId, options, initiated }
}

async function encryptedFile(transferId: string, recipient: string, plaintext: Uint8Array) {
  const encrypter = new Encrypter()
  encrypter.addRecipient(recipient)
  const ciphertext = await encrypter.encrypt(plaintext)
  const path = `/tmp/waterbox-transfer-${transferId}.age`
  cleanup.push(path)
  await writeFile(path, ciphertext)
  return path
}

describe("sandbox-side secure file transfer", () => {
  test("generates a transfer ID through the platform Crypto receiver", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "waterbox-secure-workspace-"))
    const stateRoot = await mkdtemp(join(tmpdir(), "waterbox-secure-state-"))
    cleanup.push(workspaceRoot, stateRoot)
    const initiated = await initiateSecureFileTransfer({ workspaceRoot, stateRoot, scheduleExpiry: async () => {} })
    expect(initiated.transferId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("decrypts binary files once and writes a private atomic destination", async () => {
    const value = await fixture()
    const plaintext = new Uint8Array([0, 1, 2, 255, 10])
    const ciphertextPath = await encryptedFile(value.transferId, value.initiated.publicKey, plaintext)
    const delivered = await consumeSecureFileTransfer(value.options, { transferId: value.transferId, targetPath: "profile/secret.bin", ciphertextPath })

    expect(delivered).toEqual({ transferId: value.transferId, targetPath: "profile/secret.bin", bytes: plaintext.byteLength })
    expect(new Uint8Array(await readFile(join(value.workspaceRoot, "profile/secret.bin")))).toEqual(plaintext)
    expect((await stat(join(value.workspaceRoot, "profile/secret.bin"))).mode & 0o777).toBe(0o600)

    const replayPath = await encryptedFile(value.transferId, value.initiated.publicKey, plaintext)
    await expect(consumeSecureFileTransfer(value.options, { transferId: value.transferId, targetPath: "replay", ciphertextPath: replayPath })).rejects.toMatchObject({ status: 409 })
  })

  test("expires keys at the fixed boundary and consumes malformed ciphertext", async () => {
    const createdAt = new Date("2026-08-29T00:00:00.000Z")
    const expired = await fixture(new Date(createdAt.getTime()))
    const expiredPath = await encryptedFile(expired.transferId, expired.initiated.publicKey, new TextEncoder().encode("secret"))
    expired.options.now = () => new Date(createdAt.getTime() + SECURE_TRANSFER_TTL_MS)
    await expect(consumeSecureFileTransfer(expired.options, { transferId: expired.transferId, targetPath: "expired", ciphertextPath: expiredPath })).rejects.toMatchObject({ status: 410 })

    const malformed = await fixture()
    const malformedPath = `/tmp/waterbox-transfer-${malformed.transferId}.age`
    cleanup.push(malformedPath)
    await writeFile(malformedPath, "not age")
    await expect(consumeSecureFileTransfer(malformed.options, { transferId: malformed.transferId, targetPath: "bad", ciphertextPath: malformedPath })).rejects.toBeInstanceOf(RuntimeError)
    const replayPath = await encryptedFile(malformed.transferId, malformed.initiated.publicKey, new TextEncoder().encode("secret"))
    await expect(consumeSecureFileTransfer(malformed.options, { transferId: malformed.transferId, targetPath: "bad", ciphertextPath: replayPath })).rejects.toMatchObject({ status: 409 })
  })

  test("reports timer expiry and allows only one concurrent consumer", async () => {
    const timer = await fixture()
    await rm(join(timer.stateRoot, `${timer.transferId}.json`))
    await writeFile(join(timer.stateRoot, `${timer.transferId}.expired`), "")
    const timerPath = await encryptedFile(timer.transferId, timer.initiated.publicKey, new TextEncoder().encode("secret"))
    await expect(consumeSecureFileTransfer(timer.options, { transferId: timer.transferId, targetPath: "expired", ciphertextPath: timerPath })).rejects.toMatchObject({ status: 410 })

    const concurrent = await fixture()
    const plaintext = new TextEncoder().encode("one winner")
    const firstPath = await encryptedFile(concurrent.transferId, concurrent.initiated.publicKey, plaintext)
    const secondPath = `/tmp/waterbox-transfer-${crypto.randomUUID()}.age`
    cleanup.push(secondPath)
    await writeFile(secondPath, await readFile(firstPath))
    const results = await Promise.allSettled([
      consumeSecureFileTransfer(concurrent.options, { transferId: concurrent.transferId, targetPath: "first", ciphertextPath: firstPath }),
      consumeSecureFileTransfer(concurrent.options, { transferId: concurrent.transferId, targetPath: "second", ciphertextPath: secondPath }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  })

  test("falls back from systemd to a detached expiry scheduler and removes state if scheduling fails", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "waterbox-secure-workspace-"))
    const stateRoot = await mkdtemp(join(tmpdir(), "waterbox-secure-state-"))
    cleanup.push(workspaceRoot, stateRoot)
    const transferId = crypto.randomUUID()
    const scheduled: Array<[string, string, number]> = []
    await initiateSecureFileTransfer({
      workspaceRoot, stateRoot, randomUUID: () => transferId,
      runSystemCommand: async (command) => { expect(command).toBe("systemd-run"); return 1 },
      scheduleDetachedExpiry: async (...value) => { scheduled.push(value) },
    })
    expect(scheduled).toEqual([[join(stateRoot, `${transferId}.json`), join(stateRoot, `${transferId}.expired`), SECURE_TRANSFER_TTL_MS]])
    const failedId = crypto.randomUUID()
    await expect(initiateSecureFileTransfer({
      workspaceRoot, stateRoot, randomUUID: () => failedId,
      runSystemCommand: async () => 1,
      scheduleDetachedExpiry: async () => { throw new Error("detached scheduler unavailable") },
    })).rejects.toThrow("detached scheduler unavailable")
    await expect(stat(join(stateRoot, `${failedId}.json`))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("expires only pending state into a tombstone and never races a claimed one-use transfer", async () => {
    const value = await fixture()
    const statePath = join(value.stateRoot, `${value.transferId}.json`)
    const expiredPath = join(value.stateRoot, `${value.transferId}.expired`)
    expect(await expirePendingSecureTransfer(statePath, expiredPath)).toBeTrue()
    await expect(stat(statePath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await stat(expiredPath)).toBeDefined()

    const claimed = await fixture()
    const claimedState = join(claimed.stateRoot, `${claimed.transferId}.json`)
    await rename(claimedState, join(claimed.stateRoot, `${claimed.transferId}.claimed`))
    expect(await expirePendingSecureTransfer(claimedState, join(claimed.stateRoot, `${claimed.transferId}.expired`))).toBeFalse()
    await expect(stat(join(claimed.stateRoot, `${claimed.transferId}.expired`))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
