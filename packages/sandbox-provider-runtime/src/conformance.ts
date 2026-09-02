import type { SandboxId, SnapshotId } from "@waterbox/contracts"
import {
  assertCommandResult,
  assertWriteFileInput,
  type InfrastructureCommandInput,
  type InfrastructureCommandResult,
  type InfrastructureInventoryInput,
  type InfrastructureSandboxObservation,
  type InfrastructureSnapshotObservation,
  type InfrastructureWriteFileInput,
  type SandboxInfrastructure,
} from "./index.ts"

/** Reusable terminal-result conformance, including failure, timeout, and truncation facts. */
export function assertTerminalCommandConformance(input: InfrastructureCommandInput, result: InfrastructureCommandResult): void {
  assertCommandResult(result, input)
  if (result.timedOut && result.exitCode === 0) throw new TypeError("Timed out command cannot report success")
}

/** Reusable trusted-control-plane file conformance. */
export function assertTrustedWriteConformance(input: InfrastructureWriteFileInput): void {
  assertWriteFileInput(input)
}

/**
 * Adapters consume provider pages internally; this helper checks the resulting
 * bounded, exact owned inventory without treating it as a public listing API.
 */
export async function collectOwnedInventory<T extends InfrastructureSandboxObservation | InfrastructureSnapshotObservation>(
  entries: AsyncIterable<T>,
  input: InfrastructureInventoryInput,
  owns: (entry: T) => boolean,
): Promise<T[]> {
  const result: T[] = []
  const identities = new Set<string>()
  for await (const entry of entries) {
    input.signal.throwIfAborted()
    if (!owns(entry)) continue
    const identity = JSON.stringify(entry.providerRef)
    if (identities.has(identity)) throw new TypeError("Inventory repeated an exact resource")
    identities.add(identity)
    result.push(entry)
    if (result.length > input.pageSize) throw new TypeError("Inventory exceeded its page bound")
  }
  return result
}

/**
 * Focused, provider-neutral lifecycle conformance exercise. Provider packages
 * supply isolated identities and assert their transport-specific requests
 * separately; this helper asserts only semantic primitive results.
 */
export async function exerciseInfrastructureLifecycle(
  infrastructure: SandboxInfrastructure,
  input: { accountId: string; sandboxId: SandboxId; restoredSandboxId: SandboxId; snapshotId: SnapshotId; idempotencyKey: string; signal: AbortSignal },
): Promise<{ sandbox: InfrastructureSandboxObservation; restored: InfrastructureSandboxObservation; sourceRestored: InfrastructureSandboxObservation }> {
  const sandbox = await infrastructure.create({
    accountId: input.accountId,
    sandboxId: input.sandboxId,
    idempotencyKey: input.idempotencyKey,
    signal: input.signal,
  })
  const inspected = await infrastructure.inspect({ accountId: input.accountId, providerRef: sandbox.providerRef, signal: input.signal })
  if (inspected.providerRef === null) throw new TypeError("Exact inspection returned no durable reference")
  if (infrastructure.stopResume === undefined || infrastructure.snapshots === undefined) {
    throw new TypeError("The conformance exercise requires stop/resume and snapshots")
  }
  await infrastructure.stopResume.stop({ accountId: input.accountId, providerRef: inspected.providerRef, signal: input.signal })
  const restored = await infrastructure.stopResume.resume({ accountId: input.accountId, providerRef: inspected.providerRef, signal: input.signal })
  const snapshot = await infrastructure.snapshots.create({
    accountId: input.accountId,
    providerRef: restored.providerRef,
    snapshotId: input.snapshotId,
    expectedState: "running",
    signal: input.signal,
  })
  await infrastructure.snapshots.inspect({ accountId: input.accountId, snapshotId: input.snapshotId, providerRef: snapshot.providerRef, signal: input.signal })
  const sourceRestored = await infrastructure.create({
    accountId: input.accountId,
    sandboxId: input.restoredSandboxId,
    idempotencyKey: `${input.idempotencyKey}-from-snapshot`,
    sourceSnapshotRef: snapshot.providerRef,
    signal: input.signal,
  })
  await infrastructure.snapshots.delete({ accountId: input.accountId, snapshotId: input.snapshotId, providerRef: snapshot.providerRef, signal: input.signal })
  const deleted = await infrastructure.delete({ accountId: input.accountId, providerRef: sandbox.providerRef, signal: input.signal })
  if (deleted.state !== "terminated") throw new TypeError("Sandbox delete did not reach terminal absence")
  const restoredDeleted = await infrastructure.delete({ accountId: input.accountId, providerRef: sourceRestored.providerRef, signal: input.signal })
  if (restoredDeleted.state !== "terminated") throw new TypeError("Restored sandbox delete did not reach terminal absence")
  return { sandbox: inspected, restored, sourceRestored }
}
