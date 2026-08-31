import {
  BashToolEventSchema, EditToolEventSchema, GlobToolEventSchema, GrepToolEventSchema,
  PatchToolEventSchema, ReadToolEventSchema, WriteToolEventSchema,
  SecureTransferDeliveredSchema, SecureTransferInitiatedSchema,
} from "@waterbox/contracts"
import { cleanupAsyncBashJob, consumeSecureFileTransfer, createRuntime, initiateSecureFileTransfer, observeAsyncBashJob, runAsyncBashWorker, runOneShotBash, runtimeErrorStatus, RuntimeError, type OneShotBashOptions, type SecureTransferRuntimeOptions } from "@waterbox/runtime"
import { CLI_PROTOCOL_VERSION, CliProtocolError, decodeInvocation, decodeSecureTransferInput } from "./protocol.ts"

export * from "./protocol.ts"

const eventSchemas = {
  read: ReadToolEventSchema,
  write: WriteToolEventSchema,
  edit: EditToolEventSchema,
  patch: PatchToolEventSchema,
  glob: GlobToolEventSchema,
  grep: GrepToolEventSchema,
  bash: BashToolEventSchema,
} as const

export interface CliIo { stdout(value: string): void; stderr(value: string): void }

export async function runCli(argv: readonly string[], options: { workspaceRoot: string; signal?: AbortSignal; io?: CliIo; secureTransfer?: Omit<SecureTransferRuntimeOptions, "workspaceRoot">; asyncBash?: OneShotBashOptions }): Promise<number> {
  const io = options.io ?? { stdout: value => process.stdout.write(value), stderr: value => process.stderr.write(value) }
  if (argv.length === 1 && argv[0] === "health") {
    io.stdout(`${JSON.stringify({ ok: true, protocolVersion: CLI_PROTOCOL_VERSION, tools: Object.keys(eventSchemas) })}\n`)
    return 0
  }
  if (argv.length === 1 && argv[0] === "version") {
    io.stdout(`${JSON.stringify({ protocolVersion: CLI_PROTOCOL_VERSION })}\n`)
    return 0
  }
  if (argv.length === 2 && argv[0] === "__internal-bash-worker") {
    return await runAsyncBashWorker(argv[1]!, options.asyncBash)
  }
  if (argv.length === 4 && argv[0] === "__internal-bash-observe") {
    if (!/^job_[0-9a-f]{32}$/.test(argv[1]!) || !/^(0|[1-9]\d*)$/.test(argv[2]!) || !/^[1-9]\d*$/.test(argv[3]!)) return writeError(io, 400, "invalid_invocation")
    const offset = Number(argv[2]), maxBytes = Number(argv[3])
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(maxBytes) || maxBytes > 65_536) return writeError(io, 400, "invalid_invocation")
    try {
      const result = await observeAsyncBashJob(argv[1]!, offset, maxBytes, options.asyncBash)
      io.stdout(`${JSON.stringify(result)}\n`)
      return 0
    } catch { return writeError(io, 500, "internal_error") }
  }
  if (argv.length === 2 && argv[0] === "__internal-bash-cleanup") {
    if (!/^job_[0-9a-f]{32}$/.test(argv[1]!)) return writeError(io, 400, "invalid_invocation")
    try {
      io.stdout(`${JSON.stringify({ jobId: argv[1], cleaned: await cleanupAsyncBashJob(argv[1]!, options.asyncBash) })}\n`)
      return 0
    } catch { return writeError(io, 500, "internal_error") }
  }
  if (argv.length === 1 && argv[0] === "transfer-initiate") {
    try {
      const result = await initiateSecureFileTransfer({ workspaceRoot: options.workspaceRoot, ...options.secureTransfer })
      io.stdout(`${JSON.stringify(SecureTransferInitiatedSchema.parse(result))}\n`)
      return 0
    } catch { return writeError(io, 500, "internal_error") }
  }
  if (argv.length === 2 && argv[0] === "transfer-consume") {
    let input
    try { input = decodeSecureTransferInput(argv[1]!) }
    catch { return writeError(io, 400, "invalid_invocation") }
    try {
      const result = await consumeSecureFileTransfer({ workspaceRoot: options.workspaceRoot, ...options.secureTransfer }, input)
      io.stdout(`${JSON.stringify(SecureTransferDeliveredSchema.parse(result))}\n`)
      return 0
    } catch (error) {
      const status = runtimeErrorStatus(error)
      const code = error instanceof RuntimeError && status === 410 ? "transfer_expired" : error instanceof RuntimeError && status === 409 ? "transfer_consumed" : status < 500 ? "transfer_rejected" : "internal_error"
      return writeError(io, status, code)
    }
  }
  if (argv.length !== 2 || argv[0] !== "run") return writeError(io, 400, "invalid_invocation")
  let invocation
  try { invocation = decodeInvocation(argv[1]!) }
  catch { return writeError(io, 400, "invalid_invocation") }
  if (invocation.tool === "bash") {
    try {
      const result = await runOneShotBash(options.workspaceRoot, invocation.arguments, options.signal, options.asyncBash)
      io.stdout(`${JSON.stringify(BashToolEventSchema.parse(result))}\n`)
      return 0
    } catch (error) {
      const status = runtimeErrorStatus(error)
      return writeError(io, status, status < 500 ? "tool_rejected" : "internal_error")
    }
  }
  const runtime = createRuntime({ workspaceRoot: options.workspaceRoot })
  try {
    const result = await runtime.execute(invocation.tool, invocation.arguments, options.signal)
    if (result instanceof ReadableStream) {
      const reader = result.getReader()
      let final: unknown
      while (true) {
        const item = await reader.read()
        if (item.done) break
        const event = BashToolEventSchema.parse(item.value)
        if (event.type === "result") final = event
      }
      if (final === undefined) throw new Error("Bash result missing")
      io.stdout(`${JSON.stringify(final)}\n`)
      return 0
    }
    io.stdout(`${JSON.stringify(eventSchemas[invocation.tool].parse(result))}\n`)
    return 0
  } catch (error) {
    if (error instanceof CliProtocolError) return writeError(io, 400, "invalid_invocation")
    const status = runtimeErrorStatus(error)
    return writeError(io, status, status < 500 ? "tool_rejected" : "internal_error")
  } finally {
    runtime.shutdown()
  }
}

function writeError(io: CliIo, status: number, code: string): number {
  io.stdout(`${JSON.stringify({ protocolVersion: CLI_PROTOCOL_VERSION, type: "error", status, code })}\n`)
  return status < 500 ? 2 : 1
}
