# Waterbox Control Plane V1

Status: remediated and live-calibrated through Phase E; Phases F and G are ready to begin

This document is the stable architecture and phase-status plan for the Waterbox control plane. The approved cleanup of the draft implementation is tracked separately in [`control-plane-v1-remediation.md`](./control-plane-v1-remediation.md); that remediation plan governs until its stopping condition is met.

## How To Use This Plan

Before implementing a phase:

1. Read this entire document.
2. Read the phase and every phase it depends on.
3. Inspect the current worktree. Preserve unrelated and concurrent changes.
4. Implement only the assigned phase and its stated acceptance criteria.
5. Run the phase verification plus the repository-wide tests and typecheck.
6. Update that phase's status and append a short entry to the implementation log.

Do not reinterpret settled decisions inside a phase. If a requirement is impossible or contradictory, stop and report the exact blocker instead of inventing a new architecture.

## Objective

Build a provider-neutral sandbox control plane from the core outward:

```text
API consumer
    |
    v
@waterbox/api (Hono HTTP application)
    |
    v
@waterbox/core
    |                 |
    v                 v
repositories       providers
                      |
                      v
              shared sandbox daemon
```

V1 runs the API locally, stores metadata in SQLite using DynamoDB-compatible key-value access patterns, and provisions Box sandboxes. A later deployment can replace the local runtime and repositories with Lambda and DynamoDB without changing core, API routes, or providers.

The local MCP is intentionally deferred until the HTTP API and everything behind it are complete.

## Settled Decisions

- Package scope: `@waterbox/*`.
- Existing packages are preserved as working v0 references during this project.
- New control-plane code is built in parallel rather than by rewriting v0 in place.
- The HTTP API is the canonical public interface.
- There is no hosted/remote MCP interface.
- A later local stdio MCP will call the HTTP API and may retain an active sandbox selection in process memory.
- Hono is shared in `@waterbox/api`; local and future Lambda apps are thin runtime adapters.
- Zod schemas are canonical runtime contracts. `@hono/zod-openapi` generates OpenAPI 3.1 routes and documents.
- Core receives resolved identities. It never parses credentials.
- API-key authentication is represented now by an identity resolver port. V1 uses one configured development key mapped to one fixed account ID.
- Sandbox and snapshot records are keyed by `(accountId, resourceId)`.
- Public resource IDs are readable random IDs, for example `sbx_calm-cactus-7k3m` and `snap_silver-forest-2p9x`.
- Sandbox creation uses `POST /v1/sandboxes` with an optional `Idempotency-Key` header.
- Idempotency is account-scoped and durable.
- Snapshot resources are immutable. Every capture creates a new Waterbox snapshot ID.
- Snapshot payloads remain provider-owned. Waterbox stores opaque provider references, not snapshot bytes.
- All full-Linux providers run the same Waterbox daemon and expose the same seven tools: read, write, edit, patch, glob, grep, and bash.
- Providers differ in lifecycle and in how they transport canonical daemon requests.
- Box is the first provider.
- Box user sandboxes use `noEnv: true` and never receive the Box account API key.
- Box follows the stop/resume-around-usage pattern. Stop archives the sandbox, resume restores the same sandbox, and delete is permanent.
- The Box daemon is baked into a deterministic named system snapshot, enabled as a systemd service, and exposed with Box protected hosting. The protected endpoint, including its `_token`, is secret provider state and is never returned publicly.
- The Box system template is deployment configuration, not a user snapshot record.
- A repeatable system-template build remains a pending, probe-driven Phase F deliverable. Its bootstrap box will omit `from`.
- Lambda MicroVM and Vercel Sandbox providers are expected later. Each provider composes mandatory lifecycle and tool transport with cohesive optional stop/resume and snapshot groups.
- Core and repository ports must not require joins, foreign keys, scans, or multi-record transactions.
- Commands and other potentially mutating operations are never automatically retried after an ambiguous provider failure.

## Package Graph

New packages:

```text
packages/sandbox-contracts          @waterbox/contracts
packages/sandbox-core               @waterbox/core
packages/sandbox-repository-sqlite  @waterbox/repository-sqlite
packages/sandbox-runtime            @waterbox/runtime
packages/sandbox-daemon             @waterbox/daemon
packages/sandbox-provider-box       @waterbox/provider-box
packages/sandbox-api                @waterbox/api
apps/api-local                      @waterbox/api-local (private)
```

Dependency direction:

```text
@waterbox/contracts
    ^
    +-- @waterbox/core
    |       ^
    |       +-- @waterbox/repository-sqlite
    |       +-- @waterbox/provider-box
    |
    +-- @waterbox/runtime
    |       ^
    |       +-- @waterbox/daemon
    |
    +-- @waterbox/api

apps/api-local composes api, core, repository-sqlite, and provider-box.
```

