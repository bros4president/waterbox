# Fetch-Backed Waterbox Client Refactor

Status: complete; Phases 0-6 complete

This is the standalone implementation plan for making the Waterbox HTTP API the canonical product boundary in both local and cloud-shaped compositions. It replaces the supported MCP's direct calls into core with a reusable `@waterbox/client`, while preserving a fully embedded local backend through an injected Fetch implementation rather than requiring a localhost server.

This plan is intentionally independent from release and launch planning. Implementing this plan must not edit, reinterpret, or update another plan. A separate pass may reconcile other plans after this refactor is complete and verified.

## How To Use This Plan

An implementation agent assigned a phase must:

1. Read this entire plan and every prerequisite phase.
2. Inspect the current worktree and preserve unrelated or concurrent changes.
3. Reconfirm the referenced source behavior before editing because concurrent launch work may have moved files or changed package metadata.
4. Implement only the assigned phase and its acceptance criteria.
5. Run the phase's focused verification and `git diff --check`; run repository-wide tests and release-artifact builds at the final integration phase unless a phase explicitly requires them earlier.
6. Update the phase status and append a short implementation-log entry with concrete verification facts.
7. Stop at the phase boundary.

Do not broaden a phase to redesign lifecycle durability, publish new packages, deploy cloud infrastructure, introduce a local daemon, or remove historical experiments. Record a concrete blocker instead of inventing compatibility machinery or silently bypassing the API.

No live provider mutation is authorized by this plan. Completion requires no externally supplied, persisted, live-provider, or production credential. Ephemeral in-memory bearer values are required to test embedded and network authentication correctly.

## Objective

The refactor is complete when the supported MCP no longer invokes `SandboxService` directly and instead renders reusable `@waterbox/client` commands as MCP tools. The same client must execute against either:

- An embedded local backend whose Fetch implementation runs `@waterbox/api` in-process over local core, SQLite, and a user-owned provider.
- A credential-agnostic remote backend whose injected Fetch implementation sends requests to a configured Waterbox API origin. OAuth remains outside this plan; tests supply a static authenticated Fetch adapter.

The target shape is:

```text
agent-facing presentations
    |
    +-- @waterbox/mcp
    +-- future WebMCP adapter
    +-- future CLI or SDK consumer
    |
    v
@waterbox/client
    |
    | product commands
    | simple endpoint proxies plus client-side workflows
    v
ApiBackend
    |
    +-- embedded Fetch -> @waterbox/api -> core -> SQLite + provider
    |
    +-- remote Fetch   -> HTTPS Waterbox API deployment
```

Local mode does not open a port:

```text
@waterbox/mcp
    -> @waterbox/client
    -> Request("http://waterbox.local/v1/...")
    -> embedded api.fetch(request)
    -> @waterbox/core
    -> @waterbox/repository-sqlite
    -> @waterbox/provider-box
```

Remote-shaped mode changes only the backend:

```text
@waterbox/mcp
    -> @waterbox/client
    -> Request("https://api.waterbox.sh/v1/...")
    -> authenticated network fetch
    -> deployed @waterbox/api
```

The embedded URL is a synthetic absolute origin used to construct standards-compliant `Request` objects. It is never resolved through DNS and never receives a TCP listener.

## Motivation

### Current Shadow Contract

The supported MCP currently composes core directly in `packages/mcp/src/direct.ts`:

```text
MCP tools
    -> McpBackend
    -> SandboxService
    -> repositories and provider
```

The local HTTP application separately composes:

```text
HTTP routes
    -> @waterbox/api
    -> SandboxService
    -> repositories and provider
```

This created two application contracts:

1. The documented HTTP API contract.
2. A package-private but behaviorally real MCP-to-core contract.

The two paths already differ. MCP exposes provider probing without an equivalent API route. The API exposes sandbox listing, ordinary get, explicit stop/resume, and snapshot get without MCP commands. Direct MCP calls bypass API authentication, validation, body limits, request IDs, error envelopes, NDJSON parsing, and cancellation behavior. Bash and secure-transfer workflows are independently wired around direct core methods.

The direct composition was reasonable for an initially local-only product, but it becomes a drift risk once Waterbox supports a hosted API, hosted MCP, WebMCP, or other clients.

### Concurrent Baseline Changes

Concurrent work outside this plan changed core and Box internals after the first draft. These changes are prerequisites, not partial implementation of the Fetch-backed architecture:

- `preparing` is now a canonical public and persisted sandbox state.
- Every provider must implement `prepareSandbox`.
- Core persists the provider reference and `preparing` checkpoint before provider preparation.
- Same-key creation replay may resume persisted preparation without repeating provider creation.
- Definite and ambiguous post-checkpoint failures preserve a public sandbox recovery handle.
- API error envelopes may contain `error.sandboxId`.
- Box now receives an injected `SandboxRuntimeArtifact` and installs it during preparation.
- Fresh Box creation no longer depends on a Waterbox system template or `BOX_SYSTEM_TEMPLATE_REF`.

None of these changes adds `@waterbox/client`, `ApiBackend`, an embedded authenticated Fetch backend, or an API-backed supported MCP. The target architecture and phase statuses remain unchanged.

Before Phase 0 begins, the concurrent lifecycle/artifact work must be landed or otherwise separated into a stable baseline. Fetch-backed phase diffs must not absorb or revert unrelated concurrent work.

### Why A Reusable Client Is Worthwhile

Calling Fetch directly from every presentation would avoid one package but duplicate:

- Route paths and HTTP methods.
- Authentication expectations.
- Idempotency headers.
- Request and response validation.
- NDJSON decoding.
- Stable error-envelope handling.
- Cancellation and body cleanup.
- Long Bash observation and output aggregation.
- Secure-transfer initiation, encryption, and consumption.

`@waterbox/client` is the single point of contact with the API. It is analogous to a typed frontend API client: presentations consume product commands rather than scattering Fetch calls. MCP is the first renderer, not the owner of API semantics.

### Why Embedded Requests Still Use The API

The local backend could continue calling core directly, but doing so would preserve the shadow contract. Passing local requests through `@waterbox/api` continuously verifies the same authentication, validation, serialization, streaming, error, and cancellation behavior needed by remote consumers.

The in-process serialization cost is accepted. No network, port, service discovery, readiness race, firewall rule, or orphan process is introduced.

## Settled Terminology

### `ApiBackend`

`ApiBackend` tells the client where and how API requests execute:

```ts
export interface ApiBackend {
  readonly origin: URL
  fetch(request: Request): Promise<Response>
  close(): Promise<void>
}
```

Rules:

- `origin` must be an absolute `http:` or `https:` URL without credentials, query, or fragment.
- `origin` must have the root pathname `/`; path-prefix behavior is not implicit.
- `fetch` receives a complete `Request` and returns a standard `Response`.
- The backend is responsible for transport-level authentication. The client does not inspect OAuth tokens, local bearer tokens, cookies, or provider credentials.
- `close` is idempotent.
- An embedded backend closes local stores and other owned resources.
- A basic remote backend may have a no-op `close`.
- Backend implementations must preserve the request signal and must not blindly retry mutating requests.

`ApiBackend` is a deployment/composition port, not a second application service.

### `WaterboxClient`

`WaterboxClient` consumes an `ApiBackend` and exposes product-level commands. It owns API paths, HTTP methods, protocol parsing, safe API errors, and client-side workflows.

Simple commands proxy one endpoint. Composite commands use multiple bounded API primitives and local computation.

### Embedded Control Plane

The embedded control plane is the complete local backend composition:

```text
@waterbox/api
@waterbox/core
@waterbox/repository-sqlite
@waterbox/provider-box or an injected provider test override
local identity resolver
sandbox runtime artifact
```

The package can return a raw API handler for the explicit development listener or an authenticated `ApiBackend` for embedded consumers. It does not itself open an HTTP listener and is not part of `@waterbox/client`.

### Presentation Adapter

MCP and future WebMCP packages are presentation adapters. They expose client commands through an agent-facing protocol, map progress and errors into that protocol, and perform environment-specific input acquisition when necessary.

## Settled Architectural Decisions

### Canonical Boundary

- `@waterbox/api` is the canonical product boundary into core for MCP, WebMCP, CLI, SDK, and other external product consumers.
- Internal server-side workers may call core directly because they implement the backend rather than consume the product API.
- No supported MCP tool may call core, a repository, or a provider directly after this refactor.
- The local and remote client paths differ only through `ApiBackend` construction.

### Package Shape

Add these workspace packages:

```text
packages/client
    @waterbox/client

packages/control-plane-local
    @waterbox/control-plane-local
```

Publication of either package is deferred. They may remain workspace-private during this refactor. The npm MCP bundle may inline them.

Dependency direction:

```text
@waterbox/contracts
    ^
    |
@waterbox/client
    ^
    |
@waterbox/mcp

@waterbox/contracts
    ^
    |
@waterbox/core <- repository/provider implementations
    ^
    |
@waterbox/api
    ^
    |
@waterbox/control-plane-local
```

Additional local composition dependencies:

```text
@waterbox/control-plane-local
    -> @waterbox/client for the ApiBackend type
    -> @waterbox/api
    -> @waterbox/core
    -> @waterbox/repository-sqlite
    -> @waterbox/provider-box
```

`@waterbox/client` must not import core, repository, provider, API-server, MCP, or app packages.

### Command Surface

The initial client command surface matches the currently supported MCP product surface:

```text
createSandbox
probeSandbox
deleteSandbox
listSnapshots
createSnapshot
deleteSnapshot
sendFileSecurely
read
write
edit
patch
glob
grep
bash
```

The MCP maps those commands to the current snake-case tool names. This refactor does not add MCP tools for sandbox listing, ordinary sandbox get, explicit stop/resume, or snapshot get.

The API may continue to expose operations not rendered as MCP tools. API completeness and model-visible tool selection are separate concerns.

### Command Metadata

Canonical argument and result schemas remain in `@waterbox/contracts`. Client commands use those schemas rather than redefining protocol shapes.

Agent-facing descriptions and environment-specific argument presentation may remain in presentation packages during this refactor. Do not add a generic command registry, schema generator, or renderer framework merely to prepare for WebMCP. A later extraction may share presentation metadata once a second renderer proves the shape.

### Simple Versus Composite Commands

Simple commands map to one API operation:

```text
client.read
    -> POST /v1/sandboxes/:sandboxId/tools/read

client.createSnapshot
    -> POST /v1/sandboxes/:sandboxId/snapshots
```

Composite secure transfer:

```text
presentation obtains plaintext bytes
    -> client.sendFileSecurely
    -> POST transfer initiation
    -> encrypt bytes for returned recipient
    -> PUT encrypted transfer consumption
    -> clear mutable client-owned ciphertext buffers best effort
    -> return one delivered result
```

Composite Bash:

```text
client.bash
    -> POST bash execution
    -> completed result, or dispatched receipt
    -> bounded observation requests until terminal or observation stops
    -> bounded best-effort cleanup after terminal drain
    -> return completed result or recovery receipt
```

Observation and cleanup remain API primitives, not model-visible commands.

### Local File Boundary

`@waterbox/client` must not accept or interpret a host filesystem path. Its secure-transfer command accepts plaintext bytes, initially as a bounded `Uint8Array`, plus sandbox and target information.

The MCP remains responsible for:

- Reading `sourcePath` from the MCP host.
- Requiring a regular file.
- Enforcing the plaintext size limit.
- Handling cancellation during local reads.
- Clearing the plaintext buffer after the client command settles.

The client remains responsible for:

- Transfer initiation.
- Independent validation of `MAX_SECURE_FILE_BYTES` before initiation, even when a non-MCP caller supplies the bytes.
- Expiry validation.
- Encryption.
- Ciphertext size validation.
- Transfer consumption.
- Best-effort clearing of mutable client-owned ciphertext buffers. Base64 strings and serialized request-body copies are immutable and cannot be zeroed in JavaScript.

The caller retains ownership of the input plaintext and must clear it after the command settles. The client must not mutate the caller's plaintext buffer, retain it after the call, or serialize plaintext into an API request.

This narrow adaptation is the intentional exception to literal one-to-one MCP argument mapping. A future browser renderer can obtain bytes from `File` or `Blob` and invoke the same client command.

### Bash Progress Boundary

The client owns protocol-neutral Bash observation policy and accepts an optional progress callback:

```ts
export interface CommandContext {
  signal: AbortSignal
  onProgress?: (progress: WaterboxCommandProgress) => void | Promise<void>
}
```

The MCP maps client progress to MCP progress notifications. The client must not import the MCP SDK or construct MCP notifications.

The current output limits, UTF-8 decoding, receipt fallback, and cleanup deadline remain unchanged unless a focused defect requires correction. Exact preserved policy:

- Every observation request is bounded, but total client-side observation may continue until terminal state, cancellation, or observation failure.
- Cancellation, malformed observation, progress-independent transport failure, or other observation failure returns the original dispatched receipt with recovery paths rather than throwing away the recovery handle.
- Progress is a content-free heartbeat, not command or output delivery.
- Progress callback failures are ignored and do not stop observation.
- Cleanup starts only after terminal output is fully drained.
- Cleanup is detached, best effort, and bounded by the existing fixed cleanup deadline; the command result does not wait for cleanup completion.

### Request Duration

The intended service rule is:

> An API request that cannot complete within the service request budget returns a durable resource or receipt rather than holding the request indefinitely.

For this refactor, preserve the implemented Bash behavior: one execution request may return a completed result or a dispatched job receipt, and every observation is a separate bounded request.

Current lifecycle operations such as sandbox creation may still exceed 15 seconds because provider allocation, readiness, preparation, and verification occur in the request. Converting every lifecycle mutation into a durable asynchronous operation is explicitly deferred. Do not fold that redesign into this refactor.

### Error Boundary

`@waterbox/client` parses canonical API error envelopes into a typed, safe client error containing only public fields such as:

```text
HTTP status
public error code
public message
request ID
optional `error.sandboxId`, validated as a public SandboxId
```

It must never include raw response bodies, authorization headers, provider references, provider IDs, protected URLs, local paths, commands, or credentials in errors or diagnostics.

The typed client error exposes the wire field as `recoverySandboxId?: SandboxId`. A failed create response may still identify an owned, probeable, deletable, or same-key-resumable resource. The client must preserve a provided ID without converting the error into a successful sandbox result and without automatically replaying creation. An aborted request may preserve server-side state without returning any envelope or public ID; the client propagates that abort unchanged and recovery uses the same idempotency key.

The MCP maps client errors into MCP-safe `isError` results. It must preserve useful public API error meaning without exposing transport internals.

### Retries

- The client does not blindly retry mutations.
- Exact idempotent creation replay remains caller-controlled through the explicit idempotency key.
- Bash observation GET/POST behavior may repeat only according to the existing offset protocol.
- Lost secure-transfer consumption remains ambiguous and is not retried.
- Backend authentication may refresh a token before dispatch or after a provably pre-dispatch authorization failure, but OAuth behavior is outside this refactor.

