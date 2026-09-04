import {
  BashJobObservationSchema,
  BashToolArgumentsSchema,
  BashToolResultSchema,
  CreateSandboxRequestSchema,
  CreateSnapshotRequestSchema,
  CursorPaginationRequestSchema,
  EditToolArgumentsSchema,
  EditToolResultSchema,
  ErrorEnvelopeSchema,
  GlobToolArgumentsSchema,
  GlobToolResultSchema,
  GrepToolArgumentsSchema,
  GrepToolResultSchema,
  IdempotencyKeySchema,
  MAX_SECURE_CIPHERTEXT_BYTES,
  MAX_SECURE_FILE_BYTES,
  MAX_BASH_OUTPUT_BYTES,
  MAX_TOOL_RESULT_BYTES,
  PatchToolArgumentsSchema,
  PatchToolResultSchema,
  ReadToolArgumentsSchema,
  ReadToolResultSchema,
  SandboxIdSchema,
  SandboxSchema,
  SnapshotIdSchema,
  SnapshotPageSchema,
  SnapshotSchema,
  SecureTransferDeliveredSchema,
  SecureTransferInitiatedSchema,
  SecureTransferConsumeRequestSchema,
  WriteToolArgumentsSchema,
  WriteToolResultSchema,
  type BashJobObservation,
  type BashToolArguments,
  type BashToolResult,
  type CompletedBashToolResult,
  type CreateSandboxRequest,
  type CreateSnapshotRequest,
  type CursorPaginationRequest,
  type DispatchedBashToolResult,
  type EditToolArguments,
  type EditToolResult,
  type ErrorCode,
  type GlobToolArguments,
  type GlobToolResult,
  type GrepToolArguments,
  type GrepToolResult,
  type PatchToolArguments,
  type PatchToolResult,
  type ReadToolArguments,
  type ReadToolResult,
  type Sandbox,
  type SandboxId,
  type Snapshot,
  type SnapshotId,
  type SnapshotPage,
  type ToolName,
  type WriteToolArguments,
  type WriteToolResult,
} from "@waterbox/contracts"
import { Encrypter } from "age-encryption"
import type { z } from "zod"

export const MAX_API_ERROR_RESPONSE_BYTES = 65_536
export const MAX_API_JSON_RESPONSE_BYTES = 1_048_576
// Two 1 MiB command streams can expand to 6 MiB when escaped as JSON strings.
export const MAX_API_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_BYTES

const BASH_CHUNK_BYTES = 65_536
const BASH_OBSERVATION_INTERVAL_MS = 1_000
const BASH_CLEANUP_DEADLINE_MS = 5_000

export interface ApiBackend {
  readonly origin: URL
  fetch(request: Request): Promise<Response>
  close(): Promise<void>
}

export interface WaterboxCommandProgress {
  readonly kind: "heartbeat"
  readonly sequence: number
}

export interface CommandContext {
  readonly signal: AbortSignal
  readonly onProgress?: (progress: WaterboxCommandProgress) => void | Promise<void>
}

export interface CreateSandboxContext extends CommandContext {
  readonly idempotencyKey: string
}

export interface PublicWaterboxClientError extends Error {
  readonly status?: number
  readonly code?: ErrorCode
  readonly requestId?: string
  readonly recoverySandboxId?: SandboxId
}

export interface PublicWaterboxClientErrorDetails {
  readonly message: string
  readonly status?: number
  readonly code?: ErrorCode
  readonly requestId?: string
  readonly recoverySandboxId?: SandboxId
}

const publicClientErrors = new WeakMap<Error, PublicWaterboxClientErrorDetails>()

/**
 * An ordinary client error is intentionally not agent-visible. Only errors
 * branded by this module after API-envelope validation pass the public guard.
 */
export class WaterboxClientError extends Error implements PublicWaterboxClientError {
  readonly status?: number
  readonly code?: ErrorCode
  readonly requestId?: string
  readonly recoverySandboxId?: SandboxId

  constructor(message: string, options: { status?: number; code?: ErrorCode; requestId?: string; recoverySandboxId?: SandboxId } = {}) {
    super(message)
    this.name = "WaterboxClientError"
    this.status = options.status
    this.code = options.code
    this.requestId = options.requestId
    this.recoverySandboxId = options.recoverySandboxId
  }
}

function clientError(message: string, options: { status?: number; code?: ErrorCode; requestId?: string; recoverySandboxId?: SandboxId } = {}): WaterboxClientError {
  const error = new WaterboxClientError(message, options)
  publicClientErrors.set(error, Object.freeze({ message, ...options }))
  return error
}

