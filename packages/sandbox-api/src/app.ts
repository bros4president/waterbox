import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import {
  BashToolArgumentsSchema,
  CreateSandboxRequestSchema,
  CreateSnapshotRequestSchema,
  CursorPaginationRequestSchema,
  EditToolArgumentsSchema,
  ErrorEnvelopeSchema,
  GlobToolArgumentsSchema,
  GlobToolEventSchema,
  GrepToolArgumentsSchema,
  GrepToolEventSchema,
  IdentitySchema,
  PatchToolArgumentsSchema,
  PatchToolEventSchema,
  ReadToolArgumentsSchema,
  ReadToolEventSchema,
  SandboxIdSchema,
  SandboxPageSchema,
  SandboxSchema,
  SnapshotIdSchema,
  SnapshotPageSchema,
  SnapshotSchema,
  SecureTransferConsumeRequestSchema,
  SecureTransferDeliveredSchema,
  SecureTransferIdSchema,
  SecureTransferInitiatedSchema,
  MAX_SECURE_CIPHERTEXT_BASE64_LENGTH,
  ToolNameSchema,
  WriteToolArgumentsSchema,
  WriteToolEventSchema,
  EditToolEventSchema,
  BashToolEventSchema,
  type ErrorCode,
  type Identity,
  type ToolName,
} from "@waterbox/contracts"
import { DomainError } from "@waterbox/core"
import type { WaterboxApiDependencies } from "./types.ts"

type Variables = { identity: Identity; requestId: string }
type ApiEnv = { Variables: Variables }

const RequestIdSchema = z.string().min(1).max(255)
const AuthorizationSchema = z.string().openapi({ example: "Bearer development-key" })
const AuthHeadersSchema = z.object({ authorization: AuthorizationSchema })
const CreateHeadersSchema = AuthHeadersSchema.extend({ "idempotency-key": z.string().min(1).max(255).optional() })
const SandboxPathSchema = z.object({ sandboxId: SandboxIdSchema }).strict()
const SnapshotPathSchema = z.object({ snapshotId: SnapshotIdSchema }).strict()
const ToolPathSchema = z.object({ sandboxId: SandboxIdSchema, toolName: ToolNameSchema }).strict()
const SecureTransferPathSchema = z.object({ sandboxId: SandboxIdSchema, transferId: SecureTransferIdSchema }).strict()
const EmptySchema = z.object({}).strict()
const HealthSchema = z.object({ status: z.literal("ok") }).strict()
const OpenApiDocumentSchema = z.object({ openapi: z.literal("3.1.0") }).passthrough()
const ToolArgumentsSchema = z.union([
  ReadToolArgumentsSchema,
  WriteToolArgumentsSchema,
  EditToolArgumentsSchema,
  PatchToolArgumentsSchema,
  GlobToolArgumentsSchema,
  GrepToolArgumentsSchema,
  BashToolArgumentsSchema,
])

const bearerSecurity = [{ bearerAuth: [] }]
const json = (schema: z.ZodType) => ({ content: { "application/json": { schema } } })
const errorResponses = {
  400: { description: "Invalid request", ...json(ErrorEnvelopeSchema) },
  401: { description: "Unauthorized", ...json(ErrorEnvelopeSchema) },
  404: { description: "Resource not found", ...json(ErrorEnvelopeSchema) },
  409: { description: "Conflict", ...json(ErrorEnvelopeSchema) },
  410: { description: "Transfer expired", ...json(ErrorEnvelopeSchema) },
  413: { description: "Request body too large", ...json(ErrorEnvelopeSchema) },
  422: { description: "Invalid state or unsupported capability", ...json(ErrorEnvelopeSchema) },
  429: { description: "Provider limit", ...json(ErrorEnvelopeSchema) },
  502: { description: "Provider failure or ambiguous execution", ...json(ErrorEnvelopeSchema) },
  500: { description: "Internal error", ...json(ErrorEnvelopeSchema) },
} as const

