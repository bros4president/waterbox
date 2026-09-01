import { BashToolResultSchema, type BashJobObservation, type DispatchedBashToolResult, type SandboxId } from "@waterbox/contracts"
import type { McpBackend } from "./backend.ts"

const CHUNK_BYTES = 65_536
const MAX_OUTPUT_BYTES = 1_048_576
const OBSERVATION_INTERVAL_MS = 1_000
const CLEANUP_DEADLINE_MS = 5_000

interface ProgressContext {
  signal: AbortSignal
  progressToken?: string | number
  sendNotification(notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message: string } }): Promise<void>
}

export async function absorbBashReceipt(
  backend: McpBackend,
  sandboxId: SandboxId,
  receipt: DispatchedBashToolResult,
  context: ProgressContext,
  intervalMs = OBSERVATION_INTERVAL_MS,
  cleanupDeadlineMs = CLEANUP_DEADLINE_MS,
) {
  if (backend.observeBashJob === undefined || backend.cleanupBashJob === undefined) return receiptResult(receipt)
  let offset = 0
  let retained = ""
  let retainedBytes = 0
  let outputTruncated = false
  const decoder = new TextDecoder("utf-8")
  const stopHeartbeat = startProgressHeartbeat(context, intervalMs)
  try {
    while (true) {
      context.signal.throwIfAborted()
      const sample = await backend.observeBashJob(sandboxId, receipt.metadata.jobId, offset, CHUNK_BYTES, context.signal)
      validateSample(sample, receipt.metadata.jobId, offset)
      const chunk = Buffer.from(sample.chunkBase64, "base64")
      offset = sample.nextOffset
      const terminalAndDrained = (sample.state === "completed" || sample.state === "failed") && offset === sample.outputSize
      const kept = retainDecoded(retained, retainedBytes, outputTruncated, decoder.decode(chunk, { stream: !terminalAndDrained }))
      retained = kept.value
      retainedBytes = kept.bytes
      outputTruncated = kept.truncated
      if (terminalAndDrained) {
        if (sample.error !== undefined || sample.exitCode === undefined || sample.timedOut === undefined || sample.durationMs === undefined) throw new Error("Invalid terminal Bash observation")
        const result = completedResult(receipt, sample, retained, outputTruncated)
        cleanupDetached(signal => backend.cleanupBashJob!(sandboxId, receipt.metadata.jobId, signal), cleanupDeadlineMs)
        return result
      }
      if (chunk.byteLength === 0) await sleep(intervalMs, context.signal)
    }
  } catch {
    return receiptResult(receipt)
  } finally {
    stopHeartbeat()
  }
}

function cleanupDetached(operation: (signal: AbortSignal) => Promise<void>, deadlineMs: number): void {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException("Bash cleanup timed out", "TimeoutError")), deadlineMs)
  timer.unref()
  try {
    void operation(controller.signal).catch(() => undefined).finally(() => clearTimeout(timer))
  } catch {
    clearTimeout(timer)
  }
}

function startProgressHeartbeat(context: ProgressContext, intervalMs: number): () => void {
  if (context.progressToken === undefined) return () => {}
  let stopped = false
  let progress = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    progress += 1
    try {
      await context.sendNotification({ method: "notifications/progress", params: { progressToken: context.progressToken!, progress, message: "Remote operation in progress" } })
    } catch {}
    if (!stopped) timer = setTimeout(() => { void tick() }, intervalMs)
  }
  void tick()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

function retainDecoded(value: string, bytes: number, truncated: boolean, decoded: string): { value: string; bytes: number; truncated: boolean } {
  if (truncated) return { value, bytes, truncated }
  let append = ""
  for (const character of decoded) {
    const size = Buffer.byteLength(character, "utf8")
    if (bytes + size > MAX_OUTPUT_BYTES) return { value: value + append, bytes, truncated: true }
    append += character
    bytes += size
  }
  return { value: value + append, bytes, truncated: false }
}

function validateSample(sample: BashJobObservation, jobId: string, offset: number): void {
  if (sample.jobId !== jobId || !["starting", "running", "completed", "failed"].includes(sample.state)
    || !Number.isSafeInteger(sample.nextOffset) || !Number.isSafeInteger(sample.outputSize)
    || sample.nextOffset < offset || sample.nextOffset > offset + CHUNK_BYTES || sample.outputSize < sample.nextOffset
    || (sample.exitCode !== undefined && sample.exitCode !== null && !Number.isInteger(sample.exitCode))
    || (sample.signal !== undefined && sample.signal !== null && typeof sample.signal !== "string")
    || (sample.timedOut !== undefined && typeof sample.timedOut !== "boolean")
    || (sample.durationMs !== undefined && (!Number.isFinite(sample.durationMs) || sample.durationMs < 0))
    || (sample.error !== undefined && sample.error !== "spawn_failed" && sample.error !== "worker_failed")) throw new Error("Invalid Bash observation")
  const chunk = Buffer.from(sample.chunkBase64, "base64")
  if (chunk.toString("base64") !== sample.chunkBase64 || chunk.byteLength !== sample.nextOffset - offset) throw new Error("Invalid Bash observation")
}

function completedResult(receipt: DispatchedBashToolResult, sample: BashJobObservation, output: string, outputTruncated: boolean) {
  const finalOutput = output || (sample.timedOut ? "Command timed out" : "Command completed without output")
  const metadata = {
    command: receipt.metadata.command,
    ...(receipt.metadata.description === undefined ? {} : { description: receipt.metadata.description }),
    workdir: receipt.metadata.workdir,
    exitCode: sample.exitCode!,
    signal: sample.signal ?? null,
    timedOut: sample.timedOut!,
    aborted: false,
    durationMs: sample.durationMs!,
    outputTruncated,
  }
  const structuredContent = BashToolResultSchema.parse({
    title: receipt.metadata.description ?? "Bash command",
    outcome: "completed",
    output: finalOutput,
    metadata,
  })
  return {
    content: [{ type: "text" as const, text: finalOutput }],
    structuredContent,
    ...(metadata.exitCode !== 0 || metadata.timedOut ? { isError: true } : {}),
  }
}

function receiptResult(receipt: DispatchedBashToolResult) {
  const output = `Observation stopped before completion. Job ${receipt.metadata.jobId} may still be running. Recovery statusPath: ${receipt.metadata.statusPath}\nRecovery outputPath: ${receipt.metadata.outputPath}`
  const structuredContent = BashToolResultSchema.parse({ title: receipt.title, outcome: "dispatched", output, metadata: receipt.metadata })
  return {
    content: [{ type: "text" as const, text: output }],
    structuredContent,
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const timer = setTimeout(done, milliseconds)
    function done() { signal.removeEventListener("abort", abort); resolve() }
    function abort() { clearTimeout(timer); reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")) }
    signal.addEventListener("abort", abort, { once: true })
  })
}
