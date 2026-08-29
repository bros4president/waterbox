import {
  MAX_SECURE_CIPHERTEXT_BYTES,
  MAX_SECURE_FILE_BYTES,
  SecureTransferDeliveredSchema,
  SecureTransferInitiatedSchema,
  type SandboxId,
} from "@waterbox/contracts"
import { Encrypter } from "age-encryption"
import { constants } from "node:fs"
import { open, stat } from "node:fs/promises"
import type { McpBackend } from "./backend.ts"

export async function sendFileSecurely(
  backend: McpBackend,
  input: { sandboxId: SandboxId; sourcePath: string; targetPath: string },
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const plaintext = await readLocalFile(input.sourcePath, signal)
  let ciphertext: Uint8Array | undefined
  try {
    const initiated = SecureTransferInitiatedSchema.parse(await backend.initiateSecureFileTransfer(input.sandboxId, signal))
    if (new Date(initiated.expiresAt).getTime() <= Date.now()) throw new Error("Secure transfer expired before encryption")
    const encrypter = new Encrypter()
    encrypter.addRecipient(initiated.publicKey)
    ciphertext = await encrypter.encrypt(plaintext)
    signal.throwIfAborted()
    if (ciphertext.byteLength > MAX_SECURE_CIPHERTEXT_BYTES) throw new Error("Encrypted file is too large")
    const delivered = await backend.consumeSecureFileTransfer(input.sandboxId, initiated.transferId, {
      targetPath: input.targetPath,
      ciphertext: Buffer.from(ciphertext).toString("base64"),
    }, signal)
    return SecureTransferDeliveredSchema.parse(delivered)
  } finally {
    plaintext.fill(0)
    ciphertext?.fill(0)
  }
}

async function readLocalFile(path: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const initial = await stat(path)
  if (!initial.isFile()) throw new Error("Local source must be a regular file")
  const handle = await open(path, constants.O_RDONLY)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error("Local source must be a regular file")
    if (metadata.size > MAX_SECURE_FILE_BYTES) throw new Error("Local source file is too large")
    const bytes = new Uint8Array(MAX_SECURE_FILE_BYTES + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      signal.throwIfAborted()
      const item = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (item.bytesRead === 0) break
      offset += item.bytesRead
    }
    signal.throwIfAborted()
    if (offset > MAX_SECURE_FILE_BYTES) { bytes.fill(0); throw new Error("Local source file is too large") }
    return bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}