Allowed exception: provider packages may depend on contracts and the core provider types. The core package must never depend on a concrete provider or repository.

Deferred packages:

```text
@waterbox/client
@waterbox/mcp
@waterbox/repository-dynamodb
@waterbox/provider-lambda-microvms
apps/api-lambda
```

## V0 Preservation Boundary

Do not move, rename, or redesign these during phases A-H unless a phase explicitly says otherwise:

```text
packages/protocol
packages/receiver
packages/plugin
packages/pi-mcp
scripts/deploy.ts
scripts/smoke.ts
scripts/pi-mcp-chat.ts
scripts/pi-mcp-smoke.ts
```

Code may be extracted from `packages/receiver` in Phase D, but its existing imports, routes, tests, Docker image, and behavior must continue to work.

## Domain Model

### Identity

```ts
interface Identity {
  accountId: string
}
```

Resource IDs are locators, not credentials. Every core method receives `Identity` and every repository lookup includes `accountId`.

### Sandbox Record

The exact TypeScript representation belongs to Phase B, but it must contain:

```text
accountId
sandboxId
provider
providerRef (opaque JSON, never returned by public DTOs)
state
sourceSnapshotId?
version
createdAt
updatedAt
lastError?
```

Canonical states:

```text
provisioning
running
stopping
stopped
resuming
terminating
terminated
failed
```

Provider states are mapped into these states. Do not expose Box state names as canonical API states.

### Snapshot Record

```text
accountId
snapshotId
name?
description?
provider
providerRef (opaque JSON, never returned by public DTOs)
sourceSandboxId
state
version
createdAt
updatedAt
lastError?
```

Canonical states:

```text
creating
ready
failed
deleting
deleted
```

### Idempotency Record

Creation idempotency requires a separate key-value record:

```text
accountId
scope
key
requestHash
resourceId
state: in_progress | completed | failed
createdAt
expiresAt
```

The store key is `(accountId, scope, key)`. Reusing a key with a different request hash is a conflict. The record stores the generated sandbox ID before provider provisioning begins.

### Provider Contract

```ts
interface SandboxProvider {
  createSandbox(...): Promise<ProviderSandboxObservation>
  inspectSandbox(...): Promise<ProviderSandboxObservation>
  deleteSandbox(...): Promise<ProviderSandboxObservation>
  executeTool(...): AsyncIterable<ToolEvent>
  stopResume?: {
    stop(...): Promise<ProviderSandboxObservation>
    resume(...): Promise<ProviderSandboxObservation>
  }
  snapshots?: {
    create(...): Promise<ProviderSnapshotObservation>
    inspect(...): Promise<ProviderSnapshotObservation>
    delete(...): Promise<ProviderSnapshotObservation>
  }
}
```

Optional behavior is represented by the presence of a cohesive group, never by independent booleans. Creating from a provider snapshot is the generic fork operation and requires the snapshot group; there is no separate generic fork method. Box implements both optional groups and transports canonical streaming events through the Waterbox daemon.

### Tool Surface

Canonical tools:

```text
read
write
edit
patch
glob
grep
bash
```

All tools use the same Zod schemas and canonical results regardless of provider. Bash emits ordered NDJSON-compatible events:

```text
stdout
stderr
result
```

Non-streaming tools emit one final result event. Cancellation must propagate to the daemon and terminate bash execution.

## Public HTTP Surface

The initial canonical routes are:

```text
POST   /v1/sandboxes
GET    /v1/sandboxes
GET    /v1/sandboxes/{sandboxId}
POST   /v1/sandboxes/{sandboxId}/stop
POST   /v1/sandboxes/{sandboxId}/resume
DELETE /v1/sandboxes/{sandboxId}

POST   /v1/sandboxes/{sandboxId}/snapshots
GET    /v1/snapshots
GET    /v1/snapshots/{snapshotId}
DELETE /v1/snapshots/{snapshotId}

POST   /v1/sandboxes/{sandboxId}/tools/{toolName}

GET    /openapi.json
GET    /health
```

Rules:

- Public responses never contain `accountId`, provider credentials, `providerRef`, Box IDs, Box URLs, or Box tokens.
- List endpoints use opaque cursor pagination.
- Lifecycle creation and snapshot creation may return non-terminal resources.
- `GET` refreshes provider state when the local state is transitional or when provider reconciliation is required.
- Tool operations automatically resume a stopped Box and wait for readiness before invoking the daemon.
- Tool responses use NDJSON when events stream.
- HTTP status is authoritative; public error envelopes contain only stable code, message, and request ID fields, plus standard envelope discriminator or status fields explicitly defined by contracts, and reject arbitrary details.
- The generated OpenAPI document describes lifecycle and non-streaming response envelopes. The bash route also documents its NDJSON stream media type.

