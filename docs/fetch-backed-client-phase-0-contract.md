# Fetch-Backed Client Phase 0 Contract Record

Recorded on 2026-09-01 from the source baseline at the start of Phase 0. This record locks behavior for the later phases; it does not describe a Fetch-backed implementation.

## Product command parity matrix

| Current MCP tool | Target client command | Required API operation sequence | Shape |
|---|---|---|---|
| `create_sandbox` | `createSandbox` | `POST /v1/sandboxes` with the caller's required idempotency key | Simple; one request per invocation and no automatic replay |
| `probe_sandbox` | `probeSandbox` | Missing canonical authenticated probe operation | Simple once Phase 1 adds the route; ordinary `GET /v1/sandboxes/:sandboxId` is not equivalent |
| `delete_sandbox` | `deleteSandbox` | `DELETE /v1/sandboxes/:sandboxId` | Simple |
| `list_snapshots` | `listSnapshots` | `GET /v1/snapshots` with cursor pagination | Simple |
| `create_snapshot` | `createSnapshot` | `POST /v1/sandboxes/:sandboxId/snapshots` | Simple |
| `delete_snapshot` | `deleteSnapshot` | `DELETE /v1/snapshots/:snapshotId` | Simple |
| `send_file_securely` | `sendFileSecurely` | `POST /v1/sandboxes/:sandboxId/secure-file-transfers`, client-side encryption, then `PUT /v1/sandboxes/:sandboxId/secure-file-transfers/:transferId` | Composite. MCP alone reads `sourcePath`, requires a regular bounded file, handles local-read cancellation, and clears caller-owned plaintext. The client accepts bytes, never a host path, and never sends plaintext to the API. |
| `read` | `read` | `POST /v1/sandboxes/:sandboxId/tools/read` and decode NDJSON | Simple |
| `write` | `write` | `POST /v1/sandboxes/:sandboxId/tools/write` and decode NDJSON | Simple |
| `edit` | `edit` | `POST /v1/sandboxes/:sandboxId/tools/edit` and decode NDJSON | Simple |
| `patch` | `patch` | `POST /v1/sandboxes/:sandboxId/tools/patch` and decode NDJSON | Simple |
| `glob` | `glob` | `POST /v1/sandboxes/:sandboxId/tools/glob` and decode NDJSON | Simple |
| `grep` | `grep` | `POST /v1/sandboxes/:sandboxId/tools/grep` and decode NDJSON | Simple |
| `bash` | `bash` | `POST /v1/sandboxes/:sandboxId/tools/bash`; if dispatched, repeat bounded observation requests by job ID and offset; after terminal drain, issue bounded detached cleanup | Composite. The current observation and cleanup primitives are hidden `/v1/internal/...` routes and must become canonical in Phase 1. |

The seven tool commands preserve explicit `sandboxId` ownership and their current argument/event schemas. Bash progress remains a content-free heartbeat. Observation failure or cancellation returns the original dispatched recovery receipt rather than losing the job handle.

## Complete current API route inventory

| Method and path | Authentication | Current core operation | Client need |
|---|---|---|---|
| `GET /health` | No | None | Transport only |
| `GET /openapi.json` | No | None | Transport only |
| `POST /v1/sandboxes` | Bearer | `createSandbox` | `createSandbox` |
| `GET /v1/sandboxes` | Bearer | `listSandboxes` | Not in initial MCP command surface |
| `GET /v1/sandboxes/:sandboxId` | Bearer | `getSandbox` | Not a substitute for probe |
| `POST /v1/sandboxes/:sandboxId/stop` | Bearer | `stopSandbox` | Not in initial MCP command surface |
| `POST /v1/sandboxes/:sandboxId/resume` | Bearer | `resumeSandbox` | Not in initial MCP command surface |
| `DELETE /v1/sandboxes/:sandboxId` | Bearer | `deleteSandbox` | `deleteSandbox` |
| `POST /v1/sandboxes/:sandboxId/snapshots` | Bearer | `createSnapshot` | `createSnapshot` |
| `GET /v1/snapshots` | Bearer | `listSnapshots` | `listSnapshots` |
| `GET /v1/snapshots/:snapshotId` | Bearer | `getSnapshot` | Not in initial MCP command surface |
| `DELETE /v1/snapshots/:snapshotId` | Bearer | `deleteSnapshot` | `deleteSnapshot` |
| `POST /v1/sandboxes/:sandboxId/secure-file-transfers` | Bearer | `initiateSecureFileTransfer` | Composite transfer initiation |
| `PUT /v1/sandboxes/:sandboxId/secure-file-transfers/:transferId` | Bearer | `consumeSecureFileTransfer` | Composite encrypted consumption |
| `POST /v1/sandboxes/:sandboxId/tools/:toolName` | Bearer | `executeTool` | Seven tool commands; NDJSON |
| `POST /v1/internal/sandboxes/:sandboxId/bash-jobs/:jobId/observe` | Bearer middleware, but not canonical OpenAPI route machinery | `observeBashJob` | Composite Bash observation; must be formalized |
| `DELETE /v1/internal/sandboxes/:sandboxId/bash-jobs/:jobId` | Bearer middleware, but not canonical OpenAPI route machinery | `cleanupBashJob` | Composite Bash cleanup; must be formalized |

