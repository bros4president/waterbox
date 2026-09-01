# Vercel Sandbox Provider-Port Audit

Date: 2026-09-01

Status: Phase 6 evidence complete; the initial verdict below is retained as the historical audit classification. Phase 7 subsequently approved the supplementary provider-neutral primitive extraction in `docs/plans/sandbox-provider-primitives-and-vercel-v0.md`.

## Verdict

**Adapter-local shim needed, port unchanged.**

This is the sole verdict. Vercel Sandbox can satisfy every mandatory `SandboxProvider` method and can expose all four existing optional groups without a provider-specific branch or a generic port change. The adapter must hide Vercel's durable named-sandbox/replaced-session model, reconcile ambiguous mutations by owned name and tags, map transient states, bootstrap the Waterbox CLI, and translate command records and NDJSON logs into the existing provider contracts.

## Scope And Method

This audit did not add `@vercel/sandbox`, a production adapter, configuration wiring, or changes to core, API, client, or MCP behavior. It used:

- Official Vercel Sandbox documentation and REST reference current on 2026-09-01.
- Repository inspection of `SandboxProvider`, the Box adapter, `package.json`, and `bun.lock`.
- A direct-REST probe implemented with native `fetch`, Web Streams, gzip/tar, and Node APIs.
- Twelve credential-free fake-server tests covering request contracts, pagination, lifecycle variants, mutation ambiguity, bounded reads and polling, redaction, and cleanup failures.
- One separately authorized passing live run in an isolated development project after iterative calibration runs.

The live run used one source sandbox and one snapshot-derived sandbox. Every created sandbox, session, and snapshot was tracked. The final sanitized artifact is `.waterbox/probes/waterbox-v6-a141c0258c68408dae81.sanitized.json`; raw ledgers remain private, ignored, mode `0600`, and are not audit inputs except for exact emergency cleanup.

## Version And Configuration Facts

- No `@vercel/sandbox` package is installed. It is absent from `package.json` and `bun.lock`, so there is no installed SDK version to report or trust. The probe deliberately did not change that fact.
- The official JS reference recommends `@vercel/sandbox` but does not state a package version on the reference page. It describes the current named-sandbox API, persistent-by-default behavior, commands, files, snapshots, and `AbortSignal` support [1].
- Official authentication guidance recommends `VERCEL_OIDC_TOKEN` for Vercel-hosted and linked local development. For external or non-Vercel hosting it documents `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` [2]. The authorized probe used the access-token form because this process runs outside Vercel.
- The subsequent Phase 7 architecture decision selected native `fetch` against the demonstrated REST surface for production. No `@vercel/sandbox` dependency is planned; exact endpoint versions, bounds, cancellation, and mutation retry policy remain explicit adapter contracts.

The live REST surface is version-split: creation succeeded at `POST /v4/sandboxes`, manual snapshot at `POST /v3/sandboxes/sessions/{sessionId}/snapshot` with `201`, and the remaining demonstrated list, inspect, command, log, file, stop, snapshot-read/delete, and sandbox-delete operations used `/v2`. The current REST reference instead documents manual snapshot as `POST /v2/sandboxes/sessions/{sessionId}/snapshot` [4]. Phase 7 must pin and test the selected client contract rather than normalize these paths in core or assume documentation and live routing are identical.

## Provider Mapping

| Port surface | Vercel mapping | Result |
| --- | --- | --- |
| `name` | Constant adapter name selected only by composition | Fits unchanged |
| `createSandbox` | Create a persistent named sandbox; derive a deterministic, project-unique name from Waterbox identity/idempotency input; optionally set snapshot source; tag ownership | Fits through shim |
| `prepareSandbox` | Upload the caller-owned CLI artifact as gzip-tar, install it with a checked command, and verify Node/CLI/`rg` facts as the Box adapter does | Fits through shim |
| `inspectSandbox` | Resolve the durable name without implicit resume; map current sandbox status; return `terminated` on 404 | Fits through shim |
| `deleteSandbox` | Delete by durable name, preserve snapshots for explicit cleanup, then confirm 404 | Fits through shim |
| `executeTool` | Run `/usr/local/bin/waterbox` through the command API, wait for terminal command state, consume bounded NDJSON logs, and validate the CLI event | Fits through shim |
| `stopResume` | Stop the current session; resume the durable name and replace the session ID in adapter-local state | Supported |
| `snapshots` | Create/inspect/delete snapshot IDs and create sandboxes from snapshot source | Supported |
| `secureFileTransfer` | Use the existing Waterbox CLI protocol after adapter-local upload/bootstrap; Vercel file upload transports ciphertext only | Supported through shim |
| `bashJobs` | Use the existing CLI dispatch/observe/cleanup protocol over ordinary commands | Supported through shim |