export function isPublicWaterboxClientError(error: unknown): error is PublicWaterboxClientError {
  return error instanceof Error && publicClientErrors.has(error)
}

export function publicWaterboxClientErrorMessage(error: unknown): string | undefined {
  return publicWaterboxClientErrorDetails(error)?.message
}

export function publicWaterboxClientRecoverySandboxId(error: unknown): SandboxId | undefined {
  return publicWaterboxClientErrorDetails(error)?.recoverySandboxId
}

export function publicWaterboxClientErrorDetails(error: unknown): PublicWaterboxClientErrorDetails | undefined {
  return error instanceof Error ? publicClientErrors.get(error) : undefined
}

export function createRemoteApiBackend(origin: string | URL, authenticatedFetch: (request: Request) => Promise<Response>): ApiBackend {
  const parsed = validateOrigin(origin)
  let closed = false
  return {
    get origin() { return new URL(parsed) },
    fetch(request) {
      if (closed) return Promise.reject(clientError("The Waterbox API backend is closed"))
      return authenticatedFetch(request)
    },
    async close() { closed = true },
  }
}

export interface WaterboxClientOptions {
  bashObservationIntervalMs?: number
  bashCleanupDeadlineMs?: number
}

export class WaterboxClient {
  readonly #backend: ApiBackend
  readonly #origin: URL
  readonly #observationIntervalMs: number
  readonly #cleanupDeadlineMs: number
  #closePromise?: Promise<void>

  constructor(backend: ApiBackend, options: WaterboxClientOptions = {}) {
    this.#backend = backend
    this.#origin = validateOrigin(backend.origin)
    this.#observationIntervalMs = nonnegativeDuration(options.bashObservationIntervalMs, BASH_OBSERVATION_INTERVAL_MS)
    this.#cleanupDeadlineMs = nonnegativeDuration(options.bashCleanupDeadlineMs, BASH_CLEANUP_DEADLINE_MS)
  }

  close(): Promise<void> {
    return this.#closePromise ??= Promise.resolve().then(() => this.#backend.close())
  }

  async createSandbox(input: CreateSandboxRequest, context: CreateSandboxContext): Promise<Sandbox> {
    const body = CreateSandboxRequestSchema.parse(input)
    const key = IdempotencyKeySchema.parse(context.idempotencyKey)
    return this.#json("POST", "/v1/sandboxes", 201, SandboxSchema, context.signal, body, { "Idempotency-Key": key })
  }

  probeSandbox(input: { sandboxId: SandboxId }, context: CommandContext): Promise<Sandbox> {
    return this.#json("POST", `/v1/sandboxes/${sandboxPath(input.sandboxId)}/probe`, 200, SandboxSchema, context.signal)
  }

  stopSandbox(input: { sandboxId: SandboxId }, context: CommandContext): Promise<Sandbox> {
    return this.#json("POST", `/v1/sandboxes/${sandboxPath(input.sandboxId)}/stop`, 200, SandboxSchema, context.signal)
  }

  deleteSandbox(input: { sandboxId: SandboxId }, context: CommandContext): Promise<Sandbox> {
    return this.#json("DELETE", `/v1/sandboxes/${sandboxPath(input.sandboxId)}`, 200, SandboxSchema, context.signal)
  }

  listSnapshots(input: CursorPaginationRequest, context: CommandContext): Promise<SnapshotPage> {
    const query = CursorPaginationRequestSchema.parse(input)
    const parameters = new URLSearchParams()
    if (query.cursor !== undefined) parameters.set("cursor", query.cursor)
    if (query.limit !== undefined) parameters.set("limit", String(query.limit))
    const suffix = parameters.size === 0 ? "" : `?${parameters}`
    return this.#json("GET", `/v1/snapshots${suffix}`, 200, SnapshotPageSchema, context.signal)
  }

  createSnapshot(input: CreateSnapshotRequest & { sandboxId: SandboxId }, context: CommandContext): Promise<Snapshot> {
    const { sandboxId, ...request } = input
    return this.#json("POST", `/v1/sandboxes/${sandboxPath(sandboxId)}/snapshots`, 201, SnapshotSchema, context.signal, CreateSnapshotRequestSchema.parse(request))
  }

  deleteSnapshot(input: { snapshotId: SnapshotId }, context: CommandContext): Promise<Snapshot> {
    return this.#json("DELETE", `/v1/snapshots/${encodeURIComponent(SnapshotIdSchema.parse(input.snapshotId))}`, 200, SnapshotSchema, context.signal)
  }

