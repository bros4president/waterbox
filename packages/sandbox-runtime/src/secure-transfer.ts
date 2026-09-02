import {
  MAX_SECURE_CIPHERTEXT_BYTES,
  MAX_SECURE_FILE_BYTES,
  SECURE_TRANSFER_ALGORITHM,
  SecureTransferDeliveredSchema,
  SecureTransferIdSchema,
  SecureTransferInitiatedSchema,
  type SecureTransferDelivered,
  type SecureTransferInitiated,
} from "@waterbox/contracts"
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption"
import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { RuntimeError } from "./runtime.ts"

export const SECURE_TRANSFER_TTL_MS = 10 * 60 * 1_000
const DEFAULT_STATE_ROOT = "/run/waterbox/transfers"
const CIPHERTEXT_PATH = /^\/tmp\/waterbox-transfer-[0-9a-f-]{36}\.age$/
const SYSTEM_COMMAND_TIMEOUT_MS = 30_000
const SYSTEM_COMMAND_KILL_GRACE_MS = 1_000

interface TransferState {
  transferId: string
  identity: string
  expiresAt: string
}

export interface SecureTransferRuntimeOptions {
  workspaceRoot: string
  stateRoot?: string
  now?: () => Date
  randomUUID?: () => string
  scheduleExpiry?: (statePath: string, transferId: string, ttlMs: number) => Promise<void>
  cancelExpiry?: (transferId: string) => Promise<void>
  /** Test seam for the systemd-to-detached expiry fallback. */
  runSystemCommand?: (command: string, arguments_: string[]) => Promise<number>
  /** Test seam for detached expiry scheduling; production uses a detached Node child. */
  scheduleDetachedExpiry?: (statePath: string, expiredPath: string, ttlMs: number) => Promise<void>
  /** Test-only delay override for exercising the real detached fallback child. */
  detachedExpiryDelayMs?: number
}

export async function initiateSecureFileTransfer(options: SecureTransferRuntimeOptions): Promise<SecureTransferInitiated> {
  const now = validNow(options.now)
  const transferId = SecureTransferIdSchema.parse(options.randomUUID ? options.randomUUID() : crypto.randomUUID())
  const identity = await generateX25519Identity()
  const publicKey = await identityToRecipient(identity)
  const expiresAt = new Date(now.getTime() + SECURE_TRANSFER_TTL_MS).toISOString()
  const root = options.stateRoot ?? DEFAULT_STATE_ROOT
  const statePath = resolve(root, `${transferId}.json`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const handle = await open(statePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(JSON.stringify({ transferId, identity, expiresAt } satisfies TransferState), "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await (options.scheduleExpiry ?? ((path, id, ttl) => scheduleExpiry(path, id, ttl, options)))(statePath, transferId, SECURE_TRANSFER_TTL_MS)
  } catch (error) {
    await rm(statePath, { force: true })
    throw error
  }
  return SecureTransferInitiatedSchema.parse({ transferId, publicKey, algorithm: SECURE_TRANSFER_ALGORITHM, expiresAt })
}

export async function consumeSecureFileTransfer(
  options: SecureTransferRuntimeOptions,
  input: { transferId: string; targetPath: string; ciphertextPath: string },
): Promise<SecureTransferDelivered> {
  const transferId = SecureTransferIdSchema.parse(input.transferId)
  if (!CIPHERTEXT_PATH.test(input.ciphertextPath)) throw new RuntimeError(400, "Encrypted transfer path is invalid")
  const root = options.stateRoot ?? DEFAULT_STATE_ROOT
  const statePath = resolve(root, `${transferId}.json`)
  const claimedPath = resolve(root, `${transferId}.claimed`)
  const expiredPath = resolve(root, `${transferId}.expired`)
  let plaintext: Uint8Array | undefined
  let claimed = false
  try {
    try { await rename(statePath, claimedPath); claimed = true }
    catch (error) {
      if (isCode(error, "ENOENT")) {
        try { await rm(expiredPath); throw new RuntimeError(410, "Secure transfer has expired") }
        catch (expiredError) { if (expiredError instanceof RuntimeError) throw expiredError; if (!isCode(expiredError, "ENOENT")) throw expiredError }
        throw new RuntimeError(409, "Secure transfer has already been consumed or does not exist")
      }
      throw error
    }
    const state = parseState(await readFile(claimedPath, "utf8"), transferId)
    if (validNow(options.now).getTime() >= new Date(state.expiresAt).getTime()) throw new RuntimeError(410, "Secure transfer has expired")
    const encrypted = await readRegularFileBounded(input.ciphertextPath, MAX_SECURE_CIPHERTEXT_BYTES)
    const decrypter = new Decrypter()
    decrypter.addIdentity(state.identity)
    try { plaintext = await decrypter.decrypt(encrypted) }
    catch { throw new RuntimeError(400, "Encrypted file could not be decrypted") }
    if (plaintext.byteLength > MAX_SECURE_FILE_BYTES) throw new RuntimeError(413, "Decrypted file is too large")
    const targetPath = await targetFile(options.workspaceRoot, input.targetPath)
    await atomicWriteBytes(targetPath, plaintext)
    return SecureTransferDeliveredSchema.parse({ transferId, targetPath: input.targetPath, bytes: plaintext.byteLength })
  } finally {
    plaintext?.fill(0)
    if (claimed) {
      await (options.cancelExpiry ?? cancelExpiry)(transferId).catch(() => undefined)
      await rm(claimedPath, { force: true })
    }
    await rm(input.ciphertextPath, { force: true })
  }
}

async function scheduleExpiry(statePath: string, transferId: string, ttlMs: number, options: Pick<SecureTransferRuntimeOptions, "runSystemCommand" | "scheduleDetachedExpiry" | "detachedExpiryDelayMs">): Promise<void> {
  const unit = `waterbox-transfer-expire-${transferId}`
  const claimedPath = resolve(dirname(statePath), `${transferId}.claimed`)
  const expiredPath = resolve(dirname(statePath), `${transferId}.expired`)
  const exitCode = await (options.runSystemCommand ?? runSystemCommand)("systemd-run", ["--quiet", "--unit", unit, `--on-active=${Math.ceil(ttlMs / 1_000)}s`, "/bin/sh", "-c", "rm -f -- \"$1\" \"$2\"; : >\"$3\"", "waterbox-expire", statePath, claimedPath, expiredPath])
    .catch(() => -1)
  if (exitCode === 0) return
  // Full-Linux sandbox images do not necessarily run systemd. Fall back to
  // a detached copy of the current Node runtime; it removes state only if a
  // transfer is still pending, so a successful one-use consumption does not
  // later gain an expired tombstone.
  await (options.scheduleDetachedExpiry ?? scheduleDetachedExpiry)(statePath, expiredPath, options.detachedExpiryDelayMs ?? ttlMs)
}

async function scheduleDetachedExpiry(statePath: string, expiredPath: string, ttlMs: number): Promise<void> {
  // Atomic rename claims only the pending state. A consuming caller has
  // already renamed it to `.claimed`, which must never be expired by a late
  // detached timer.
  const program = "const fs=require('node:fs/promises');const [state,expired,delay]=process.argv.slice(1);setTimeout(async()=>{const lease=expired+'.pending';try{await fs.rename(state,lease)}catch(error){if(error&&error.code==='ENOENT')return;return}try{await fs.writeFile(expired,'',{mode:0o600})}finally{await fs.rm(lease,{force:true})}},Number(delay))"
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["-e", program, statePath, expiredPath, String(ttlMs)], { detached: true, stdio: "ignore" })
    child.once("error", reject)
    child.once("spawn", () => { child.unref(); resolvePromise() })
  })
}