The provider reference should store the durable sandbox name and enough non-secret correlation data to validate ownership. A Vercel session ID is not a durable sandbox reference: each resume creates a new session [3]. Snapshot references can store the provider snapshot ID. These shapes remain opaque `JsonValue` to core.

## Lifecycle, Identity, And State

Vercel documents persistent sandboxes as long-lived names with replaceable VM sessions; names are unique per project, stopping creates an automatic snapshot, and resuming creates a new session [3]. That maps cleanly to Waterbox's durable sandbox observation once the adapter hides session replacement.

Recommended state mapping:

| Vercel state | Waterbox state |
| --- | --- |
| `pending` | `provisioning` |
| `running` | `running` |
| `snapshotting`, `stopping` | `stopping` |
| `stopped` | `stopped` |
| `failed`, `aborted` | `failed` |
| named lookup 404 after confirmed deletion | `terminated` |

The live probe observed `snapshotting` in the manual snapshot response and then `running` from a bounded non-resuming named lookup. This differs from prose saying manual snapshot makes the sandbox unreachable [4]. The adapter must treat the response as asynchronous evidence and reconcile through named reads rather than assume terminality from prose or the mutation response.

## Mutation Safety And Idempotency

The current port supplies an idempotency key, but the demonstrated Vercel create contract did not expose an HTTP idempotency header. That does not require a generic change:

- Derive one valid stable sandbox name from the Waterbox sandbox ID/idempotency input.
- Add an exact ownership tag.
- Send create once.
- On transport loss only, perform one non-resuming lookup by exact name and require project, name, session linkage, and tags to match.
- Never infer ownership from list differences and never retry an unresolved create mutation.

Commands, stop, snapshot, kill, and delete likewise must not be blindly retried after an ambiguous transport outcome. Reconcile with read-only command, named-sandbox, and snapshot endpoints where an exact identity exists; otherwise return `ambiguous_execution`. Snapshot deletion can yield a GETtable/listed `deleted` tombstone, which is terminal rather than a leak.

## Commands, Files, And Preparation

The live path established these facts:

- A fresh default image ran Node 24 and contained `rg`.
- The process had usable root privilege; adapter preparation can create and own `/workspace` without assuming the initial cwd.
- The initial cwd was absolute but not treated as a fixed provider contract.
- Gzip-tar upload preserved bytes and mode `0640`.
- Command creation returned an asynchronous command record. Terminal observation required a later command GET with `wait=true`; logs were `application/x-ndjson`.
- A long command was observed running, killed, and then observed with a nonzero terminal exit.

The official SDK reference exposes command execution, detached commands, stdout/stderr streams, file reads/writes, modes, and `AbortSignal` [1]. The generic `executeTool` contract is an async iterable but does not require provider-native streaming, so an adapter may validate bounded terminal output and yield the single Waterbox CLI event after completion. Bash jobs already provide the provider-neutral long-running path.

Preparation should follow the proven Box boundary: composition supplies the exact CLI artifact and digest; the adapter uploads, installs, and verifies it. Vercel's base image is not a Waterbox runtime contract. Node 24, `rg`, privilege, workspace creation, CLI health/version, and artifact digest must be checked on every preparation or repaired adapter-locally.

## Snapshots And Persistence

The live probe proved:

- Stop returned a stopped session plus an automatic snapshot.
- Resume created a different session and preserved an uploaded marker.
- Manual snapshot returned `201` and a ready snapshot while reporting the transient session state `snapshotting`.
- A new named sandbox created from that snapshot preserved the marker.
- Snapshot deletion may retain a `deleted` tombstone in GET/list responses.

Official documentation confirms snapshots capture files and installed packages, outlive source sandboxes, can seed multiple sandboxes, default to 30-day expiry, are region-bound, and incur storage charges [4]. Persistent stop snapshots are automatic and separately billed [3][5]. An adapter should set an explicit bounded retention policy where the API permits it and must delete owned snapshots independently of sandbox deletion.

## Cancellation, Limits, Billing, And Errors

- Thread the caller's `AbortSignal` through every request, stream read, and poll sleep. A caller abort is not a provider failure.
- Use separate bounded request, response-size, log-size, and lifecycle polling limits. Do not retry mutations merely because a local timeout fired.
- Map definite quota/rate failures to `limit`; definite provider failures to `failure`; unresolved mutation outcomes to `ambiguous_execution`.
- Vercel bills active CPU, provisioned memory, creations, transfer, and snapshot storage. Current quotas include plan-dependent concurrency/session limits, fixed control-plane request quotas, and a deletion rate of 20 requests/second per team [5].
- Stop sandboxes promptly and bound automatic snapshot retention. Sandbox deletion does not delete snapshots [3][4].