There is no API probe route in this baseline. The API structural `WaterboxCore` type also omits `probeSandbox`.

## Creation, preparation, and recovery lock

Every configured provider must implement `prepareSandbox`; `SandboxService` rejects a provider that does not. Creation reserves the idempotency key and persists a `provisioning` record, calls provider creation, persists the provider reference with the canonical public `preparing` state, calls mandatory preparation, verifies a running observation with the same provider reference, persists `running`, and then completes the idempotency record.

| Case | Locked state/ownership behavior | Response/recovery behavior |
|---|---|---|
| Preparation success | `preparing` checkpoint precedes preparation; successful verified result becomes `running` | Successful sandbox result; completion replay returns the same resource without provider creation |
| Definite preparation failure | Persist `failed`, retain provider reference and redacted public error; idempotency becomes failed when persistence succeeds | `SandboxRecoveryError` becomes an API error carrying the sandbox ID; resource remains probeable and deletable |
| Ambiguous preparation | Retain `preparing`, provider reference, and in-progress idempotency reservation | Recovery error carries the sandbox ID; explicit same-key replay reruns preparation only, never provider creation |
| Preparation success persistence failure | Retain `preparing` and in-progress reservation | Recovery conflict carries the sandbox ID; same-key replay may rerun preparation and commit success |
| Preparation failure persistence failure | Do not claim a persisted failed state; retain the last durable post-checkpoint state | Recovery conflict carries the sandbox ID; same-key replay can resume preparation |
| Idempotency completion/failure persistence failure after checkpoint | Preserve the owned sandbox and its durable state | Recovery conflict carries the sandbox ID |
| Cancellation before allocation | No record, reservation, or provider dispatch | Propagate the original abort; no recovery ID exists |
| Cancellation during provider creation without a returned reference | Preserve null-reference `provisioning` plus in-progress reservation | Propagate the original abort without an envelope or ID; same-key replay currently reports in progress and must not repeat provider creation |
| Cancellation during provider creation after a running observation is available | Best-effort persist provider reference as `preparing`; keep reservation in progress | Propagate the original abort without an envelope or ID; recover by explicit same-key replay |
| Cancellation during preparation | Retain `preparing`, provider reference, and in-progress reservation | Propagate the original abort without an envelope or ID; explicit same-key replay resumes preparation |
| Reconstruction/concurrency | A reconstructed service reads the same durable reservation and resource; concurrent preparation converges through repository compare-and-swap | Same-key calls may both reach preparation but provider creation remains single-shot |
| Deletion | `preparing` and post-checkpoint `failed` are valid delete sources | Deletion preserves the public resource handle through termination |

The exact recovery envelope is:

```json
{
  "error": {
    "code": "<public ErrorCode>",
    "message": "<public redacted message>",
    "requestId": "<safe request ID>",
    "sandboxId": "sbx_<public-readable-id>"
  }
}
```

`error.sandboxId` is optional and is emitted only when the thrown domain error is a `SandboxRecoveryError`. Creation paths that wrap with that error are: post-checkpoint non-recovery failures, definite or ambiguous preparation failures, preparation-result persistence conflicts, preparation-failure or idempotency-result persistence conflicts, and replays whose durable failed/preparing resource has a provider reference. It is not provider identity and must validate as a public `SandboxId` before becoming `recoverySandboxId` in the client. Abort propagation bypasses the envelope, so cancellation must never fabricate a recovery ID.

## Get and probe behavior lock

