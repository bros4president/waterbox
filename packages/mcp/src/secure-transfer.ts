import { MAX_SECURE_FILE_BYTES, type SandboxId } from "@waterbox/contracts"
import type { CommandContext, WaterboxClient } from "@waterbox/client"
import { constants } from "node:fs"
import { open, stat } from "node:fs/promises"

export async function sendFileSecurely(
  client: WaterboxClient,
  input: { sandboxId: SandboxId; sourcePath: string; targetPath: string },
  context: CommandContext,
) {
  context.signal.throwIfAborted()
  const plaintext = await readLocalFile(input.sourcePath, context.signal)
  try {
    return await client.sendFileSecurely({ sandboxId: input.sandboxId, plaintext, targetPath: input.targetPath }, context)
  } finally {
    plaintext.fill(0)
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