### Client Response Bounds

The client must parse incrementally and enforce named limits rather than calling unbounded `response.text()` or `response.json()` on untrusted responses:

```text
MAX_API_ERROR_RESPONSE_BYTES = 65_536
MAX_API_JSON_RESPONSE_BYTES = 1_048_576
MAX_API_NDJSON_LINE_BYTES = 8_388_608
MAX_API_NDJSON_TOTAL_BYTES = 16_777_216
```

The larger NDJSON line bound accommodates worst-case JSON escaping of an already bounded 1 MiB canonical tool output. A partial line may never grow beyond the line bound. Total decoded stream bytes may never exceed the total bound. Exceeding any bound cancels the response body and returns a safe client protocol error without including body content.

## Current Contract Inventory

### Lifecycle And Preparation Baseline

Current creation semantics are:

```text
reserve idempotency key and persist provisioning record
    -> provider.createSandbox
    -> persist providerRef and preparing checkpoint
    -> provider.prepareSandbox
    -> verify the prepared observation
    -> persist running
    -> complete idempotency record
```

Settled behavior that this refactor must preserve:

- `prepareSandbox` is a mandatory provider operation.
- Preparation is idempotent for the same resource and desired artifact.
- Provider readiness alone cannot promote a `preparing` resource to `running`.
- A same-key create replay resumes only a persisted `preparing` resource with a provider reference; it does not repeat provider creation from a null-reference `provisioning` record.
- Definite preparation failure preserves `failed` with the provider reference.
- Ambiguous and definite post-checkpoint failures that become public recovery errors preserve state and expose `error.sandboxId`.
- Caller cancellation after the checkpoint preserves the record and idempotency reservation but may abort before any response exposes the generated sandbox ID. Same-key create replay is then the recovery path; the client must not invent a recovery ID.
- `preparing` blocks tools, secure transfer, snapshots, stop/resume, and Bash job operations.
- `preparing` and post-checkpoint `failed` resources remain deletable.
- Client code must never automatically replay creation. Recovery remains an explicit caller action using the same idempotency key.

Current Box composition additionally requires a validated `SandboxRuntimeArtifact`. The provider owns artifact upload, installation, manifest reconciliation, and runtime verification. Client and MCP presentation code must not know Box installation paths or commands.

### Implemented API Routes

The current API implements these operations in `packages/sandbox-api/src/app.ts`:

| HTTP operation | Core method | Current MCP product equivalent |
|---|---|---|
| `GET /health` | none | none; transport-only |
| `GET /openapi.json` | none | none; transport-only |
| `POST /v1/sandboxes` | `createSandbox` | `create_sandbox` |
| `GET /v1/sandboxes` | `listSandboxes` | none |
| `GET /v1/sandboxes/:sandboxId` | `getSandbox` | none; not equivalent to probe |
| `POST /v1/sandboxes/:sandboxId/stop` | `stopSandbox` | none |
| `POST /v1/sandboxes/:sandboxId/resume` | `resumeSandbox` | none; tools may auto-resume through core |
| `DELETE /v1/sandboxes/:sandboxId` | `deleteSandbox` | `delete_sandbox` |
| `POST /v1/sandboxes/:sandboxId/snapshots` | `createSnapshot` | `create_snapshot` |
| `GET /v1/snapshots` | `listSnapshots` | `list_snapshots` |
| `GET /v1/snapshots/:snapshotId` | `getSnapshot` | none |
| `DELETE /v1/snapshots/:snapshotId` | `deleteSnapshot` | `delete_snapshot` |
| `POST /v1/sandboxes/:sandboxId/secure-file-transfers` | `initiateSecureFileTransfer` | part of `send_file_securely` |
| `PUT /v1/sandboxes/:sandboxId/secure-file-transfers/:transferId` | `consumeSecureFileTransfer` | part of `send_file_securely` |
| `POST /v1/sandboxes/:sandboxId/tools/:toolName` | `executeTool` | seven execution tools |
| `POST /v1/internal/sandboxes/:sandboxId/bash-jobs/:jobId/observe` | `observeBashJob` | internal part of `bash` |
| `DELETE /v1/internal/sandboxes/:sandboxId/bash-jobs/:jobId` | `cleanupBashJob` | internal part of `bash` |

The supported MCP currently consumes none of these over HTTP. Behavioral overlap comes from direct calls to core.

The current API contract also includes:

- `preparing` in every canonical sandbox state schema.
- Optional `error.sandboxId` on the canonical error envelope for public post-checkpoint recovery.
- No system-template configuration or API field.

### Current Shadow MCP Contract

`packages/mcp/src/backend.ts` and `packages/mcp/src/direct.ts` currently consume core through:

| MCP backend method | Core method | API status |
|---|---|---|
| `createSandbox` | `createSandbox` | equivalent route exists |
| `probeSandbox` | `probeSandbox` | missing route |
| `deleteSandbox` | `deleteSandbox` | equivalent route exists |
| `listSnapshots` | `listSnapshots` | equivalent route exists |
| `createSnapshot` | `createSnapshot` | equivalent route exists |
| `deleteSnapshot` | `deleteSnapshot` | equivalent route exists |
| `initiateSecureFileTransfer` | `initiateSecureFileTransfer` | equivalent route exists |
| `consumeSecureFileTransfer` | `consumeSecureFileTransfer` | equivalent route exists |
| `executeTool` | `executeTool` | equivalent route exists |
| `observeBashJob` | `observeBashJob` | hidden route exists |
| `cleanupBashJob` | `cleanupBashJob` | hidden route exists |

Provider probe and ordinary get have different state-dependent semantics:

- `getSandbox` reads the repository and reconciles ordinary transitional states.
- A `provisioning` record with a provider reference may be inspected, checkpointed, and immediately prepared through ordinary get or probe reconciliation, returning `running` or a recovery error.
- An already persisted `preparing` record is returned by ordinary get without resuming preparation.
- `probeSandbox` actively calls provider inspection when a provider reference is available and reconciles stable live state.
- Probe may observe provider failure or termination for `preparing`, but a provider-ready observation must leave Waterbox `preparing`; only same-key create replay runs preparation to completion.
- Probe of `failed` keeps the Waterbox record `failed` for provider-ready or provider-failed observations and reconciles it to `terminated` only when termination is observed.
- A null-reference `provisioning` record cannot be inspected and retains the existing unresolved creation semantics.

The client command `probeSandbox` therefore requires a real probe API operation. It must not be implemented by calling ordinary `GET /v1/sandboxes/:sandboxId`.

## Non-Goals

Do not add or redesign these in this plan:

- OAuth login, token persistence, payment, or billing.
- A production hosted API or hosted MCP deployment.
- A real remote Waterbox provider implementation.
- MCP Tasks.
- WebMCP implementation.
- A generic tool-rendering framework.
- Publication of `@waterbox/client` as a separate npm package.
- A localhost HTTP listener in the normal MCP path.
- A local daemon, reaper, queue, scheduler, or background service.
- Durable asynchronous resources for every lifecycle mutation.
- New MCP tools for API methods not currently represented.
- Removal of `@waterbox/experimental-control-plane-mcp` or its experiment script.
- Removal of legacy plugin, receiver, protocol, or Pi packages.
- Further provider contract redesign beyond the existing mandatory `prepareSandbox` operation.
- Repository schema redesign or migrations unrelated to this refactor.
- Provider credential storage changes.
- A browser filesystem abstraction.
- Live provider smoke tests without separate authorization.
- Changes to any other durable plan during this implementation.

