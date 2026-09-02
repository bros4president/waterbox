import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { SandboxRuntimeArtifact } from "./runtime.ts"

/**
 * Loads the caller-owned packaged CLI artifact before any local composition
 * side effect.  It is shared by every assembled provider; provider adapters
 * only receive the validated bytes and never resolve host paths themselves.
 */
export async function loadSandboxRuntimeArtifact(location: URL, artifactVersion: string): Promise<SandboxRuntimeArtifact> {
  if (!(location instanceof URL) || location.protocol !== "file:") throw new TypeError("Sandbox runtime artifact location is invalid")
  let bytes: Uint8Array
  try { bytes = await readFile(location) } catch { throw new TypeError("Sandbox runtime artifact could not be loaded") }
  return validateSandboxRuntimeArtifact({
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    cliProtocolVersion: 2,
    artifactVersion,
  })
}

export function validateSandboxRuntimeArtifact(value: SandboxRuntimeArtifact): SandboxRuntimeArtifact {
  if (!value || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength < 1 || !/^[a-f0-9]{64}$/.test(value.sha256) || value.cliProtocolVersion !== 2 || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(value.artifactVersion) || createHash("sha256").update(value.bytes).digest("hex") !== value.sha256) throw new TypeError("Sandbox runtime artifact is invalid")
  let text: string
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(value.bytes) } catch { throw new TypeError("Sandbox runtime artifact is invalid") }
  if (!text.startsWith("#!/usr/bin/env node\n")) throw new TypeError("Sandbox runtime artifact is invalid")
  return { bytes: Uint8Array.from(value.bytes), sha256: value.sha256, cliProtocolVersion: 2, artifactVersion: value.artifactVersion }
}