const routes = {
  health: createRoute({ method: "get", path: "/health", responses: { 200: { description: "Healthy", ...json(HealthSchema) } } }),
  openapi: createRoute({ method: "get", path: "/openapi.json", responses: { 200: { description: "OpenAPI 3.1 document", ...json(OpenApiDocumentSchema) } } }),
  createSandbox: createRoute({ method: "post", path: "/v1/sandboxes", security: bearerSecurity, request: { headers: CreateHeadersSchema, body: json(CreateSandboxRequestSchema) }, responses: { 201: { description: "Sandbox created", ...json(SandboxSchema) }, ...errorResponses } }),
  listSandboxes: createRoute({ method: "get", path: "/v1/sandboxes", security: bearerSecurity, request: { headers: AuthHeadersSchema, query: CursorPaginationRequestSchema }, responses: { 200: { description: "Sandbox page", ...json(SandboxPageSchema) }, ...errorResponses } }),
  getSandbox: createRoute({ method: "get", path: "/v1/sandboxes/{sandboxId}", security: bearerSecurity, request: { headers: AuthHeadersSchema, params: SandboxPathSchema }, responses: { 200: { description: "Sandbox", ...json(SandboxSchema) }, ...errorResponses } }),
  stopSandbox: createRoute({ method: "post", path: "/v1/sandboxes/{sandboxId}/stop", security: bearerSecurity, request: { headers: AuthHeadersSchema, params: SandboxPathSchema }, responses: { 200: { description: "Sandbox stop initiated", ...json(SandboxSchema) }, ...errorResponses } }),
  resumeSandbox: createRoute({ method: "post", path: "/v1/sandboxes/{sandboxId}/resume", security: bearerSecurity, request: { headers: AuthHeadersSchema, params: SandboxPathSchema }, responses: { 200: { description: "Sandbox resume initiated", ...json(SandboxSchema) }, ...errorResponses } }),
  deleteSandbox: createRoute({ method: "delete", path: "/v1/sandboxes/{sandboxId}", security: bearerSecurity, request: { headers: AuthHeadersSchema, params: SandboxPathSchema }, responses: { 200: { description: "Sandbox deletion initiated", ...json(SandboxSchema) }, ...errorResponses } }),
  createSnapshot: createRoute({ method: "post", path: "/v1/sandboxes/{sandboxId}/snapshots", security: bearerSecurity, request: { headers: AuthHeadersSchema, params: SandboxPathSchema, body: json(CreateSnapshotRequestSchema) }, responses: { 201: { description: "Snapshot created", ...json(SnapshotSchema) }, ...errorResponses } }),
  listSnapshots: createRoute({ method: "get", path: "/v1/snapshots", security: bearerSecurity, request: { headers: AuthHeadersSchema, query: CursorPaginationRequestSchema }, responses: { 200: { description: "Snapshot page", ...json(SnapshotPageSchema) }, ...errorResponses } }),
  getSnapshot: createRoute({ method: "get", path: "/v1/snapshots/{snapshotId}", security: bearerSecurity, request: { headers: AuthHeadersSchema, params: SnapshotPathSchema }, responses: { 200: { description: "Snapshot", ...json(SnapshotSchema) }, ...errorResponses } }),
  deleteSnapshot: createRoute({ method: "delete", path: "/v1/snapshots/{snapshotId}", security: bearerSecurity, request: { headers: AuthHeadersSchema, params: SnapshotPathSchema }, responses: { 200: { description: "Snapshot deletion initiated", ...json(SnapshotSchema) }, ...errorResponses } }),
  initiateSecureFileTransfer: createRoute({ method: "post", path: "/v1/sandboxes/{sandboxId}/secure-file-transfers", security: bearerSecurity, request: { headers: AuthHeadersSchema, params: SandboxPathSchema }, responses: { 201: { description: "Secure file transfer initiated", ...json(SecureTransferInitiatedSchema) }, ...errorResponses } }),
  consumeSecureFileTransfer: createRoute({ method: "put", path: "/v1/sandboxes/{sandboxId}/secure-file-transfers/{transferId}", security: bearerSecurity, request: { headers: AuthHeadersSchema, params: SecureTransferPathSchema, body: json(SecureTransferConsumeRequestSchema) }, responses: { 200: { description: "Secure file delivered", ...json(SecureTransferDeliveredSchema) }, ...errorResponses } }),
  executeTool: createRoute({ method: "post", path: "/v1/sandboxes/{sandboxId}/tools/{toolName}", security: bearerSecurity, request: { headers: AuthHeadersSchema, params: ToolPathSchema, body: json(ToolArgumentsSchema) }, responses: { 200: { description: "Ordered canonical tool events, one event per line", content: { "application/x-ndjson": { schema: z.string().openapi({ example: `${JSON.stringify({ type: "stdout", data: "hello\\n" })}\n${JSON.stringify({ type: "result" })}\n` }) } } }, ...errorResponses } }),
}