## Secrets And Redaction

Credentials belong only in composition. Provider references, diagnostics, exceptions, persisted records, and sanitized probe artifacts must never include tokens, team/project IDs, command text, cwd, uploaded contents, or provider response bodies. Stable sandbox/snapshot identifiers may be persisted only in opaque provider references or private cleanup ledgers, not user-facing diagnostics.

The probe required literal `--run`, an exact destructive-operation acknowledgement, and an isolated-project acknowledgement. It validated pagination and ownership before mutation, recorded only templated paths and allowlisted facts in sanitized evidence, and wrote artifacts mode `0600`.

## Static/Fake Evidence

`scripts/vercel-sandbox-capability-probe.test.ts` contains twelve credential-free tests. They prove:

- Exact create, inspect, command, logs, upload, stop, snapshot, restore, kill, delete, pagination, and query/body contracts.
- Running, stopped, and transient `snapshotting` manual-snapshot outcomes.
- No mutation retry after malformed command responses or ambiguous create transport loss.
- Exact tagged create reconciliation and rejection of mismatched ownership.
- Bounded NDJSON handling, stderr/error/nonzero rejection, and terminal-read retry only.
- Cleanup continuation after stop or snapshot-delete failures.
- Correct treatment of snapshot deletion tombstones and retention eviction.
- Credential, identifier, cwd, command, and payload redaction plus exact-baseline reporting.

The focused suite passed 12 tests with 97 assertions, followed by `tsc --noEmit` and `git diff --check`.

## Authorized Live Evidence And Cleanup

The passing run exercised the complete minimal matrix with two sandboxes:

- Fresh persistent named create and non-resuming inspection.
- Node 24, absolute cwd discovery, `rg`, root privilege, `/workspace`, gzip-tar upload, and marker verification.
- Stop, automatic snapshot discovery, explicit resume, changed session identity, and persistence.
- Manual snapshot, transient `snapshotting`, named reconciliation, snapshot-source create, and restored marker.
- Asynchronous command creation, terminal wait, bounded NDJSON logs, running observation, kill, and nonzero terminal observation.
- Sandbox deletion, snapshot deletion/tombstones, pagination, ownership checks, and exact baseline comparison.

The final artifact reports `outcome: "passed"`, `baselineCaptured: true`, `cleanup.exactBaseline: true`, and zero cleanup errors. It is the acceptance evidence. As operator context only, later calibration artifacts also reported exact active baseline; one first-run resource was removed from its exact private ledger, and subsequent aggregate reconciliation found no active sandbox. Those historical cleanup actions are not used to strengthen the passing run's capability claims. No credential or provider identifier is retained in this report.

## Required Phase 7 Boundary

At the time of this audit, Phase 7 still needed to approve a boundary and settle configuration. The later architecture review accepted Vercel's compatibility with the high-level interface but found that interface mixed provider primitives with shared Waterbox runtime behavior. The approved supplementary plan therefore extracts a lower provider-neutral primitive port before implementing Vercel, while preserving the evidence and single audit verdict above.

The provider-specific layer should own:

- Authentication and project/team scoping.
- Durable-name and replaceable-session reconciliation.
- REST endpoint-version differences and strict response validation.
- Mutation ambiguity handling, polling, limits, and state mapping.
- Runtime artifact upload/install/verification.
- Command/log conversion and all optional capability implementations.

Core, API, client, and MCP continue to avoid provider-name branches. The generic primitive extraction is justified by the subsequent two-provider architecture review, not by a claim that Vercel is incapable of implementing the historical high-level surface.

## Sources

1. Vercel, "JS SDK Reference," updated 2026-08-21: https://vercel.com/docs/sandbox/sdk-reference
2. Vercel, "Sandbox Authentication," updated 2026-08-25: https://vercel.com/docs/sandbox/concepts/authentication
3. Vercel, "Persistence," updated 2026-08-25: https://vercel.com/docs/sandbox/concepts/persistent-sandboxes
4. Vercel, "Snapshots," updated 2026-08-26, and REST "Create a snapshot": https://vercel.com/docs/sandbox/concepts/snapshots and https://vercel.com/docs/rest-api/sandboxes/create-a-snapshot
5. Vercel, "Vercel Sandbox pricing and quotas," updated 2026-08-21: https://vercel.com/docs/sandbox/pricing