## Safety And Compatibility Rules

- Preserve the current public MCP tool names, argument shapes, descriptions, and result semantics except where API-safe error detail is intentionally improved and tested.
- Preserve `preparing` as a canonical client-visible sandbox state.
- Preserve `error.sandboxId` as the exact API recovery field and map it to a validated client recovery ID.
- Preserve mandatory preparation, post-checkpoint ownership, and explicit same-key preparation replay.
- Preserve explicit `sandboxId` ownership on every sandbox-targeted tool.
- Preserve required MCP creation idempotency keys.
- Preserve no-retry semantics for ambiguous execution and secure-transfer consumption.
- Preserve account-scoped API identity. Embedded mode uses a non-user-visible local credential mapped to the local account.
- Never put credentials, provider references, provider IDs, protected URLs, source file contents, plaintext transfer bytes, commands, or raw provider bodies in API or MCP diagnostics.
- Preserve API request cancellation through core and provider operations.
- Preserve response-body cancellation when the client rejects or no longer needs a response.
- Preserve bounded secure-transfer and Bash output behavior.
- Keep the local SQLite file format compatible.
- Do not add backward-compatibility aliases for unpublished internal TypeScript APIs. Replace the prelaunch direct path cleanly once parity is proven.

## Phase Plan

### Phase 0: Baseline And Contract Lock

Status: complete

Scope:

- Record focused API, MCP, local API integration, full test, typecheck, MCP build, and diff-check baselines.
- Reconfirm the complete API route inventory and MCP tool inventory against current source.
- Add a written or test-local parity matrix for every current MCP command and every API primitive it requires.
- Record the current `preparing` lifecycle, mandatory `prepareSandbox`, same-key preparation replay, and post-checkpoint failure semantics.
- Record the exact `error.sandboxId` recovery envelope and every creation path that may produce it; separately record cancellation paths that preserve server state without returning an ID.
- Record current get/probe behavior for null-reference `provisioning`, referenced `provisioning`, `preparing`, `failed`, and stable live records.
- Record the existing `SandboxRuntimeArtifact` shape, MCP-adjacent artifact lookup, API-local development lookup, and removed system-template configuration.
- Record initialization ordering that currently opens SQLite before some artifact failures; treat that as extraction work, not behavior to preserve.
- Identify all MCP imports from `@waterbox/core`, provider types, concrete repositories, and concrete providers.
- Identify all local API composition code that must move out of `apps/api-local`.
- Confirm no live provider credentials are loaded and no live requests occur.

Acceptance criteria:

- Every current MCP command has a recorded target client command and API operation sequence.
- `probeSandbox` is recorded as a missing API operation rather than mapped to ordinary get.
- Secure transfer and Bash are recorded as composite commands.
- Environment-specific local file acquisition is recorded as MCP-owned.
- Preparation success, definite failure, ambiguity, cancellation, reconstruction, same-key replay, and deletion have parity rows.
- No Phase 0 assumption refers to `BOX_SYSTEM_TEMPLATE_REF` or a provider system template.
- Existing failures, if any, are recorded before implementation rather than attributed to the refactor.

Verification:

```sh
bun test packages/sandbox-api/test packages/mcp/test apps/api-local/test
bun run typecheck
bun run build:mcp
git diff --check
```

### Phase 1: Canonical API Contract Closure

Status: complete

Scope:

- Add an authenticated provider-probe API operation with exact `core.probeSandbox` semantics.
- Add `probeSandbox` to the structural `WaterboxCore` surface consumed by `@waterbox/api`.
- Formalize Bash observation and cleanup as supported client-consumable API primitives.
- Move every API/client-shared tool argument map, tool event map, Bash job observation type, and Bash observation request/result schema out of core provider types and into `@waterbox/contracts`. Phase 1 may update MCP type-only imports so repository typecheck remains green; it must not change MCP runtime behavior.
- Register Bash observation and cleanup through the same validated route machinery as other API operations, or provide equally strict explicit validation and OpenAPI coverage.
- Remove the current behavior where malformed hidden Bash input can become an internal `500` through uncaught Zod parsing.
- Preserve cancellation during bearer resolution instead of converting an aborted resolver into `401`; cover both pre-aborted requests and abort during asynchronous identity resolution.
- Preserve cancellation through every API handler and the global error boundary. An abort from body reading, core, provider, stream setup, or identity resolution must remain cancellation rather than becoming `401`, `500`, or a fabricated API envelope.
- Preserve bearer authentication and account ownership on probe and Bash job operations.
- Preserve all existing API routes not involved in the change.
- Preserve public `preparing` responses and optional `error.sandboxId` recovery envelopes across the API boundary.

Settled route semantics:

```text
probe sandbox
    -> active provider inspection
    -> account-scoped reconciliation
    -> public Sandbox DTO

observe Bash job
    -> one bounded sample by job ID, offset, and max bytes
    -> no polling loop in the API handler

cleanup Bash job
    -> one bounded cleanup request
    -> no client workflow policy in the API handler
```

Exact route names may follow existing route conventions, but they must be canonical, authenticated, schema-documented, and consumed by the new client without an undocumented `/internal` dependency. Because Waterbox is prelaunch, replace the hidden route directly rather than maintaining aliases unless a concrete external consumer is discovered.

Acceptance criteria:

- API probe tests prove stable records trigger provider inspection and ordinary get does not acquire probe semantics.
- API probe tests prove provider-ready `preparing` remains `preparing`, null-reference `provisioning` is not inspected, and provider failure/termination reconciles according to current core semantics.
- Get and probe tests prove referenced `provisioning` can checkpoint and execute preparation, returning `running` or the canonical recovery error.
- Probe tests prove failed-state stickiness and termination reconciliation.
- Cross-account probe and Bash job access return non-revealing not-found behavior.
- Bash observation request and response validation is canonical and shared.
- The future client can type every required API request, tool event, and Bash observation without importing core provider types.
- Malformed Bash observation input returns a bounded public client error, not `500`.
- Authentication cancellation remains cancellation and is not misreported as invalid credentials.
- Cancellation before routing and during body reading, core/provider execution, and stream setup remains the original abort rather than a generic API response.
- OpenAPI includes every client-consumed API primitive.
- OpenAPI and contract tests include `preparing` and optional canonical `error.sandboxId` without exposing provider details.
- No API handler polls until Bash completion.
- Any Phase 1 MCP edit is limited to type-only imports required by contract relocation; no MCP runtime behavior changes are allowed.

Verification:

```sh
bun test packages/sandbox-contracts packages/sandbox-core/test packages/sandbox-api/test
bun run typecheck
git diff --check
```

### Phase 2: Reusable `@waterbox/client`

Status: complete; depends on Phase 1

Scope:

- Add the `@waterbox/client` workspace package.
- Define `ApiBackend`, `WaterboxClient`, command option/progress types, and safe client errors.
- Add a small `createRemoteApiBackend` implementation that accepts a root API origin and an injected, already-authenticated Fetch implementation; OAuth acquisition and persistence remain external.
- Implement all initial client commands against standard `Request` and `Response` objects.
- Centralize API path construction, HTTP methods, content types, idempotency headers, response limits, body cancellation, error-envelope parsing, and NDJSON decoding.
- Implement composite Bash observation and cleanup in the client.
- Implement secure-transfer initiation, encryption, and consumption in the client using plaintext bytes supplied by the caller.
- Parse `preparing` through the canonical sandbox schema and preserve a present `error.sandboxId` as `WaterboxClientError.recoverySandboxId`.
- Keep creation replay caller-controlled; `createSandbox` sends exactly one request per invocation even when an error carries a recovery ID.
- Propagate caller cancellation as cancellation. A canceled create without a response recovery envelope must not become a `WaterboxClientError` with an invented recovery ID; callers recover with the same idempotency key.
- Keep local path access and MCP notification formatting out of the package.
- Test the client against an injected fake Fetch implementation and against an in-memory real `@waterbox/api` application where practical.