const toolSchemas = {
  read: ReadToolArgumentsSchema,
  write: WriteToolArgumentsSchema,
  edit: EditToolArgumentsSchema,
  patch: PatchToolArgumentsSchema,
  glob: GlobToolArgumentsSchema,
  grep: GrepToolArgumentsSchema,
  bash: BashToolArgumentsSchema,
} as const
const toolEventSchemas = {
  read: ReadToolEventSchema,
  write: WriteToolEventSchema,
  edit: EditToolEventSchema,
  patch: PatchToolEventSchema,
  glob: GlobToolEventSchema,
  grep: GrepToolEventSchema,
  bash: BashToolEventSchema,
} as const

export function createWaterboxApi(dependencies: WaterboxApiDependencies) {
  const app = new OpenAPIHono<ApiEnv>({
    defaultHook(result, c) {
      if (result.success) return
      return errorResponse(c, c.get("requestId") ?? requestId(c.req.raw, dependencies), "invalid_request", "The request is invalid", 400)
    },
  })

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
  })

  app.use("*", async (c, next) => {
    const id = requestId(c.req.raw, dependencies)
    c.set("requestId", id)
    await next()
    c.header("X-Request-Id", id)
  })

  app.use("/v1/*", async (c, next) => {
    const authorization = c.req.header("authorization")
    const match = authorization?.match(/^Bearer ([^\s]+)$/)
    if (!match) return errorResponse(c, c.get("requestId"), "unauthorized", "Authentication is required", 401)
    let identity: Identity | undefined
    try {
      const resolved = await dependencies.identityResolver.resolveBearer(match[1]!, c.req.raw.signal)
      identity = resolved === undefined ? undefined : IdentitySchema.parse(resolved)
    } catch {
      return errorResponse(c, c.get("requestId"), "unauthorized", "Authentication failed", 401)
    }
    if (identity === undefined) return errorResponse(c, c.get("requestId"), "unauthorized", "Authentication failed", 401)
    c.set("identity", identity)
    await next()
  })

  app.use("/v1/*", async (c, next) => {
    if (c.req.method !== "PUT" || !/^\/v1\/sandboxes\/[^/]+\/secure-file-transfers\/[^/]+$/.test(new URL(c.req.url).pathname)) return next()
    try {
      const body = await readBoundedJson(c.req.raw, MAX_SECURE_TRANSFER_JSON_BYTES)
      c.req.raw = new Request(c.req.raw.url, { method: c.req.raw.method, headers: c.req.raw.headers, body, signal: c.req.raw.signal })
    }
    catch (error) {
      const status = error instanceof RequestBodyError ? error.status : 400
      return errorResponse(c, c.get("requestId"), "invalid_request", status === 413 ? "The request body is too large" : "The request is invalid", status)
    }
    await next()
  })

  app.onError((error, c) => {
    if (error instanceof DomainError) {
      return errorResponse(c, c.get("requestId"), error.code, publicMessage(error.code), statusFor(error.code))
    }
    return errorResponse(c, c.get("requestId"), "internal_error", "An internal error occurred", 500)
  })
  app.notFound((c) => errorResponse(c, c.get("requestId"), "not_found", "The resource was not found", 404))

  app.openapi(routes.health, (c) => c.json({ status: "ok" }, 200))
  app.openapi(routes.openapi, (c) => c.json(openApiDocument(app), 200))

  app.openapi(routes.createSandbox, async (c) => {
    const body = CreateSandboxRequestSchema.parse(c.req.valid("json"))
    const sandbox = await dependencies.core.createSandbox(c.get("identity"), body, {
      idempotencyKey: c.req.valid("header")["idempotency-key"],
      signal: c.req.raw.signal,
    })
    return c.json(SandboxSchema.parse(sandbox), 201)
  })
  app.openapi(routes.listSandboxes, async (c) => c.json(SandboxPageSchema.parse(await dependencies.core.listSandboxes(c.get("identity"), c.req.valid("query"), c.req.raw.signal)), 200))
  app.openapi(routes.getSandbox, async (c) => c.json(SandboxSchema.parse(await dependencies.core.getSandbox(c.get("identity"), c.req.valid("param").sandboxId, c.req.raw.signal)), 200))
  app.openapi(routes.stopSandbox, async (c) => c.json(SandboxSchema.parse(await dependencies.core.stopSandbox(c.get("identity"), c.req.valid("param").sandboxId, c.req.raw.signal)), 200))
  app.openapi(routes.resumeSandbox, async (c) => c.json(SandboxSchema.parse(await dependencies.core.resumeSandbox(c.get("identity"), c.req.valid("param").sandboxId, c.req.raw.signal)), 200))
  app.openapi(routes.deleteSandbox, async (c) => c.json(SandboxSchema.parse(await dependencies.core.deleteSandbox(c.get("identity"), c.req.valid("param").sandboxId, c.req.raw.signal)), 200))
  app.openapi(routes.createSnapshot, async (c) => c.json(SnapshotSchema.parse(await dependencies.core.createSnapshot(c.get("identity"), c.req.valid("param").sandboxId, CreateSnapshotRequestSchema.parse(c.req.valid("json")), c.req.raw.signal)), 201))
  app.openapi(routes.listSnapshots, async (c) => c.json(SnapshotPageSchema.parse(await dependencies.core.listSnapshots(c.get("identity"), c.req.valid("query"), c.req.raw.signal)), 200))
  app.openapi(routes.getSnapshot, async (c) => c.json(SnapshotSchema.parse(await dependencies.core.getSnapshot(c.get("identity"), c.req.valid("param").snapshotId, c.req.raw.signal)), 200))
  app.openapi(routes.deleteSnapshot, async (c) => c.json(SnapshotSchema.parse(await dependencies.core.deleteSnapshot(c.get("identity"), c.req.valid("param").snapshotId, c.req.raw.signal)), 200))
  app.openapi(routes.initiateSecureFileTransfer, async (c) => c.json(SecureTransferInitiatedSchema.parse(await dependencies.core.initiateSecureFileTransfer(c.get("identity"), c.req.valid("param").sandboxId, c.req.raw.signal)), 201))
  app.openapi(routes.consumeSecureFileTransfer, async (c) => {
    const { sandboxId, transferId } = SecureTransferPathSchema.parse(c.req.valid("param"))
    const request = SecureTransferConsumeRequestSchema.parse(c.req.valid("json"))
    return c.json(SecureTransferDeliveredSchema.parse(await dependencies.core.consumeSecureFileTransfer(c.get("identity"), sandboxId, transferId, request, c.req.raw.signal)), 200)
  })
  const executeToolHandler = async (c: Context<ApiEnv>) => {
    const { sandboxId, toolName } = ToolPathSchema.parse(c.req.param())
    const parsed = toolSchemas[toolName].safeParse(await c.req.json())
    if (!parsed.success) throw new DomainError("invalid_request", "The request is invalid")
    const controller = linkedAbortController(c.req.raw.signal)
    const events = await dependencies.core.executeTool(c.get("identity"), sandboxId, toolName, parsed.data as never, controller.signal)
    const iterator = events[Symbol.asyncIterator]()
    let first
    try { first = await iterator.next() }
    catch (error) { controller.abort(error); throw error }
    if (first.done) { controller.abort(); throw new DomainError("provider_failure", "The provider operation failed") }
    const encoder = new TextEncoder()
    let prefetched: Awaited<ReturnType<typeof iterator.next>> | undefined = first
    const stream = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const next = prefetched
          prefetched = undefined
          const event = next ?? await iterator.next()
          if (event.done) return streamController.close()
          const parsedEvent = toolEventSchemas[toolName].parse(event.value)
          streamController.enqueue(encoder.encode(`${JSON.stringify(parsedEvent)}\n`))
        } catch (error) {
          streamController.error(error)
        }
      },
      async cancel(reason) {
        controller.abort(reason)
        await iterator.return?.()
      },
    })
    return c.body(stream, 200, { "Content-Type": "application/x-ndjson" })
  }
  // OpenAPIHono's response inference resolves non-JSON streaming handlers to `never`;
  // the declared route still owns the NDJSON media contract and this remains a Web Response.
  app.openapi(routes.executeTool, executeToolHandler as never)

  return app
}

function linkedAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  return controller
}

function requestId(request: Request, dependencies: WaterboxApiDependencies): string {
  const supplied = request.headers.get("x-request-id")
  if (supplied !== null && RequestIdSchema.safeParse(supplied).success && /^[A-Za-z0-9._:-]+$/.test(supplied)) return supplied
  return dependencies.generateRequestId?.() ?? crypto.randomUUID()
}

function openApiDocument(app: OpenAPIHono<ApiEnv>) {
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "Waterbox Control Plane API", version: "1.0.0" },
  })
}

function errorResponse(c: { json: Function }, requestId: string, code: ErrorCode, message: string, status: number): Response {
  return c.json({ error: { code, message, requestId } }, status)
}

function statusFor(code: ErrorCode): number {
  switch (code) {
    case "invalid_request": return 400
    case "unauthorized": return 401
    case "not_found": return 404
    case "conflict":
    case "idempotency_conflict":
    case "idempotency_in_progress": return 409
    case "transfer_consumed": return 409
    case "transfer_expired": return 410
    case "invalid_state":
    case "unsupported_capability": return 422
    case "provider_limit": return 429
    case "provider_failure":
    case "ambiguous_execution": return 502
    case "internal_error": return 500
  }
}

function publicMessage(code: ErrorCode): string {
  switch (code) {
    case "not_found": return "The resource was not found"
    case "conflict": return "The request conflicts with current state"
    case "idempotency_conflict": return "The idempotency key conflicts with an earlier request"
    case "idempotency_in_progress": return "The idempotent request is still in progress"
    case "invalid_state": return "The resource is not in a valid state for this operation"
    case "unsupported_capability": return "The requested capability is not supported"
    case "provider_limit": return "The provider limit was reached"
    case "provider_failure": return "The provider operation failed"
    case "ambiguous_execution": return "The provider execution outcome is unknown"
    case "transfer_expired": return "The secure file transfer expired"
    case "transfer_consumed": return "The secure file transfer was already consumed"
    case "invalid_request": return "The request is invalid"
    case "unauthorized": return "Authentication failed"
    case "internal_error": return "An internal error occurred"
  }
}

const MAX_SECURE_TRANSFER_JSON_BYTES = MAX_SECURE_CIPHERTEXT_BASE64_LENGTH + 8_192
class RequestBodyError extends Error { constructor(readonly status: 400 | 413) { super("Invalid request body") } }
async function readBoundedJson(request: Request, maximum: number): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) throw new RequestBodyError(400)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    const declared = request.headers.get("content-length")
    if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw new RequestBodyError(400)
    if (declared !== null && Number(declared) > maximum) throw new RequestBodyError(413)
    while (true) {
      request.signal.throwIfAborted()
      const item = await abortableBodyRead(reader, request.signal)
      if (item.done) break
      total += item.value.byteLength
      if (total > maximum) throw new RequestBodyError(413)
      chunks.push(item.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    JSON.parse(text)
    return text
  } catch (error) {
    try { await reader.cancel(error) } catch {}
    if (error instanceof RequestBodyError || request.signal.aborted) throw error
    throw new RequestBodyError(400)
  }
}

async function abortableBodyRead(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  signal.throwIfAborted()
  let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const abort = () => rejectAbort(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
  signal.addEventListener("abort", abort, { once: true })
  try { return await Promise.race([reader.read(), aborted]) }
  finally { signal.removeEventListener("abort", abort) }
}