  read(input: ReadToolArguments & { sandboxId: SandboxId }, context: CommandContext): Promise<ReadToolResult> {
    const { sandboxId, ...arguments_ } = input
    return this.#tool("read", sandboxId, ReadToolArgumentsSchema.parse(arguments_), ReadToolResultSchema, context)
  }
  write(input: WriteToolArguments & { sandboxId: SandboxId }, context: CommandContext): Promise<WriteToolResult> {
    const { sandboxId, ...arguments_ } = input
    return this.#tool("write", sandboxId, WriteToolArgumentsSchema.parse(arguments_), WriteToolResultSchema, context)
  }
  edit(input: EditToolArguments & { sandboxId: SandboxId }, context: CommandContext): Promise<EditToolResult> {
    const { sandboxId, ...arguments_ } = input
    return this.#tool("edit", sandboxId, EditToolArgumentsSchema.parse(arguments_), EditToolResultSchema, context)
  }
  patch(input: PatchToolArguments & { sandboxId: SandboxId }, context: CommandContext): Promise<PatchToolResult> {
    const { sandboxId, ...arguments_ } = input
    return this.#tool("patch", sandboxId, PatchToolArgumentsSchema.parse(arguments_), PatchToolResultSchema, context)
  }
  glob(input: GlobToolArguments & { sandboxId: SandboxId }, context: CommandContext): Promise<GlobToolResult> {
    const { sandboxId, ...arguments_ } = input
    return this.#tool("glob", sandboxId, GlobToolArgumentsSchema.parse(arguments_), GlobToolResultSchema, context)
  }
  grep(input: GrepToolArguments & { sandboxId: SandboxId }, context: CommandContext): Promise<GrepToolResult> {
    const { sandboxId, ...arguments_ } = input
    return this.#tool("grep", sandboxId, GrepToolArgumentsSchema.parse(arguments_), GrepToolResultSchema, context)
  }

  async bash(input: BashToolArguments & { sandboxId: SandboxId }, context: CommandContext): Promise<BashToolResult> {
    const { sandboxId, ...arguments_ } = input
    const receipt = await this.#tool("bash", sandboxId, BashToolArgumentsSchema.parse(arguments_), BashToolResultSchema, context) as BashToolResult
    if (receipt.outcome === "completed") return receipt
    return this.#observeBash(sandboxId, receipt, context)
  }

  async sendFileSecurely(input: { sandboxId: SandboxId; plaintext: Uint8Array; targetPath: string }, context: CommandContext) {
    context.signal.throwIfAborted()
    const sandboxId = SandboxIdSchema.parse(input.sandboxId)
    if (!(input.plaintext instanceof Uint8Array) || input.plaintext.byteLength > MAX_SECURE_FILE_BYTES) {
      throw clientError("Secure transfer plaintext is too large")
    }
    const plaintext = input.plaintext.slice()
    let ciphertext: Uint8Array | undefined
    try {
      const initiated = await this.#json("POST", `/v1/sandboxes/${sandboxPath(sandboxId)}/secure-file-transfers`, 201, SecureTransferInitiatedSchema, context.signal)
      if (Date.parse(initiated.expiresAt) <= Date.now()) throw clientError("Secure transfer expired before encryption")
      const encrypter = new Encrypter()
      encrypter.addRecipient(initiated.publicKey)
      ciphertext = await encrypter.encrypt(plaintext)
      context.signal.throwIfAborted()
      if (ciphertext.byteLength > MAX_SECURE_CIPHERTEXT_BYTES) throw clientError("Encrypted file is too large")
      const consumption = SecureTransferConsumeRequestSchema.parse({
        targetPath: input.targetPath,
        ciphertext: bytesToBase64(ciphertext),
      })
      return await this.#json("PUT", `/v1/sandboxes/${sandboxPath(sandboxId)}/secure-file-transfers/${encodeURIComponent(initiated.transferId)}`, 200, SecureTransferDeliveredSchema, context.signal, consumption)
    } finally {
      plaintext.fill(0)
      ciphertext?.fill(0)
    }
  }