Client API guidance:

```ts
const client = new WaterboxClient(apiBackend)

await client.createSandbox(input, { idempotencyKey, signal })
await client.read(input, { signal })
await client.bash(input, { signal, onProgress })
await client.sendFileSecurely({ sandboxId, plaintext, targetPath }, { signal })
await client.close()
```

Do not expose raw `Response` objects from product commands. Do not make callers parse NDJSON or API error envelopes.

Acceptance criteria:

- The package imports contracts but no core, provider, repository, API-server, MCP, or app code.
- Remote backend construction rejects credentials, query, fragment, and non-root pathnames in the origin, preserves request signals, performs no implicit retries, and closes idempotently.
- Every current MCP product operation has a client command.
- Simple commands make exactly one expected API request.
- `bash` makes one execution request and only observes when the result is dispatched.
- Bash observation honors offsets, chunk bounds, cancellation, output truncation, terminal drain, progress callbacks, receipt fallback, and cleanup deadlines.
- `sendFileSecurely` makes exactly the initiation and consumption requests, never sends plaintext to the API, independently validates plaintext size, validates expiry and ciphertext bounds, does not mutate caller-owned plaintext, and clears mutable client-owned ciphertext best effort.
- Errors expose only safe canonical API fields.
- Client errors reject malformed recovery IDs, preserve valid recovery IDs through embedded and network backends, and never include provider detail.
- Creation tests cover `running`, `preparing`, definite preparation failure, ambiguous preparation, and explicit same-key replay without an automatic retry.
- Cancellation tests distinguish an API recovery error carrying `error.sandboxId` from an aborted request that exposes no ID.
- JSON, error, NDJSON line, pending-line, and total stream limits use the settled named bounds; every overflow cancels the response body and is covered directly.
- Mutating operations are not blindly retried.
- `close` closes the backend once and is idempotent.

Verification:

```sh
bun test packages/client/test packages/sandbox-api/test
bun run typecheck
git diff --check
```

### Phase 3: Embedded Local `ApiBackend`

Status: complete

Scope:

- Add `@waterbox/control-plane-local`.
- Move reusable local composition out of `apps/api-local/src/app.ts`.
- Construct SQLite repositories, the Box provider or an injected provider test override, `SandboxService`, a local identity resolver, and `@waterbox/api` in one shared composition factory.
- Export a raw local control-plane factory that accepts an identity resolver for `api-local`, plus a convenience embedded-backend factory that internally generates a private credential and uses the same raw composition. Do not duplicate construction rules.
- Use a synthetic local origin and a process-private local bearer credential.
- Reuse the existing provider `SandboxRuntimeArtifact` contract; do not duplicate its shape in the client or local-control-plane package.
- Preserve runtime artifact loading as a caller-owned composition concern.
- Require the caller to supply the validated `SandboxRuntimeArtifact` needed by a real Box provider. The package must not import MCP, locate `packages/mcp/dist`, or build artifacts itself.
- Preserve current Box configuration fields (`apiBaseUrl`, API key, polling, and injected artifact) and injected provider test overrides. Do not restore `systemTemplateRef`; this refactor does not introduce a provider registry.
- Reject missing or unsupported provider selection before opening SQLite or loading artifacts where the existing provider-neutral startup contract requires side-effect-free guidance.
- For a real Box composition, require explicit Box selection and a validated artifact. An injected provider override bypasses Box artifact loading but must satisfy the current mandatory provider contract, including `prepareSandbox`.
- Order initialization as: the MCP/app caller loads the artifact; local composition parses selection/configuration, receives the already loaded artifact, constructs the provider so it defensively validates the artifact, creates the SQLite parent, then opens SQLite and constructs core/API. Close SQLite once on every later failure.
- Preserve first-run creation of the SQLite parent directory with mode `0700` for filesystem paths; skip directory creation for `:memory:`.
- Make ownership and cleanup explicit when initialization fails partway through.

The package must expose two intentionally distinct surfaces:

```ts
interface LocalControlPlane {
  fetch(request: Request): Promise<Response> // raw API handler; resolver is caller-supplied
  close(): Promise<void>
}

function createLocalControlPlane(
  config: LocalControlPlaneConfig,
  identityResolver: IdentityResolver,
): Promise<LocalControlPlane>

function createEmbeddedApiBackend(
  config: LocalControlPlaneConfig,
): Promise<ApiBackend> // owns a private resolver and decorates requests
```

The exact API may differ to make single ownership clearer, but `api-local` must supply its configured development resolver and serve the raw handler, while MCP must consume only the private authenticated backend. Closing the embedded backend closes its internally owned raw control plane exactly once. The embedded backend must replace or reject caller-supplied `Authorization` rather than allowing credential smuggling.

The embedded backend must not:

- Call `Bun.serve`, Node HTTP, or any listener API.
- Bind a port.
- Depend on MCP.
- Write its bearer credential to configuration, stdout, diagnostics, or SQLite.
- Serve the private authenticated wrapper through a public listener.
- Locate or build the MCP-bundled sandbox artifact.
- Default silently to Box when provider selection is absent at a layer where provider-neutral setup behavior is required.

Acceptance criteria:

- A complete client flow runs through `Request -> api.fetch -> core -> fake provider` without a socket.
- API authentication is exercised in embedded mode rather than bypassed.
- The raw handler rejects missing and incorrect bearer credentials, while the private embedded backend authenticates using only its generated credential.
- A supplied external Authorization header cannot replace the embedded backend's identity.
- SQLite opens once per embedded backend and closes once.
- A first-run filesystem database succeeds when its parent directory does not exist and creates the private parent with mode `0700`.
- Reconstruction from the same SQLite file preserves existing resource records.
- Initialization failure closes any opened store.
- Missing artifacts fail in the caller before local composition; invalid loaded artifacts fail during provider construction before SQLite directory creation or database opening.
- No system-template reference appears in local configuration, provider construction, tests, or documentation.
- Cancellation crosses the in-process Fetch boundary.
- No package cycle is introduced.
- The package depends on `@waterbox/client` only for the shared `ApiBackend` contract and the client does not depend back on this package.

Verification:

```sh
bun test packages/control-plane-local/test packages/client/test packages/sandbox-api/test apps/api-local/test
bun run typecheck
git diff --check
```

### Phase 4: MCP As Client Command Renderer

Status: complete

Scope:

- Replace the supported MCP's direct `SandboxService` backend with `WaterboxClient` over an `ApiBackend`.
- In configured local Box mode, load and validate the existing sandbox runtime artifact adjacent to the packaged MCP bundle before local composition can create the SQLite directory or open the database, then pass it into `@waterbox/control-plane-local`.
- Keep the MCP tool list and agent-facing schemas stable.
- Map each ordinary MCP tool to exactly one client command.
- Split local secure file acquisition from transfer orchestration: MCP reads and clears plaintext; client performs the transfer workflow.
- Map client Bash progress into MCP progress notifications.
- Map typed client errors into safe MCP `isError` results.
- Replace the MCP runtime dependency on core `SandboxRecoveryError` with `WaterboxClientError`; preserve validated recovery sandbox IDs and actionable same-key replay/probe/delete guidance.
- Preserve unconfigured startup and provider setup guidance without opening SQLite, loading the runtime artifact, reading local files, or contacting a provider.
- Preserve signal handling and close client/backend resources on MCP shutdown.
- Remove MCP imports of core provider event types by moving shared API/client contracts into `@waterbox/contracts` as needed.
- Remove the successful direct-core execution path after parity tests pass.
- Keep the user-facing `WATERBOX_PROVIDER=waterbox` branch unsupported until a separately designed authentication contract exists. This phase proves remote capability through injected backend tests; it does not ask users for static cloud credentials.

The MCP composition should reduce to:

```text
parse configuration
    -> unconfigured guidance, or construct ApiBackend
    -> construct WaterboxClient
    -> register MCP tools over client commands
    -> connect stdio transport
```

Acceptance criteria:

- Supported configured MCP operations pass only through `WaterboxClient` and `@waterbox/api`.
- No MCP production source constructs `SandboxService`, `SqliteRepositoryStore`, or `BoxSandboxProvider` directly.
- No MCP production source invokes core methods directly.
- No MCP production source imports core error classes or core/provider runtime types after shared contracts move.
- Existing MCP tool names, input schemas, and output behavior remain covered.
- Secure plaintext never enters API request bodies or model-visible output.
- Bash still returns one completed result when observation succeeds and a recovery receipt when observation stops.
- Unconfigured mode remains side-effect free.
- The built MCP remains Node-compatible and contains no localhost listener.
- An installed/packed MCP can locate and inject its bundled sandbox CLI artifact without source-tree paths or a dependency from local control-plane code back to MCP.
- A create error carrying `recoverySandboxId` remains an MCP error with the public recovery handle and no provider detail; MCP does not automatically replay it.

Verification:

```sh
bun test packages/mcp/test packages/client/test packages/control-plane-local/test packages/sandbox-api/test
bun run typecheck
bun run build:mcp
node --check packages/mcp/dist/waterbox.js
node --check packages/mcp/dist/waterbox-cli.js
git diff --check
```

### Phase 5: Thin `api-local` Trigger

Status: complete; depends on Phase 3 and should land before final Phase 6 verification

Scope:

- Replace composition in `apps/api-local` with a call to `@waterbox/control-plane-local`.
- Keep `apps/api-local` responsible only for environment parsing, optional local-listener configuration, `Bun.serve`, logging the bound address, signals, and shutdown.
- Keep development-only sandbox artifact build/load behavior in the app layer and inject the resulting artifact into local control-plane construction. Prefer an explicit sandbox CLI build output; do not make the extracted package treat `packages/mcp/dist` as a reusable artifact store.
- Preserve existing local API behavior and development authentication configuration where it remains externally invoked.
- Avoid creating a second embedded composition implementation in the app.
- Permit the experimental control-plane script to update its composition import and artifact injection so it continues to use a real listener; do not change or promote the experimental MCP behavior.

Acceptance criteria:

- The app contains no direct `SandboxService`, SQLite repository, or Box provider construction.
- The app starts the same API through a real listener for development and integration testing.
- The listener serves the raw API handler and still returns `401` for missing or incorrect development bearer credentials; it never serves the embedded private-auth wrapper.
- Listener startup failure closes the embedded control plane.
- Graceful shutdown stops the server and closes the backend once.
- Existing API-local integration tests pass through the extracted package.

Verification:

```sh
bun test apps/api-local/test packages/control-plane-local/test packages/sandbox-api/test
bun run typecheck
git diff --check
```

### Phase 6: Embedded And Network Parity

Status: complete; depends on Phases 4 and 5

Scope:

- Run one client conformance suite against an embedded `ApiBackend` and a real local HTTP listener backend.
- Verify that presentation behavior does not depend on whether Fetch is in-process or networked.
- Cover all current commands, composite workflows, cancellation, malformed responses, streaming, errors, and cleanup.
- Add static dependency checks preventing MCP from importing core/repository/provider production modules and preventing client from importing server packages.
- Remove obsolete direct backend code and tests only after replacement coverage exists.
- Keep the experimental HTTP-backed MCP unchanged and secondary; do not use it as production client code.
- Update current architecture documentation, package READMEs, and the standalone HTML diagram to reflect implemented behavior.
- Do not update another durable plan in this phase.

Required parity cases:

| Area | Required proof |
|---|---|
| Authentication | Embedded and network backends pass through bearer resolution |
| Creation | Explicit idempotency key, optional source snapshot, `preparing`, and artifact-backed preparation serialize identically |
| Preparation | Success, definite failure, ambiguity, cancellation without an assumed recovery ID, reconstruction, and same-key resume preserve current state and ownership semantics |
| Probe | Calls active probe route, not ordinary get; referenced `provisioning` may prepare, provider-ready `preparing` remains `preparing`, and failed-state stickiness is preserved |
| Lifecycle | Current create/delete semantics, deletable `preparing`/failed resources, invalid-state guards, and recovery handles remain intact |
| Snapshots | List/create/delete contracts and cursors match |
| Tools | All seven tool arguments and canonical results match |
| NDJSON | Split chunks, multiple lines, empty streams, malformed events, terminality, and cancellation are handled |
| Bash | Completed and dispatched paths, output offsets, progress, truncation, fallback receipt, and cleanup match |
| Secure transfer | Plaintext remains client-side; initiation and consumption requests match |
| Errors | Status, public code, message, request ID, canonical `error.sandboxId`, body cancellation, and redaction match |
| Artifact | MCP-adjacent and development artifacts are caller-loaded, validated before SQLite side effects, and never discovered by the shared package |
| Shutdown | Client and backend closure are idempotent in both modes |
| No listener | Supported embedded MCP opens no local TCP port |

Authentication parity must include missing credentials, wrong credentials, pre-aborted requests, abort during asynchronous identity resolution, and proof that the embedded private-auth wrapper is never exposed by the real listener.

Acceptance criteria:

- The same command-level expectations pass against both backend implementations.
- The supported MCP has no shadow direct-core path.
- API route behavior is authoritative for both local and network-shaped consumers.
- Full repository tests and typecheck pass.
- MCP and sandbox CLI builds pass.
- Tests introduce no externally supplied, persisted, live-provider, or production credentials; ephemeral bearer values remain mandatory. No live provider calls or leaked generated runtime state are introduced.
- Documentation describes actual implementation rather than target behavior.
- `@waterbox/client` and `@waterbox/control-plane-local` remain bundled workspace internals and do not create a public MCP library export or add source packages to the shipped tarball.

Verification:

```sh
bun test
bun run typecheck
bun run build:mcp
bun run test:api-local
node scripts/build-waterbox.mjs cli
node --check packages/mcp/dist/waterbox.js
node --check packages/mcp/dist/waterbox-cli.js
node --check packages/sandbox-cli/dist/waterbox-cli.js
npm pack --dry-run ./packages/mcp
git diff --check
```

## Testing Strategy

### Contract Tests

Use canonical schemas at every serialization boundary. Client tests must reject successful HTTP responses whose bodies do not satisfy contracts, even if a fake backend returns them.

Test exact request facts:

- Method and absolute URL.
- Content type and accept headers.
- Idempotency header.
- Authorization presence as observed by the API, without snapshotting credentials.
- Exact JSON shape.
- Abort signal propagation.
- Abort propagation before and during bearer identity resolution.
- Response body cancellation after failures.