## Repository Access Patterns

Core repositories expose only aggregate-oriented operations:

```text
create-if-absent
get by account and resource ID
list sandboxes and snapshots by account with cursor and limit
compare-and-swap update by version
```

No core operation may depend on:

- Joins
- Foreign keys
- Arbitrary filtering
- Provider/state secondary indexes
- Cross-account scans
- Multi-record transactions
- Immediate TTL deletion

SQLite may use transactions internally to implement one-record compare-and-swap. Its behavior must map directly to DynamoDB `PutItem`, `GetItem`, partition `Query`, and conditional `UpdateItem`.

## Provider Contract Rules

- Provider references are opaque JSON values.
- Provider API keys and daemon connection credentials belong only to provider implementations.
- Provider create receives a stable provider idempotency key derived from the Waterbox sandbox record.
- Provider operations receive an `AbortSignal`.
- Provider execution returns canonical tool events, not provider-native responses.
- Provider code may know HTTP; core may not know provider endpoint or authentication shapes.
- Provider methods must distinguish definite failure from ambiguous execution failure.
- Core must not retry an ambiguous tool execution.
- A provider snapshot group creates, inspects, deletes, and authorizes use of provider-owned artifacts as create sources.
- Unsupported optional groups produce a typed core error before provider dispatch.

## Box-Specific Rules

- Create boxes with `noEnv: true`.
- Use `https://ascii.dev/api/box/v1` as the default full API base URL and compose resource paths without another `/v1`.
- Preserve `noEnv` and pass only the explicit non-secret `WATERBOX_SANDBOX_ID` environment tag; never place credentials or secret provider data in Box environment configuration.
- Pass only sandbox-specific configuration explicitly.
- Never pass `BOX_API_KEY` or account credentials into a sandbox.
- Create with `from` set to the configured internal named system snapshot unless a user named snapshot is supplied. Bootstrap creation for the system snapshot omits `from`.
- User snapshots remain based on the system template and therefore retain the daemon.
- The daemon binary and systemd service are baked into the system template.
- Register the daemon port using protected Box hosting and store the protected URL as secret provider state.
- Use the official `/boxes/{id}/host` contract with public access disabled and refresh the secret URL after resume.
- A successful stop preserves provider snapshots and pauses billing.
- Treat delete as permanent destruction, never as idle cleanup.
- Resume automatically before tool execution when required.
- Wait for `ready` or `idle` before daemon setup or calls.
- Snapshot capture is asynchronous and must be polled/reconciled.
- User and system snapshots use `POST /named-snapshots` and `GET`/`DELETE /named-snapshots/{name}`; statuses are `saving`, `ready`, and `failed`. Names are safe non-reserved 1..63 character handles, and the opaque provider reference stores the deterministic name.
- Generate an internal provider snapshot name from account and Waterbox snapshot IDs. Never use the optional user display name as provider identity.
- Account for Box's named-snapshot quota and return a provider-limit error without losing the Waterbox record.
- Never retry Box command execution after a `502` or another ambiguous direct failure.
- Upload files with JSON `{path, content, encoding: "base64"}` only under `/tmp` or `/home/user`; use a command for privileged installation targets.
- Permanent box deletion requires the exact `X-Ascii-Confirm-Delete` header and bounded polling of the returned deletion operation through `pending`, `processing`, `blocked`, or `completed`. Named snapshot deletion remains a separate name-based operation.

## Phase A: Workspace And Contracts

Status: completed

Dependencies: none

Goal: establish package scaffolding and canonical runtime contracts without implementing business logic.

Deliverables:

- Update root workspaces and TypeScript includes to cover `apps/*`.
- Add `@waterbox/contracts` with explicit exports.
- Add Zod and the minimum schema dependencies required by contracts.
- Define schemas and inferred types for identity, IDs, sandbox/snapshot DTOs, states, pagination, lifecycle requests, tool arguments, tool events, and errors.
- Keep internal records and provider references out of public DTO schemas.
- Define stable error codes required by later phases, including unauthorized, not found, conflict, idempotency conflict/in progress, invalid state, unsupported capability, provider failure, provider limit, and ambiguous execution.
- Add contract tests for valid and invalid examples for every public request schema.
- Add ID format schemas for `sbx_...` and `snap_...` without implementing generation yet.
- Add package README documentation describing public versus internal data.

Non-goals:

- Core ports or methods
- Hono routes
- OpenAPI generation
- Persistence
- Providers
- Changes to v0 protocol contracts

Acceptance criteria:

- Contracts have no Hono, database, Box, AWS, MCP, or Node runtime imports.
- All public request schemas reject unknown fields unless a specific schema documents extensibility.
- Tool schemas cover all seven canonical tools.
- `bun test` and `bun run typecheck` pass.

Delegation prompt:

> Read `docs/plans/control-plane-v1.md` and implement Phase A only. Preserve v0 packages. Complete every Phase A deliverable and acceptance criterion, run repository-wide tests and typecheck, then update Phase A status and the implementation log.

## Phase B: Core Ports And Domain Service

Status: completed with narrowed provider contract

Dependencies: Phase A

Goal: implement the transport-neutral application layer against in-memory test doubles.

Deliverables:

- Add `@waterbox/core`.
- Define `SandboxRepository`, `SnapshotRepository`, and `IdempotencyRepository` ports using the access patterns in this document.
- Define `SandboxProvider` with mandatory create/inspect/delete/tool methods and cohesive optional stop/resume and snapshot groups.
- Define internal sandbox, snapshot, and idempotency records with opaque JSON provider references.
- Define injected clock and readable-random ID generator ports.
- Implement create/get/list/stop/resume/delete sandbox methods.
- Implement create/get/list/delete snapshot methods.
- Implement tool execution delegation and automatic resume from stopped state.
- Implement account ownership by construction: every lookup is account-scoped.
- Implement compare-and-swap state transitions and bounded conflict retries only for metadata transitions.
- Implement account-scoped creation idempotency, request hashing, mismatch conflicts, and in-progress behavior.
- Pass a stable provider idempotency key into provider creation.
- Implement typed domain errors mapped to the Phase A error codes.
- Implement provider-state reconciliation for transitional sandbox and snapshot states.
- Add in-memory fake repositories and provider only under tests or test support exports.

Required tests:

- Two accounts can use the same resource ID without collision.
- One account cannot access another account's resource.
- Repeating create with the same idempotency key and body returns the same sandbox.
- Reusing an idempotency key with a different body fails.
- Concurrent creation with the same key does not create two provider resources.
- Unsupported optional groups are rejected before provider dispatch.
- Stop, resume, delete, and snapshot enforce valid state transitions.
- Snapshot capture works from running and stopped sandboxes.
- Execution resumes a stopped sandbox exactly once under concurrent calls.
- Ambiguous execution failures are returned and never retried.
- Provider references never appear in public DTOs.
- Compare-and-swap conflicts do not overwrite newer records.

Non-goals:

- HTTP or credential parsing
- SQLite
- Box API calls
- Background idle timers or reapers
- Distributed locks
- MCP

Acceptance criteria:

- Core has no Hono, SQLite, Box, AWS, MCP, or filesystem imports.
- Core methods receive `Identity` explicitly.
- Core tests use only in-memory adapters.
- `bun test` and `bun run typecheck` pass.

Delegation prompt:

> Read `docs/plans/control-plane-v1.md` and implement Phase B only. Assume Phase A contracts are canonical. Build transport-neutral core ports and services with comprehensive in-memory tests. Do not add HTTP, SQLite, Box, or MCP code. Run all tests and typecheck, then update Phase B status and the implementation log.

## Phase C: Dynamo-Shaped SQLite Repositories

Status: completed with simplified local persistence

Dependencies: Phase B

Goal: provide durable local metadata without introducing relational assumptions into core.

Deliverables:

- Add `@waterbox/repository-sqlite` using `bun:sqlite`.
- Implement all three core repositories.
- Store each aggregate as a versioned JSON document keyed by account and resource key.
- Use separate logical tables for sandbox, snapshot, and idempotency records; do not normalize provider references or relationships.
- Implement create-if-absent and version-conditional updates.
- Implement deterministic account-partition listing with opaque cursors.
- Bound page limits in contracts and repository behavior.
- Persist idempotency expiry as data but do not rely on automatic expiry for correctness.
- Add schema initialization that is safe to run repeatedly.
- Add close/disposal support for tests and local shutdown.

Required tests:

- Focused repository behavior tests cover all retained ports.
- Data survives closing and reopening the database.
- Account partitions remain isolated.
- Conditional updates fail on stale versions.
- Pagination has no duplicates or omissions across stable data.
- Malformed stored documents fail explicitly rather than being returned unchecked.
- The implementation does not issue cross-account scans for list operations.

Non-goals:

- DynamoDB implementation
- Migrations for already-deployed databases
- Secondary indexes
- Cleanup workers
- Core changes to accommodate SQLite