  async #tool<N extends ToolName, S extends z.ZodType>(
    name: N, sandboxId: SandboxId, input: unknown, schema: S, context: CommandContext,
  ): Promise<z.output<S>> {
    const response = await this.#request("POST", `/v1/sandboxes/${sandboxPath(sandboxId)}/tools/${name}`, context.signal, input)
    await requireStatus(response, 200, context.signal)
    await propagateResponseAbort(response, context.signal)
    if (!hasMediaType(response, "application/json")) { await cancelBody(response); throw protocolError() }
    let value: unknown
    try { value = await parseJson(response, MAX_API_TOOL_RESULT_BYTES, context.signal) }
    catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error
      throw protocolError()
    }
    const result = schema.safeParse(value)
    if (!result.success) throw protocolError()
    return result.data
  }

  async #observeBash(sandboxId: SandboxId, receipt: DispatchedBashToolResult, context: CommandContext): Promise<BashToolResult> {
    let offset = 0
    let output = ""
    let outputBytes = 0
    let truncated = false
    const decoder = new TextDecoder("utf-8")
    const stopProgress = startProgress(context, this.#observationIntervalMs)
    try {
      while (true) {
        context.signal.throwIfAborted()
        const sample = await this.#json("POST", `/v1/sandboxes/${sandboxPath(sandboxId)}/bash-jobs/${encodeURIComponent(receipt.metadata.jobId)}/observations`, 200, BashJobObservationSchema, context.signal, { offset, maxBytes: BASH_CHUNK_BYTES })
        validateObservation(sample, receipt.metadata.jobId, offset)
        const chunk = base64ToBytes(sample.chunkBase64)
        offset = sample.nextOffset
        const drained = (sample.state === "completed" || sample.state === "failed") && offset === sample.outputSize
        const retained = retainUtf8(output, outputBytes, truncated, decoder.decode(chunk, { stream: !drained }))
        output = retained.output; outputBytes = retained.bytes; truncated = retained.truncated
        if (drained) {
          if (sample.error !== undefined || sample.exitCode === undefined || sample.timedOut === undefined || sample.durationMs === undefined) throw protocolError()
          const result = completedBash(receipt, sample, output, truncated)
          this.#cleanupDetached(sandboxId, receipt.metadata.jobId)
          return result
        }
        if (chunk.byteLength === 0) await sleep(this.#observationIntervalMs, context.signal)
      }
    } catch {
      return receiptFallback(receipt)
    } finally {
      stopProgress()
    }
  }

  #cleanupDetached(sandboxId: SandboxId, jobId: string): void {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException("Bash cleanup timed out", "TimeoutError")), this.#cleanupDeadlineMs)
    timer.unref?.()
    try {
      void this.#request("DELETE", `/v1/sandboxes/${sandboxPath(sandboxId)}/bash-jobs/${encodeURIComponent(jobId)}`, controller.signal)
        .then(async response => { await requireStatus(response, 204, controller.signal); await cancelBody(response) })
        .catch(() => undefined).finally(() => clearTimeout(timer))
    } catch { clearTimeout(timer) }
  }

  async #json<T>(method: string, path: string, expectedStatus: number, schema: z.ZodType<T>, signal: AbortSignal, body?: unknown, headers?: HeadersInit): Promise<T> {
    const response = await this.#request(method, path, signal, body, headers)
    await requireStatus(response, expectedStatus, signal)
    await propagateResponseAbort(response, signal)
    if (!hasMediaType(response, "application/json")) { await cancelBody(response); throw protocolError() }
    let value: unknown
    try { value = await parseJson(response, MAX_API_JSON_RESPONSE_BYTES, signal) }
    catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      throw protocolError()
    }
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw protocolError()
    return parsed.data
  }

  async #request(method: string, path: string, signal: AbortSignal, body?: unknown, headers?: HeadersInit): Promise<Response> {
    signal.throwIfAborted()
    const requestHeaders = new Headers(headers)
    let serialized: string | undefined
    if (body !== undefined) { requestHeaders.set("Content-Type", "application/json"); serialized = JSON.stringify(body) }
    const request = new Request(new URL(path, this.#origin), { method, headers: requestHeaders, body: serialized, signal })
    try { return await this.#backend.fetch(request) }
    catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      if (isPublicWaterboxClientError(error)) throw error
      throw clientError("The Waterbox API request failed")
    }
  }
}

function validateOrigin(origin: string | URL): URL {
  const value = new URL(origin.toString())
  if ((value.protocol !== "http:" && value.protocol !== "https:") || value.username !== "" || value.password !== ""
    || value.search !== "" || value.hash !== "" || value.pathname !== "/") throw new TypeError("Waterbox API origin must be an absolute root HTTP(S) URL without credentials, query, or fragment")
  return value
}

function sandboxPath(value: SandboxId): string { return encodeURIComponent(SandboxIdSchema.parse(value)) }
function nonnegativeDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Duration must be nonnegative")
  return value
}

