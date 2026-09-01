import { MAX_SECURE_FILE_BYTES, type SandboxId } from "@waterbox/contracts"
import type { CommandContext, WaterboxClient } from "@waterbox/client"
import { constants } from "node:fs"
import { open, stat } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"

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

interface LocalFileReadOverrides {
  stat?: typeof stat
  open?: typeof open
  allocate?: (size: number) => Uint8Array
}

export async function readLocalFile(path: string, signal: AbortSignal, overrides: LocalFileReadOverrides = {}): Promise<Uint8Array> {
  signal.throwIfAborted()
  const statFile = overrides.stat ?? stat
  const openFile = overrides.open ?? open
  const initial = await statFile(path)
  if (!initial.isFile()) throw new Error("Local source must be a regular file")
  let handle: FileHandle | undefined = await openFile(path, constants.O_RDONLY)
  let bytes: Uint8Array | undefined
  let transferred = false
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error("Local source must be a regular file")
    if (metadata.size > MAX_SECURE_FILE_BYTES) throw new Error("Local source file is too large")
    bytes = (overrides.allocate ?? (size => new Uint8Array(size)))(MAX_SECURE_FILE_BYTES + 1)
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== MAX_SECURE_FILE_BYTES + 1) throw new TypeError("Local source buffer allocation failed")
    let offset = 0
    while (offset < bytes.byteLength) {
      signal.throwIfAborted()
      const item = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (item.bytesRead === 0) break
      offset += item.bytesRead
    }
    signal.throwIfAborted()
    if (offset > MAX_SECURE_FILE_BYTES) throw new Error("Local source file is too large")
    await handle.close()
    handle = undefined
    transferred = true
    return bytes.subarray(0, offset)
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    if (!transferred) bytes?.fill(0)
  }
}