Acceptance criteria:

- Public repository behavior could be implemented with DynamoDB partition queries and conditional writes.
- No core test needs SQLite.
- `bun test` and `bun run typecheck` pass.

Delegation prompt:

> Read `docs/plans/control-plane-v1.md` and implement Phase C only. Implement Dynamo-shaped SQLite adapters for the Phase B repository ports. Do not add relational access patterns or change core to suit SQLite. Run focused persistence, repository-wide tests, and typecheck, then update Phase C status and the implementation log.

## Phase D: Shared Runtime And Daemon

Status: completed with simplified daemon

Dependencies: Phase A

Goal: extract the proven seven-tool Linux runtime and package it as the program every full-Linux provider installs.

Deliverables:

- Add `@waterbox/runtime` containing provider-neutral implementations for read, write, edit, patch, glob, grep, and bash.
- Add `@waterbox/daemon` as a thin HTTP host for the runtime.
- Reuse the proven path safety, atomic write, edit, patch rollback, bounded search/read, bash process-group termination, output truncation, NDJSON streaming, and cancellation behavior from `packages/receiver`.
- Keep the existing receiver working. Prefer moving shared implementation behind compatibility exports over copying divergent implementations.
- Make workspace root explicit daemon configuration.
- Expose health, canonical tool catalog, and canonical tool execution routes.
- Ensure bash streams stdout/stderr/final events in order.
- Support graceful shutdown and cancellation.
- Add a standalone build target suitable for installation as a systemd service in Box.
- Document required Linux binaries (`bash`, `rg`, `fd`, or whichever the extracted runtime actually requires).

Required tests:

- Existing receiver tests continue to pass unchanged or with import-only adjustments.
- Runtime tests cover all seven tools.
- Daemon contract tests invoke every tool through HTTP.
- Traversal and symlink protections remain intact.
- Bash streams before completion and cancellation kills the process tree.
- Runtime mutation requests follow the documented serialization behavior; the daemon adds no second queue.

Non-goals:

- Sandbox lifecycle
- Account authentication
- Box protected hosting
- Public control-plane routes
- Provider-specific code

Acceptance criteria:

- Runtime contains no Box, AWS, Hono control-plane, repository, or MCP imports.
- Daemon contains no sandbox lifecycle or account ownership logic.
- V0 smoke/deploy paths still compile.
- `bun test` and `bun run typecheck` pass.

Delegation prompt:

> Read `docs/plans/control-plane-v1.md` and implement Phase D only. Extract the proven receiver tool runtime into `@waterbox/runtime` and add the thin `@waterbox/daemon` host while preserving all v0 behavior. Do not implement lifecycle or provider code. Run all runtime, daemon, existing receiver tests, and typecheck, then update Phase D status and the implementation log.

## Phase E: Box Provider

Status: complete with live lifecycle capability calibration

Dependencies: Phases B and D

Goal: implement Box lifecycle, snapshots, and canonical daemon transport behind the core provider port.

Deliverables:

- Add `@waterbox/provider-box` using `fetch` against the Box Public API v1.
- Keep Box DTOs private to this package.
- Accept the full Box API base URL, API key, internal named system-snapshot reference, daemon port, polling configuration, and clock through configuration/dependencies.
- Implement create, inspect/reconcile, stop, resume, permanent delete, snapshot create/inspect/delete, and create-from-snapshot.
- Create user sandboxes with `noEnv: true`.
- Use Box idempotency headers for billable create/fork operations.
- Wait for ready/idle before daemon registration or execution.
- Register the daemon using protected Box hosting and retain the secret URL only in the opaque provider reference.
- Refresh/re-register daemon connection information after resume when required.
- Translate canonical daemon HTTP and NDJSON into core tool events.
- Propagate cancellation through daemon requests.
- Normalize Box lifecycle and errors into canonical provider states/errors.
- Treat Box `502 box_direct_failed` and equivalent outcomes as ambiguous for commands.
- Generate provider-safe internal snapshot names from account and Waterbox snapshot IDs.
- Parse operation-specific `{ok:true,type,...}` envelopes, correlate required identifiers, tolerate documented optional extensibility, and map `init/provisioning/provisioned/cloning/ready/idle/running/archiving/archived/error`.
- Poll asynchronous named snapshots by deterministic name through provider inspection rather than blocking indefinitely.
- Explicitly surface named-snapshot quota failures.
- Do not expose Box IDs, API keys, protected URLs, or tokens through public objects or error messages.

Required tests:

- HTTP contract tests use a fake Box server/fetcher and no real credentials.
- Create always sends `noEnv: true`, the non-secret `WATERBOX_SANDBOX_ID` tag, and `from` containing the configured internal named system snapshot.
- Create-from-snapshot sends the opaque provider named-snapshot name instead of the system snapshot.
- Provider create forwards a stable idempotency key.
- Stop maps to archive; resume restores the same Box; delete is permanent.
- A resumed sandbox obtains a usable daemon connection before execution.
- All seven tools are transported without provider-specific schema changes.
- Bash chunks remain ordered and are not buffered by the provider adapter.
- Cancellation aborts the daemon request.
- Ambiguous command failures are not retried.
- Secrets are redacted from thrown errors and serialized public forms.

Non-goals:

- Real Box smoke test; that belongs to Phase H
- Template build automation; that belongs to Phase F
- API routes
- Idle reaper
- Box SDK dependency unless `fetch` proves insufficient

Acceptance criteria:

- Focused fake-HTTP tests cover lifecycle, snapshots, every canonical tool, cancellation, identity continuity, and ambiguity handling.
- No Box type escapes the provider package.
- `bun test` and `bun run typecheck` pass.

Delegation prompt:

> Read `docs/plans/control-plane-v1.md` and implement Phase E only. Implement the Box provider against the core port and shared daemon contract using mocked HTTP tests. Follow all Box-specific security, lifecycle, idempotency, snapshot, streaming, and redaction rules. Do not add API routes or real smoke setup. Run all tests and typecheck, then update Phase E status and the implementation log.

## Phase F: Box System Template

Status: ready to begin from reviewed live probe observations

Dependencies: Phases D and E

Goal: reproducibly produce the provider-owned deterministic named Box system snapshot required by user sandboxes.

Deliverables:

- Add a script under `scripts/` for building/updating the Waterbox Box system template.
- Compile or package the daemon into a self-contained Linux artifact.
- Create a tagged no-env temporary Box using an idempotency key and deliberately omit `from`.
- Upload/install the daemon and its required runtime dependencies.
- Install and enable a systemd unit that starts the daemon after every boot/resume/fork.
- Verify daemon health from inside the Box before snapshotting.
- Stop the template source cleanly so filesystem state is captured.
- Save/replace the deterministic named system snapshot and store its name as the provider template reference.
- Emit machine-readable deployment metadata under `.waterbox/` without committing secrets.
- Ensure temporary build boxes are stopped or deleted on failure according to a documented safe cleanup policy.
- Document required environment variables and a dry-run or validation mode where practical.

Required tests:

- Unit tests cover command/request construction and metadata parsing without Box access.
- Failure paths redact the Box API key and protected URLs.
- Existing deployment scripts remain unaffected.

Manual verification:

- With explicit Box credentials, build the template.
- Create a Box from the template.
- Confirm systemd starts the daemon after boot.
- Confirm stop/resume restarts the daemon.
- Confirm a user snapshot restored into a new sandbox retains the daemon.

Non-goals:

- Running this builder automatically at API startup
- Publishing the daemon to a public package registry
- General image-builder abstraction
- Lambda MicroVM image builds

Acceptance criteria:

- API runtime only needs the resulting template reference as configuration.
- No account credentials exist inside the resulting template.
- `bun test` and `bun run typecheck` pass.

Delegation prompt:

> Read `docs/plans/control-plane-v1.md` and implement Phase F only. Add a repeatable, secret-safe Box system-template builder for the shared daemon. Keep it separate from API startup and preserve existing AWS deployment scripts. Implement testable request/command construction, document manual verification, run all automated checks, then update Phase F status and the implementation log.

## Phase G: Hono API Package

Status: ready to begin against injected fakes

Dependencies: Phases A and B

Goal: expose core through a shared Hono/OpenAPI application with pluggable identity resolution.

Deliverables:

- Add `@waterbox/api` using Hono and `@hono/zod-openapi`.
- Define an `IdentityResolver` port that resolves bearer credentials to `Identity`.
- Construct the API from an injected core service and identity resolver.
- Implement every route in the Public HTTP Surface section.
- Validate path, query, header, and body inputs with canonical Zod schemas.
- Generate OpenAPI 3.1 at `/openapi.json` from route definitions.
- Map typed core errors to stable HTTP statuses and error envelopes.
- Generate/propagate request IDs without exposing secrets.
- Stream canonical tool events as NDJSON and abort core execution when the client disconnects.
- Expose a Web-standard `fetch(request): Promise<Response>` compatible application.
- Keep Hono runtime adapters out of this package.

Required tests:

- Route tests use fake core and identity resolver implementations.
- Missing, malformed, and unknown credentials return 401.
- Cross-account not-found behavior does not reveal resource existence.
- Every route validates unknown and malformed input.
- Provider references and account IDs cannot appear in serialized responses.
- NDJSON reaches the response incrementally and cancellation reaches core.
- OpenAPI includes every public route, auth scheme, schema, errors, and stream media type.
- OpenAPI generation is deterministic.

Non-goals:

- SQLite or provider composition
- API-key issuance/rotation/storage
- CORS policy for a hosted product
- Rate limiting
- Lambda event adaptation
- MCP

Acceptance criteria:

- API imports only contracts, core types/service, Hono, and schema/OpenAPI dependencies.
- API can run under any runtime that supports Web `Request` and `Response`.
- `bun test` and `bun run typecheck` pass.

Delegation prompt:

> Read `docs/plans/control-plane-v1.md` and implement Phase G only. Build the shared Hono/OpenAPI API over injected core and identity resolution. Do not compose SQLite or Box and do not add MCP. Test validation, auth mapping, redaction, streaming, cancellation, and deterministic OpenAPI. Run all checks, then update Phase G status and the implementation log.

## Phase H: Local Composition And End-To-End Verification

Status: pending E, F, and G

Dependencies: Phases C, E, F, and G

Goal: compose the first usable local control plane and verify the complete Box workflow.

Deliverables:

- Add private app `apps/api-local`.
- Compose SQLite repositories, core, Box provider, API, and a fixed development identity resolver.
- Configure through environment variables with explicit validation and secret-safe errors.
- Map one configured development bearer key to one configured fixed account ID.
- Start the Hono application through Bun's local server adapter.
- Handle graceful shutdown and close SQLite cleanly.
- Add root scripts for starting the local API and running local integration tests.
- Add a `.env.example` containing placeholders only.
- Add local usage documentation with curl examples for lifecycle, snapshots, and all seven tools.
- Add API-level integration tests using temporary SQLite and fake provider/daemon servers.
- Add an opt-in credential-gated Box smoke script that guarantees cleanup and never runs as part of `bun test`.
- Verify state recovery by restarting the local API against the same SQLite file.

Required automated tests:

- Health and OpenAPI work on a real local listener.
- Authentication resolves to the fixed account and rejects other keys.
- Create/list/get survives process/application reconstruction over the same database.
- Complete fake-provider lifecycle works through HTTP.
- Snapshot create/list/get/delete works through HTTP.
- All seven tools work through the proxied daemon route.
- Bash output streams incrementally through daemon, provider, core, Hono, and the HTTP client.
- Client disconnect cancels remote bash.
- Public responses and logs contain no configured secrets or provider references.

Opt-in Box smoke flow:

1. Create a sandbox from the configured system template.
2. Poll until running.
3. Execute read, write, edit, patch, glob, grep, and streaming bash.
4. Stop and verify archived state.
5. Execute another tool and verify automatic resume.
6. Create an immutable user snapshot and poll until ready.
7. Create a second sandbox from that snapshot and verify filesystem state.
8. Permanently delete both sandboxes and the user snapshot.
9. Verify no test-owned running Box remains.

Non-goals:

- Hosted deployment
- DynamoDB
- Lambda MicroVM provider
- API-key lifecycle
- Background idle reaper
- Typed public client
- MCP

Acceptance criteria:

- A user can run the complete V1 control plane locally against Box.
- Fake integration tests are deterministic and credential-free.
- Real smoke is opt-in and cleans up resources.
- Existing v0 tests and scripts still compile.
- `bun test` and `bun run typecheck` pass.

Delegation prompt:

> Read `docs/plans/control-plane-v1.md` and implement Phase H only. Compose the completed packages into `apps/api-local`, add deterministic fake end-to-end tests and an opt-in cleanup-safe Box smoke test, and document local use. Do not add hosted deployment, DynamoDB, Lambda MicroVMs, a client SDK, or MCP. Run all automated checks and any available smoke verification, then update Phase H status and the implementation log.

## Deferred Phase I: Typed Client

This phase requires a separate approval after Phase H.

Proposed package: `@waterbox/client`.

It will consume the canonical HTTP API, own bearer headers and NDJSON parsing, propagate cancellation, and retry only explicitly safe/idempotent requests. It must not import core, repositories, providers, Hono routing, or MCP.

## Deferred Phase J: Local MCP

This phase requires a separate approval after the typed client.

Proposed package: `@waterbox/mcp`.

It will be a local stdio MCP process configured with API URL and key, use `@waterbox/client`, retain at most one process-local active sandbox selection, expose server-wide remote-workspace instructions plus boundary-first tool descriptions, and map API stream events to MCP progress when supported. It will not compose core or know provider details.