/** Deterministic counterpart of the detached timer, used to verify expiry semantics. */
export async function expirePendingSecureTransfer(statePath: string, expiredPath: string): Promise<boolean> {
  const lease = `${expiredPath}.pending`
  try { await rename(statePath, lease) }
  catch (error) { if (isCode(error, "ENOENT")) return false; throw error }
  try { await writeFile(expiredPath, "", { mode: 0o600 }) }
  finally { await rm(lease, { force: true }) }
  return true
}

async function cancelExpiry(transferId: string): Promise<void> {
  const unit = `waterbox-transfer-expire-${transferId}`
  await runSystemCommand("systemctl", ["stop", `${unit}.timer`, `${unit}.service`])
}

async function runSystemCommand(command: string, arguments_: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: "ignore" })
    let settled = false
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), SYSTEM_COMMAND_KILL_GRACE_MS)
      killTimer.unref()
    }, SYSTEM_COMMAND_TIMEOUT_MS)
    timeout.unref()
    const settle = (operation: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      operation()
    }
    child.once("error", (error) => settle(() => reject(error)))
    child.once("close", (code) => settle(() => timedOut ? reject(new Error("System command timed out")) : resolvePromise(code ?? 1)))
  })
}

async function readRegularFileBounded(path: string, maximum: number): Promise<Uint8Array> {
  const initial = await stat(path)
  if (!initial.isFile()) throw new RuntimeError(400, "Encrypted transfer must be a regular file")
  const handle = await open(path, "r")
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new RuntimeError(400, "Encrypted transfer must be a regular file")
    if (metadata.size > maximum) throw new RuntimeError(413, "Encrypted transfer is too large")
    return await readHandleBounded(handle, maximum)
  } finally {
    await handle.close()
  }
}

async function readHandleBounded(handle: Awaited<ReturnType<typeof open>>, maximum: number): Promise<Uint8Array> {
  const output = new Uint8Array(maximum + 1)
  let offset = 0
  while (offset < output.byteLength) {
    const item = await handle.read(output, offset, output.byteLength - offset, offset)
    if (item.bytesRead === 0) break
    offset += item.bytesRead
  }
  if (offset > maximum) { output.fill(0); throw new RuntimeError(413, "Encrypted transfer is too large") }
  return output.slice(0, offset)
}

async function targetFile(workspaceRoot: string, requested: string): Promise<string> {
  const lexical = isAbsolute(requested) ? resolve(requested) : resolve(workspaceRoot, requested)
  try {
    const existing = await realpath(lexical)
    if (!(await stat(existing)).isFile()) throw new RuntimeError(400, "Target path must refer to a regular file")
    return existing
  } catch (error) {
    if (isCode(error, "ENOENT")) return lexical
    throw error
  }
}

async function atomicWriteBytes(target: string, content: Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temporary = resolve(dirname(target), `.${process.pid}-${crypto.randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, target)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function parseState(value: string, transferId: string): TransferState {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new RuntimeError(500, "Secure transfer state is invalid") }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RuntimeError(500, "Secure transfer state is invalid")
  const state = parsed as Record<string, unknown>
  if (Object.keys(state).length !== 3 || state.transferId !== transferId || typeof state.identity !== "string" || !state.identity.startsWith("AGE-SECRET-KEY-1") || typeof state.expiresAt !== "string" || !Number.isFinite(new Date(state.expiresAt).getTime())) throw new RuntimeError(500, "Secure transfer state is invalid")
  return state as unknown as TransferState
}

function validNow(factory: (() => Date) | undefined): Date {
  const value = (factory ?? (() => new Date()))()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new RuntimeError(500, "Secure transfer clock is invalid")
  return value
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}