| Persisted record | Ordinary get | Active probe |
|---|---|---|
| `provisioning`, null provider reference | Return unchanged; cannot inspect | Return unchanged; cannot inspect |
| `provisioning`, provider reference present | Inspect provider. A running observation checkpoints `preparing`, executes preparation, and may return `running` or a recovery error; other observations reconcile provisioning. | Same reconciliation and possible preparation behavior |
| `preparing` | Return unchanged because it is not an ordinary transitional state | Inspect provider. Provider `failed` persists Waterbox `failed`; provider `terminated` persists `terminated`; ready/running or other nonterminal observations leave Waterbox `preparing`. Probe never completes preparation. |
| `failed` | Return unchanged | Inspect provider. Termination persists `terminated`; ready/running or failed observations leave Waterbox `failed`. |
| Stable live (`running`, `stopped`, `terminated`) | Return unchanged | Inspect provider and reconcile only allowed live transitions; unchanged observation avoids a write. |

This distinction is why `probeSandbox` requires a new operation rather than use of ordinary get.

## Runtime artifact and local composition lock

`SandboxRuntimeArtifact` currently has exactly `bytes: Uint8Array`, lowercase 64-character `sha256`, literal `cliProtocolVersion: 2`, and `artifactVersion: string`. The Box provider defensively copies and validates the bytes, digest, shebang, protocol, and version before use. It uploads and installs that artifact during mandatory preparation.

MCP-adjacent lookup is in `packages/mcp/src/direct.ts`: configured direct Box mode loads `../dist/waterbox-cli.js` relative to the packaged MCP module through `loadSandboxRuntimeArtifact`. Development listener lookup is in `apps/api-local/src/app.ts`: `localRuntimeArtifact` synchronously reads `packages/mcp/dist/waterbox-cli.js` relative to source and constructs the artifact. These callers own lookup. The future shared local composition must receive an already validated artifact and must not locate or build it.

The current initialization order is intentionally not locked as desired behavior. Both direct MCP and API-local open SQLite before some provider/artifact construction failures; the MCP creates the database parent first, while API-local relies on its caller. Phase 3 must reorder validation and ownership so artifact/provider failures occur before SQLite side effects where specified and any opened store closes once.

No `BOX_SYSTEM_TEMPLATE_REF`, system-template config field, system-template API field, or provider system template exists in the inspected baseline. It must not be reintroduced.

## Dependency and extraction inventory

Current supported MCP production imports to remove by Phase 4:

- `packages/mcp/src/direct.ts` imports `SandboxService`, core `Clock`/ID types, `SandboxProvider`, `BoxSandboxProvider`, artifact loading and provider clock, and `SqliteRepositoryStore`; it constructs and directly invokes all of them.
- `packages/mcp/src/backend.ts`, `packages/mcp/src/main.ts`, `packages/mcp/src/server.ts`, and `packages/mcp/src/bash-observation.ts` import core provider tool/Bash types.
- `packages/mcp/src/server.ts` imports core `SandboxRecoveryError`.

Local API composition to extract from `apps/api-local/src/app.ts` includes SQLite opening/closing, Box provider construction, system clock and readable ID generation, `SandboxService` construction and provider registration, fixed development bearer identity resolution, API construction, and partial-initialization cleanup. Artifact file lookup remains app-owned. `apps/api-local/src/main.ts`/`server.ts` retain environment parsing, the explicit listener, signals, and shutdown.

## Credential and live-operation boundary

Phase 0 inspected source and variable names only. It did not read credential values, instantiate the Box provider, make provider/network requests, or mutate live resources. The development Box account is authorized for later plan-scoped validation, but Phase 0 deliberately remains credential-free and performs no live operation.

## Baseline verification

The required commands were run before Phase 0 edits. The checkout's dependency installation was incomplete, so failures are recorded as baseline environment failures:

- `bun test packages/sandbox-api/test packages/mcp/test apps/api-local/test`: failed overall. All 14 sandbox API tests passed. MCP/API-local suites failed to load because workspace packages (`@waterbox/cli/protocol`, `@waterbox/contracts`) and `zod` were unresolved.
- `bun run typecheck`: failed with unresolved workspace/external modules (`@waterbox/contracts`, core/provider packages, `zod`, `age-encryption`) and cascading type errors.
- `bun run build:mcp`: failed because `esbuild` was unresolved.
- `git diff --check`: recorded after the documentation edit in the Phase 0 implementation log.

These failures predate Fetch-backed implementation and are not attributed to the refactor.