## Cross-Cutting Verification

Every implementation phase must preserve:

- `bun test`
- `bun run typecheck`
- Existing v0 receiver, plugin, and MCP tests
- Secret redaction in errors and logs
- Account isolation
- Cancellation propagation
- No automatic retry of ambiguous mutations

Focused tests should remain local to the core, repository, and first provider until a second real implementation establishes a reusable conformance boundary.

## Known Risks

- Box named snapshots have account-level quotas. The provider must expose this as a limit, not hide it.
- Protected Box hosting URLs are credentials. Persist and log them accordingly.
- A system template and user snapshots must never contain the Box account API key.
- Provider calls and local record writes cannot be atomically committed together. Stable provider idempotency keys and reconciliation minimize orphaning but cannot provide distributed transactions.
- SQLite process-local behavior must not become an implicit distributed locking contract.
- A crash during a lifecycle transition requires reconciliation from provider state.
- Stop can be refused if Box cannot safely snapshot. Core must preserve the failure and must not silently force-stop.
- Tool execution can mutate outside `/workspace` through bash. This is intentional full-Linux authority inside the sandbox.
- The current v0 mutation queue does not serialize bash with file mutations. Phase D must document the retained behavior rather than silently claiming stronger ordering.

## Explicitly Deferred Decisions

These do not block V1 phases A-H:

- Hosted API domain and deployment topology
- DynamoDB single-table versus separate-table physical layout
- Real account and API-key lifecycle
- Background idle stopping/reaper policy
- Lambda MicroVM provider and immutable-image setup UX
- Local MCP active-sandbox persistence beyond process lifetime
- Public package publishing and final organization ownership
- Snapshot portability across providers
- Provider selection policy when more than one provider is configured

## Implementation Log

- 2026-08-26: Plan created. Architecture and phases approved for implementation; no implementation phase started.
- 2026-08-26: Phase A completed with canonical strict contracts for identity, resources, lifecycle, pagination, all seven tools, stable errors, and public/provider data separation while preserving v0 contracts.
- 2026-08-27: Phase B completed with the narrowed multi-provider core: mandatory lifecycle/tool operations, cohesive optional stop/resume and snapshot groups, account isolation, source-provider snapshot creation, CAS transitions, durable create idempotency, automatic resume, cancellation, ambiguity handling, and secret-safe errors.
- 2026-08-27: Phase C completed with three Dynamo-shaped SQLite repositories, authoritative versioned documents, account-partition keyset pagination, strict canonical resource-key cursors, persisted idempotency expiry, malformed-document rejection, and no unused delete/list ports or cursor-key configuration.
- 2026-08-27: Phase D completed with the shared provider-neutral runtime and thin daemon. The runtime solely serializes file mutations; the daemon retains a 1 MiB incremental body limit, strict UTF-8/JSON/Zod validation, request and shutdown cancellation, NDJSON streaming, and no synthetic framing machinery. Process-group termination, path/symlink safety, atomic writes, patch rollback, v0 receiver behavior, and Pi endpoints remain covered.
- 2026-08-27: Phase E is documentation-aligned with focused fake-HTTP coverage for `noEnv` creation, exact idempotency replay, stop/resume, snapshots and snapshot-sourced creation, protected hosting, permanent deletion, every canonical tool, cancellation, ambiguity without retry, identity correlation, bounded response handling, and secret redaction. A separately authorized real capability probe remains the gate for calibrating provider behavior.
- 2026-08-27: Phase F was reset to pending. The mock-hardened builder and its tests/script were removed before shipment. A minimal raw-fetch capability probe now records the required create replay, lifecycle, marker, snapshot, restore, stop/resume, and cleanup observations only when separately credentialed and explicitly authorized; no real Box call occurred during remediation.
- 2026-08-27: Remediation verification passed 201 tests with 906 assertions, typecheck, diff checking, standalone daemon compilation, v0 receiver tests and Node bundle syntax, plugin tests, and Pi MCP tests. Four independent review lenses approved the corrected core/repository, runtime/daemon, Box/probe, and scope boundaries. No generated daemon binary, credentials, or provider resources were committed or used.
- 2026-08-27: The separately authorized live Box probe calibrated Phase E successfully: exact create replay, readiness, persistent `/home/user` marker writes, running named snapshots, snapshot restore, stop/archive, resume identity and marker continuity, snapshot deletion, and resource release all passed. Box deletion operations remained irreversibly accepted but `blocked`, so the probe distinguishes `accepted_pending` from `completed` and verifies that probe Boxes leave listings and active capacity. Phase F is now ready to begin; daemon installation, protected hosting, and template construction remain unclaimed Phase F work.