### Embedded Tests

Exercise the actual `@waterbox/api` Fetch handler with fake core/provider dependencies and temporary SQLite. Do not replace the embedded API with a direct fake core in client conformance tests.

### Network Tests

Use a real local listener on an ephemeral port only in tests and the explicit API-local app. Network parity tests use ephemeral bearer values and fake providers; they require no external or production credentials.

### MCP Renderer Tests

MCP unit tests may stub `WaterboxClient` commands to isolate presentation behavior. At least one integration suite must connect an MCP client through the real Waterbox client and embedded API to prove the full stack.

Credential-free product-flow tests must cover a create failure with a canonical recovery ID, retain that ID, and perform only tracked probe/delete or explicit same-key replay. Any separately authorized live smoke remains outside this plan.

### Secret Tests

Retain and expand assertions that secrets and plaintext do not appear in:

- MCP content or structured content.
- API request logs.
- API error envelopes.
- Client error messages.
- Provider diagnostics.
- SQLite records.
- Test snapshots and failure output.

## Expected File Impact

Likely additions:

```text
packages/client/package.json
packages/client/src/index.ts
packages/client/src/backend.ts
packages/client/src/client.ts
packages/client/src/errors.ts
packages/client/src/ndjson.ts
packages/client/src/bash.ts
packages/client/src/secure-transfer.ts
packages/client/test/*

packages/control-plane-local/package.json
packages/control-plane-local/src/index.ts
packages/control-plane-local/test/*
```

Likely modifications:

```text
package.json
bun.lock
tsconfig.json only if required by new source placement

packages/sandbox-contracts/src/*
packages/sandbox-api/src/app.ts
packages/sandbox-api/src/types.ts
packages/sandbox-api/src/index.ts
packages/sandbox-api/test/app.test.ts

packages/mcp/package.json
packages/mcp/src/backend.ts or its replacement
packages/mcp/src/config.ts
packages/mcp/src/direct.ts
packages/mcp/src/main.ts
packages/mcp/src/server.ts
packages/mcp/src/bash-observation.ts
packages/mcp/src/secure-transfer.ts
packages/mcp/test/*

apps/api-local/package.json
apps/api-local/src/app.ts
apps/api-local/src/main.ts
apps/api-local/src/server.ts
apps/api-local/test/*

scripts/build-waterbox.mjs if workspace resolution requires it
scripts/direct-mcp-smoke.ts
scripts/direct-mcp-smoke.test.ts
scripts/control-plane-mcp-experiment.ts
docs/current-module-composition.html
relevant package and root README files
```

Expected late deletions after parity:

```text
direct MCP backend code that composes core directly
duplicated MCP Bash HTTP-independent observation logic moved into client
duplicated MCP secure-transfer orchestration moved into client
local API composition code superseded by @waterbox/control-plane-local
```

Do not delete the experimental control-plane MCP in this plan.

## Review Checklist

Before declaring the refactor complete, review through these independent lenses:

### Architecture

- Is `@waterbox/api` the only product boundary into core?
- Does client depend only on contracts and client-side libraries?
- Are local and remote differences isolated to `ApiBackend`?
- Is embedded composition outside the client package?
- Did any new shadow contract appear in MCP?

### Protocol

- Are all client-consumed operations documented and validated API routes?
- Is probe distinct from get?
- Are `preparing`, same-key preparation replay, and post-checkpoint ownership preserved?
- Is `error.sandboxId` validated and retained without becoming provider identity?
- Are NDJSON terminal and cancellation semantics explicit?
- Are composite workflows built only from bounded primitives?

### Security

- Does embedded mode exercise authentication?
- Are tokens and provider credentials absent from errors and persistence?
- Does secure transfer keep plaintext out of API requests?
- Are account and job ownership enforced on every route?

### Reliability

- Are mutations never blindly retried?
- Are response bodies cancelled on parse and transport failures?
- Are stores closed on partial initialization and shutdown?
- Are provider/artifact failures rejected before SQLite side effects where possible?
- Does Bash recover with a receipt when observation stops?

### Product Parity

- Are current MCP names, schemas, and useful errors preserved?
- Does local mode require no port or daemon?
- Can the same client run against a network backend in tests?
- Could a future presentation import the client without importing MCP?

### Scope

- Were OAuth, billing, WebMCP, MCP Tasks, lifecycle jobs, and experimental-package deletion left out?
- Were other durable plans left unchanged?
- Did the implementation avoid unnecessary generic renderer or code-generation frameworks?

## Stopping Condition

This plan is complete when:

1. Every current supported MCP product operation is a reusable `@waterbox/client` command.
2. Every client command uses canonical authenticated API operations.
3. The supported local MCP uses an embedded Fetch backend and performs no direct core calls.
4. `apps/api-local` is a thin real-listener trigger over the shared embedded composition.
5. Embedded and network backend conformance suites pass.
6. Full tests, typecheck, MCP builds, Node syntax checks, and diff checking pass.
7. No local listener is required by the supported MCP.
8. No live provider call or external, persisted, provider, or production credential is required for completion; ephemeral authentication values are exercised.
9. Documentation reflects the implemented architecture.
10. Other durable plans remain unmodified.

At that point implementation stops. OAuth, cloud deployment, hosted MCP, WebMCP rendering, MCP Tasks, universal request-duration enforcement, lifecycle operation resources, and experimental-package removal require separate decisions or plans.

## Implementation Log