async function requireStatus(response: Response, expected: number, signal: AbortSignal): Promise<void> {
  await propagateResponseAbort(response, signal)
  if (response.status === expected) return
  if (!response.ok) throw await apiError(response, signal)
  await cancelBody(response)
  throw protocolError()
}

async function apiError(response: Response, signal: AbortSignal): Promise<WaterboxClientError> {
  await propagateResponseAbort(response, signal)
  if (!hasMediaType(response, "application/json")) { await cancelBody(response); return clientError("The Waterbox API returned an invalid error response", { status: response.status }) }
  let value: unknown
  try { value = await parseJson(response, MAX_API_ERROR_RESPONSE_BYTES, signal) }
  catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    return clientError("The Waterbox API returned an invalid error response", { status: response.status })
  }
  const parsed = ErrorEnvelopeSchema.safeParse(value)
  if (!parsed.success) return clientError("The Waterbox API returned an invalid error response", { status: response.status })
  return clientError(parsed.data.error.message, {
    status: response.status,
    code: parsed.data.error.code,
    requestId: parsed.data.error.requestId,
    ...(parsed.data.error.sandboxId === undefined ? {} : { recoverySandboxId: parsed.data.error.sandboxId }),
  })
}

async function parseJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const bytes = await readBounded(response, limit, signal)
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
  catch { throw protocolError() }
}

async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (response.body === null) throw protocolError()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined) }
  signal.addEventListener("abort", abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const item = await reader.read()
      signal.throwIfAborted()
      if (item.done) break
      total += item.value.byteLength
      if (total > limit) { await reader.cancel(); throw protocolError() }
      chunks.push(item.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock() }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

async function cancelBody(response: Response): Promise<void> { await response.body?.cancel().catch(() => undefined) }
async function propagateResponseAbort(response: Response, signal: AbortSignal): Promise<void> {
  if (!signal.aborted) return
  await cancelBody(response)
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError")
}
function protocolError(): WaterboxClientError { return clientError("The Waterbox API returned an invalid response") }
function hasMediaType(response: Response, expected: string): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected
}

function validateObservation(sample: BashJobObservation, jobId: string, offset: number): void {
  const chunk = base64ToBytes(sample.chunkBase64)
  if (sample.jobId !== jobId || sample.nextOffset < offset || sample.nextOffset > offset + BASH_CHUNK_BYTES
    || chunk.byteLength !== sample.nextOffset - offset || bytesToBase64(chunk) !== sample.chunkBase64) throw protocolError()
}

function retainUtf8(output: string, bytes: number, truncated: boolean, decoded: string): { output: string; bytes: number; truncated: boolean } {
  if (truncated) return { output, bytes, truncated }
  let append = ""
  for (const character of decoded) {
    const size = new TextEncoder().encode(character).byteLength
    if (bytes + size > MAX_BASH_OUTPUT_BYTES) return { output: output + append, bytes, truncated: true }
    append += character; bytes += size
  }
  return { output: output + append, bytes, truncated: false }
}

function completedBash(receipt: DispatchedBashToolResult, sample: BashJobObservation, output: string, truncated: boolean): CompletedBashToolResult {
  return BashToolResultSchema.parse({
    title: receipt.metadata.description ?? "Bash command",
    outcome: "completed",
    output: output || (sample.timedOut ? "Command timed out" : "Command completed without output"),
    metadata: {
      command: receipt.metadata.command,
      ...(receipt.metadata.description === undefined ? {} : { description: receipt.metadata.description }),
      workdir: receipt.metadata.workdir,
      exitCode: sample.exitCode!, signal: sample.signal ?? null, timedOut: sample.timedOut!, aborted: false,
      durationMs: sample.durationMs!, outputTruncated: truncated,
    },
  }) as CompletedBashToolResult
}

function receiptFallback(receipt: DispatchedBashToolResult): DispatchedBashToolResult {
  const output = `Observation stopped before completion. Job ${receipt.metadata.jobId} may still be running. Recovery statusPath: ${receipt.metadata.statusPath}\nRecovery outputPath: ${receipt.metadata.outputPath}`
  return BashToolResultSchema.parse({ title: receipt.title, outcome: "dispatched", output, metadata: receipt.metadata }) as DispatchedBashToolResult
}

function startProgress(context: CommandContext, interval: number): () => void {
  if (context.onProgress === undefined) return () => undefined
  let stopped = false
  let sequence = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    sequence += 1
    try { await context.onProgress?.({ kind: "heartbeat", sequence }) } catch {}
    if (!stopped) timer = setTimeout(() => void tick(), interval)
  }
  void tick()
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer) }
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.byteLength; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