- 2026-08-31: Standalone plan created. It records the existing MCP-to-core shadow contract, makes `@waterbox/api` canonical for embedded and remote-shaped consumers, introduces reusable client commands over an injected `ApiBackend`, keeps MCP as a presentation renderer, separates local file acquisition from secure-transfer orchestration, moves Bash observation policy into the client, and explicitly defers cloud, OAuth, WebMCP, MCP Tasks, lifecycle-job, daemon, and release-plan work. No implementation, provider credential access, live provider operation, or change to another plan occurred.
- 2026-08-31: Baseline amended after concurrent lifecycle and Box preparation work. The plan now preserves canonical `preparing`, mandatory provider preparation, same-key preparation resume, exact `error.sandboxId` recovery, artifact-backed plain-Box bootstrap, removed system-template configuration, current get/probe distinctions, artifact-before-SQLite initialization, and expanded embedded/network parity. No Fetch-backed implementation or edit to another durable plan occurred.
- 2026-09-01: Phase 0 completed. `docs/fetch-backed-client-phase-0-contract.md` records the current MCP-to-client/API parity matrix, complete API and MCP inventories, missing probe route, composite secure-transfer and Bash workflows, MCP-owned file acquisition, preparation/recovery/cancellation/reconstruction/deletion behavior, get/probe distinctions, runtime-artifact lookup and initialization ordering, direct MCP dependencies, and API-local extraction scope. No credential values were read and no live provider request occurred. Baseline verification found an incomplete dependency installation: the focused run passed all 14 sandbox API tests but could not load MCP/API-local suites; the repository-wide run passed 218 tests and reported 11 load failures; typecheck and MCP build also failed on unresolved workspace/external packages. `git diff --check` passed.
- 2026-09-01: Phase 1 completed. The authenticated API now exposes canonical provider probe plus schema-validated, OpenAPI-documented Bash observation and cleanup primitives; hidden `/v1/internal` Bash routes were replaced. Tool argument/event maps and Bash observation request/result contracts now live in `@waterbox/contracts`, with safe-integer bounds on observation offsets and sizes. Supported MCP changes were limited to type-only import relocation. Request aborts remain aborts before routing, during asynchronous bearer resolution and bounded body reads, from core/provider execution and stream setup, and through the global error boundary. Real-core API coverage proves referenced-provisioning preparation recovery through both ordinary get and probe with only the canonical recovery ID exposed. Focused contract/core/API verification passed 131 tests, repository typecheck passed, and `git diff --check` passed. No credential value was read and no live provider request occurred.
- 2026-09-01: Phase 2 completed. Added the private `@waterbox/client` workspace package with the deployment-neutral `ApiBackend`, immutable validated origin snapshots, validated no-retry remote backend, idempotent ownership cleanup, product-level commands for the complete supported MCP surface, exact per-operation success statuses, abort-aware bounded JSON/error/NDJSON decoding with active-reader cancellation, post-Fetch abort preservation, safe typed API and transport errors, validated recovery sandbox IDs, caller-controlled creation replay, composite Bash observation/progress/truncation/receipt-fallback/detached-cleanup policy, and caller-byte secure transfer using client-side age encryption. The package depends only on contracts and client-side libraries and contains no host-path or presentation logic. Focused client and API verification passed 51 tests, repository typecheck passed, and `git diff --check` passed. Tests used injected Fetch fakes and ephemeral encryption keys; no credential value was read and no live provider request occurred.
- 2026-09-01: Phase 3 completed. Added the private `@waterbox/control-plane-local` workspace package with one raw local composition factory and a private-auth embedded `ApiBackend` decorator. A discriminated provider selection requires Box configuration plus the caller-loaded runtime artifact for real Box composition, while injected test providers require and inspect neither. Composition validates selection, the mandatory injected-provider contract, or the Box artifact before filesystem or SQLite effects, creates first-run database parents with mode `0700`, skips parent creation for `:memory:`, and closes an opened store exactly once on later failure or repeated shutdown. Embedded requests use the synthetic `http://waterbox.local/` origin, replace caller authorization with an in-memory generated bearer, and traverse normal API authentication without a listener. Tests proved raw missing/wrong credential rejection, a complete client/API/core/fake-provider creation flow, authorization replacement, single open/close ownership, reconstruction, pre-SQLite selection/provider/artifact rejection, cancellation, and dependency-boundary exclusions. Focused control-plane/client/API/API-local verification passed 65 tests, repository typecheck passed, and `git diff --check` passed. No credential value was read, persisted, or logged, and no live provider request occurred.
- 2026-09-01: Phase 4 completed. The supported MCP now renders `WaterboxClient` commands over an embedded authenticated `ApiBackend`; local Box composition loads and validates the MCP-adjacent bundled sandbox CLI before control-plane construction, while unconfigured and unsupported modes preflight before file, artifact, SQLite, or provider effects. The MCP retains its exact 14-tool inventory and schemas, delegates each ordinary operation and Bash observation to one client command, maps content-free progress notifications, reads and clears host plaintext while the client owns encryption and transfer, and renders safe client recovery errors with explicit same-key replay/probe/delete guidance. Direct core/backend, duplicated Bash observation, and MCP-side encryption paths were removed. An MCP integration test traverses client, authenticated API, core, SQLite, and an injected provider without a listener. Focused verification passed 68 tests, repository typecheck and MCP builds passed, both Node syntax checks passed, the packed artifact contained the adjacent sandbox CLI, an installed-shaped built import located and validated it without a source-tree path, and `git diff --check` passed. No credential value was read and no live provider request occurred.
- 2026-09-01: Phase 4 review follow-up closed the host-file buffer ownership gap: partial-read, abort, validation, and handle-close failures now wipe allocated plaintext before propagating, and ownership transfers to the caller only after a successful handle close. A deterministic partial-read abort test captures only the mutable allocation and proves it is zeroed without exposing its contents. Focused verification passed 69 tests; repository typecheck, MCP builds, both Node syntax checks, package dry-run, installed-shaped adjacent-artifact validation, and `git diff --check` passed. No credential value was read and no live provider request occurred.
- 2026-09-01: Phase 5 completed. `apps/api-local` is now a thin development listener over the raw `@waterbox/control-plane-local` handler: it owns strict environment parsing, fixed development bearer resolution, explicit sandbox CLI artifact loading, listener configuration, bound-address logging, signals, and single-owner shutdown, while core, SQLite, and Box construction remain in the shared package. Development startup and the experimental listener explicitly build and inject `packages/sandbox-cli/dist/waterbox-cli.js` rather than using the MCP bundle. Integration coverage proves the real listener rejects missing and wrong bearer credentials, closes the control plane on listener startup failure, and stops the server and closes the control plane once on repeated shutdown. Focused API-local/control-plane/API verification passed 36 tests; the explicit sandbox CLI build and app-layer artifact load passed; repository typecheck and `git diff --check` passed. No credential value was read and no live provider request occurred.
- 2026-09-01: Phase 5 review follow-up made listener setup transactional after `Bun.serve`: if bound-address logging throws, the newly bound server is stopped and the raw control plane is closed exactly once before the original logging error is rethrown, even when cleanup itself fails. A deterministic test proves the original error identity, single close call, and immediate rebinding of the released port. Focused verification passed 37 tests; repository typecheck and `git diff --check` passed. No credential value was read and no live provider request occurred.
- 2026-09-01: Phase 6 completed. One command-level conformance suite now runs unchanged against the private-auth embedded Fetch backend and a real ephemeral authenticated HTTP listener, proving creation/probe/delete, snapshots, all seven tools, secure-transfer ciphertext-only transport, pre-abort propagation, and idempotent shutdown parity. The existing client, API, core, API-local, and MCP suites retain the required preparation/recovery, NDJSON, Bash observation/truncation/fallback/cleanup, safe-error/body-cancellation/redaction, artifact-ordering, authentication-resolution, and listener-free full-stack proofs. Static tests enforce client and supported-MCP dependency boundaries. Current architecture documentation and package READMEs describe the implemented API-backed composition; no other durable plan changed. A pre-existing timing-sensitive sandbox CLI assertion was made deterministic by bounded polling and passed twice. Final verification passed 401 repository tests, typecheck, MCP and sandbox CLI builds, 9 API-local integration tests, all three Node syntax checks, MCP package dry-run with exactly six intended files, and `git diff --check`. Tests used ephemeral bearer values and fake providers; no `.env` value was read, no live provider request occurred, and no runtime state was leaked.
- 2026-09-01: Phase 6 release-review follow-up expanded the same shared conformance scenarios across both embedded and real ephemeral HTTP transports instead of relying on separate layer tests for failure paths. The 20 transport cases now cover missing/wrong authentication and identity-resolution abort, source snapshots and cursor continuation, ambiguous preparation recovery and explicit replay after SQLite reconstruction, active probe and failed-state behavior, invalid post-deletion operations, split/multiple/empty/malformed/post-terminal NDJSON with cancellation, completed and dispatched Bash offsets/progress/truncation/fallback/cleanup, canonical recovery and malformed bounded error bodies with redaction/cancellation, secure-transfer plaintext isolation and ambiguous consumption, and idempotent shutdown. Static guards now inspect static, side-effect, re-export, dynamic-import, and `require` forms plus package runtime dependencies; self-tests prove those bypasses are detected, and MCP's only provider exception is the exact static `loadSandboxRuntimeArtifact` symbol. Final verification passed 419 repository tests, typecheck, MCP and sandbox CLI builds, 9 API-local integration tests, all three Node syntax checks, MCP package dry-run with exactly six intended files, and `git diff --check`. No secret was read, no live provider request occurred, and no runtime state leaked.
