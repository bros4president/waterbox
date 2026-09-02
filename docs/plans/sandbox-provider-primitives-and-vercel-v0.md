# Sandbox Provider Primitives And Vercel Implementation V0

Status: complete; Vercel capability probe and Phases 1-7 complete

This is the durable supplementary implementation plan for refactoring the current Box-specific provider implementation around a provider-neutral sandbox primitive port and then delivering a production Vercel Sandbox provider through the same shared Waterbox runtime composition.

This plan supplements Phase 7 of `docs/plans/mcp-npm-launch-v0.md`. It owns the provider-boundary refactor, Box migration, Vercel implementation, configured composition, parity verification, and isolated live provider acceptance. The launch plan continues to own npm packaging, legal closure, release documentation, publication, and post-provider launch gates.

The prerequisite Vercel capability audit is complete. Do not repeat Phase 6 as implementation discovery. Its direct-REST probe and live evidence establish that Box and Vercel share a practical low-level capability intersection. This plan is the preparation pass required before the Vercel production adapter: extract shared Waterbox behavior from the Box adapter without breaking Box, then implement only Vercel-native mechanics in the Vercel adapter.

## How To Use This Plan

An implementation agent assigned a phase must:

1. Read this entire plan, the relevant launch-plan phase, and all prerequisite phases.
2. Inspect the current worktree and preserve unrelated or concurrent changes.
3. Reconfirm referenced source behavior before editing because package boundaries may have moved.
4. Implement only the assigned phase and its acceptance criteria.
5. Run the phase's focused verification and `git diff --check`.
6. Update the phase status and append a concrete implementation-log entry.
7. Stop at the phase boundary.

Do not combine the Box migration and Vercel production implementation into one unreviewable rewrite. Box must remain behaviorally green through every refactor phase, and the Box live gate must pass before configured Vercel composition begins.

No live provider mutation is authorized merely by this document. Every Box or Vercel live run remains separately credentialed, explicitly authorized, isolated-project/account gated, bounded, tracked, and reconciled to its exact active baseline.

## Objective

This plan is complete when:

- The actual provider implementation boundary consists of low-level sandbox infrastructure primitives shared by Box and Vercel.
- Waterbox runtime preparation, CLI tool execution, secure transfer, and Bash-job behavior are implemented once over those primitives.
- The existing checkpointed core lifecycle and public API shape remain provider-neutral; the only approved behavior corrections are running-only explicit snapshot creation and preserving adapter-reported mutation ambiguity over a racing abort.
- Box passes its existing credential-free suites, shared primitive/runtime conformance, and authorized live regression through the new composition.
- Vercel implements the same primitive port, composes through the same Waterbox runtime layer, passes credential-free parity, and passes a full authorized isolated-project live smoke.
- Local composition supports explicit Box, explicit Vercel, and injected test backends without an implicit provider default or provider-name branches above composition.
- Both providers create fresh sandboxes, prepare the current runtime artifact, execute all supported Waterbox operations, stop/resume, snapshot, restore from snapshot, and reconcile exact cleanup.

The target architecture is:

```text
@waterbox/api
    |
    v
SandboxService
    |
    | checkpointed Waterbox lifecycle and recovery
    v
WaterboxSandboxBackend
    |
    +-- shared runtime preparation
    +-- shared CLI tool protocol
    +-- shared secure transfer protocol
    +-- shared Bash-job protocol
    |
    v
SandboxInfrastructure
    |
    +-- BoxSandboxInfrastructure
    |
    `-- VercelSandboxInfrastructure
```

`SandboxService` may continue to consume the existing `SandboxProvider` shape during migration. The final naming may preserve that interface for the composed backend, but the provider-specific implementation boundary is the primitive `SandboxInfrastructure` port. Do not force a broad rename unless it materially improves clarity after both providers are composed.

## Current State

The current repository has:

- One production provider, `BoxSandboxProvider`, in `packages/sandbox-provider-box`.
- A core-facing `SandboxProvider` interface in `packages/sandbox-core/src/provider.ts` containing both lifecycle methods and Waterbox runtime methods.
- A `SandboxService` that already persists a provider reference and `preparing` checkpoint between provider create and runtime preparation.
- A Box implementation that directly owns provider HTTP mechanics, runtime artifact upload/install/verification, CLI invocation and event parsing, secure transfer, and Bash-job observation/cleanup.
- Local composition that supports Box or an injected high-level provider.
- A completed Vercel direct-REST capability probe and audit in `scripts/vercel-sandbox-capability-probe.ts` and `docs/research/vercel-sandbox-provider-port-audit.md`.
- Live evidence that Vercel supports persistent named create, exact inspection, commands, logs, kill, file upload, stop/resume, snapshots, snapshot-source create, deletion, listing, and exact cleanup.

The Vercel probe is evidence, not production code. Production implementation must not import the probe or depend on private probe ledgers.

## Architectural Diagnosis

The current port combines two abstraction levels:

1. Provider infrastructure behavior: create, inspect, command transport, file transport, stop/resume, delete, snapshots, and inventory.
2. Waterbox product behavior: install and verify the runtime, invoke canonical tools, implement secure transfer, and observe/clean Bash jobs.

The lifecycle portion is broadly neutral. Box and Vercel both expose the required native concepts with ordinary adapter work such as response validation, state mapping, bounded polling, and ambiguity reconciliation.

The composed behavior does not belong in each provider adapter. Reimplementing preparation, tool framing, secure transfer, and Bash jobs in Vercel would duplicate Waterbox logic already embedded in Box. The refactor therefore introduces a low-level primitive port and a shared Waterbox runtime backend above it.

This diagnosis supersedes the Phase 6 report's shorthand “adapter-local shim” implementation recommendation. Vercel can satisfy the existing high-level interface, but doing so directly would preserve an ill-defined implementation boundary. The approved preparation is a provider-neutral primitive extraction, not a Vercel-specific core branch.

## Settled Decisions

### Core Lifecycle

- `SandboxService` continues to own account isolation, Waterbox IDs, public idempotency reservations, canonical states, state-transition validation, optimistic CAS, repository-backed listing, and recovery policy.
- Create and preparation remain separate durable phases.
- Core must persist the provider reference and `preparing` checkpoint before runtime installation begins.
- Preparation remains safely repeatable so same-key replay and reconstructed services can recover a stale or partial runtime.
- The launch plan's acknowledged provider-create/result-persistence failure interval remains acknowledged. This refactor does not pretend an unresolved create or snapshot mutation can always return a provider reference.
- Phase 1 makes lifecycle cancellation precedence consistent: once an adapter reports `ambiguous_execution` for a dispatched mutation, that ambiguity is not discarded merely because the caller's signal also aborted.
- No provider endpoint, provider state name, session ID, command-log shape, archive encoding, or provider-name branch enters core, API, client, or MCP.

### Primitive Provider Port

- The primitive port describes semantic sandbox operations, not Box or Vercel wire formats.
- “Direct mapping” means one native provider capability. A provider may use bounded polling or multiple transport requests to produce the semantic result.
- Provider adapters own authentication, native IDs, durable reference shapes, native state mapping, request/response validation, provider polling, safe ambiguity reconciliation, response bounds, and cancellation propagation.
- Provider adapters never blindly retry a mutation after a transport loss or timeout.
- Provider references remain opaque JSON above the primitive adapter.
- A sandbox reference identifies a durable sandbox, not a replaceable execution session. Box stores its Box ID; Vercel stores its persistent sandbox name and keeps current session IDs internal.
- Existing persisted Box reference shapes remain readable and unchanged. No migration is added for unpublished hypothetical Vercel references.

### Shared Waterbox Runtime

- Runtime preparation is implemented once over primitive command and file operations.
- CLI invocation encoding, structured rejection handling, canonical tool-event validation, and output safety are implemented once.
- Secure transfer continues to encrypt locally and sends only ciphertext through provider file transport.
- Bash-job dispatch remains part of the Waterbox CLI/runtime; observation and cleanup are shared command compositions, not provider-native job APIs.
- The current caller-owned runtime artifact, digest, artifact version, CLI protocol version, Node 24 requirement, `rg` requirement, workspace, launcher, manifest, and verify-first repair behavior remain product invariants.
- Phase 1 settles a semantic full-Linux runtime profile before extraction, including workspace, installation locations, executable discovery, privilege escalation, persistent versus ephemeral paths, and detached-job requirements. Do not copy Box's current `/usr/local/bin/node` or `sudo -n` assumptions into shared code without proving them for both providers.
- Provider-specific privilege or filesystem mechanics may be supplied through that narrow runtime profile only when the two real providers cannot share a capability-driven command. Do not create provider-name conditionals in the shared layer.

### Capabilities

- Mandatory primitive capabilities for a launch provider are create, exact inspect, terminal command execution, trusted file upload, and delete.
- Stop/resume and snapshots remain cohesive capability groups at the generic type level so future ephemeral providers can be represented honestly.
- Box and Vercel will both advertise and therefore must both implement stop/resume and full snapshot create/inspect/delete plus create-from-snapshot. This is a two-provider implementation target, not a change making those groups mandatory for every future launch provider.
- Generic explicit snapshot creation requires a running sandbox. Phase 1 removes the current stopped-sandbox allowance rather than forcing Vercel to perform a hidden resume/snapshot/restop sequence that core cannot represent accurately. Callers explicitly resume before snapshotting.
- Provider inventory is an administrative/reconciliation capability. It does not replace repository-backed Waterbox list operations.
- Exact inspect remains mandatory even when provider inventory exists.

### Vercel

- The completed probe is not copied wholesale into the provider package. Reuse only validated contracts and small generic helpers where ownership is clear.
- Vercel's durable reference is the project-scoped persistent sandbox name. Session IDs are resolved and validated inside each session-scoped primitive operation.
- Non-resuming lookup is used for inspection. Only explicit resume may request a new session.
- Create ambiguity is reconciled by one exact non-resuming lookup using deterministic identity and ownership tags. List differences never establish ownership.
- The production Vercel adapter uses native `fetch` against the REST API and does not add `@vercel/sandbox`. Exact versioned paths, including the live `/v4` create, `/v3` snapshot, and `/v2` remaining endpoint split, stay adapter-local and are pinned by fake-server contracts. Reconsider this only after a concrete REST insufficiency and a durable-plan amendment.
- The settled local configuration is explicit access-token mode: `WATERBOX_PROVIDER=vercel`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`. The typed provider config also contains the fixed HTTPS API origin and bounded polling settings. OIDC support is deferred unless this plan is amended with tested local composition and refresh behavior.
- Audited manual snapshot behavior may return or transition through `snapshotting`, and a bounded non-resuming lookup may terminally report the source sandbox as stopped. Vercel reports that state through the provider-neutral optional source-sandbox observation on snapshot creation; shared core applies any supplied observation to reconcile the durable source state. This does not resume the sandbox. Box may omit the observation when its snapshot creation does not change source state.
- Automatic Vercel stop snapshots are provider persistence artifacts, not public Waterbox snapshot records. Vercel must not use provider-global `keepLastSnapshots`, because official Vercel Sandbox documentation shows it governs every snapshot, including explicit snapshots. Bounded automatic retention instead uses Waterbox-tracked, ownership-verified targeted cleanup of automatic snapshot references. Its bounded provider reference may carry the last automatic snapshot ID returned by a successfully persisted stop action, but cleanup never depends on reference-only updates from stable inspection. Before sandbox deletion, the adapter independently resolves and verifies the current snapshot, deletes it only when its creation method and source identity prove it is automatic and owned, then deletes the sandbox. It never enumerates snapshots for deletion or evicts explicit Waterbox snapshots.

## Primitive Contract

The exact TypeScript names may be adjusted during Phase 1, but the semantic surface is settled:

```ts
interface SandboxInfrastructure {
  readonly name: string

  create(input: InfrastructureCreateInput): Promise<InfrastructureSandboxObservation>
  inspect(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation>
  runCommand(input: InfrastructureCommandInput): Promise<InfrastructureCommandResult>
  writeFile(input: InfrastructureWriteFileInput): Promise<void>
  delete(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation>

  readonly stopResume?: {
    stop(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation>
    resume(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation>
  }

  readonly snapshots?: {
    create(input: InfrastructureCreateSnapshotInput): Promise<InfrastructureSnapshotObservation>
    inspect(input: InfrastructureSnapshotInput): Promise<InfrastructureSnapshotObservation>
    delete(input: InfrastructureSnapshotInput): Promise<InfrastructureSnapshotObservation>
  }

  readonly inventory?: {
    listSandboxes(input: InfrastructureInventoryInput): AsyncIterable<InfrastructureSandboxObservation>
    listSnapshots(input: InfrastructureInventoryInput): AsyncIterable<InfrastructureSnapshotObservation>
  }
}
```

### Create

Create receives:

- Account and Waterbox sandbox identity for deterministic ownership correlation.
- A stable operation/idempotency key.
- An optional opaque source snapshot reference.
- An `AbortSignal`.

Successful or exactly reconciled create returns a canonical observation containing a durable non-null provider reference. A provider with native idempotency uses it. A provider without native idempotency derives an exact owned identity and reconciles safely. If mutation acceptance remains unresolved, create throws `ambiguous_execution`; the known provider-return/result-persistence interval remains explicit rather than inventing a reference or retrying the mutation.

Create-from-snapshot is a create option, not a separate primitive method.

### Inspect

Inspect is exact and side-effect free. It must not resume, recreate, repair, install, or mutate the sandbox. Confirmed absence maps to `terminated`; unknown/malformed/unauthorized responses do not.

### Run Command

The common command semantic is a bounded terminal result:

```ts
interface InfrastructureCommandResult {
  exitCode: number | null
  stdout: Uint8Array
  stderr: Uint8Array
  timedOut: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
}
```

The input supports a controlled command/script, cwd, environment, timeout, sandbox reference, and signal. Phase 1 must choose one injection-safe common command representation after proving it against both APIs. Do not expose a provider command DTO or force Box to fabricate Vercel command handles.

Box may obtain the terminal result from one command request. Vercel may create a command, perform bounded terminal observation, and consume bounded logs. Those are equally valid implementations of the same primitive.

Command output limits are explicit. Missing terminal facts, truncation, malformed logs, response loss, and uncertain non-idempotent execution map to ambiguous execution where appropriate.

### Write File

The semantic operation writes caller-supplied trusted bytes to an absolute sandbox path with an optional Unix mode:

```ts
interface InfrastructureWriteFileInput {
  accountId: string
  providerRef: JsonValue
  path: string
  contents: Uint8Array
  mode?: number
  signal: AbortSignal
}
```

Box may encode bytes as base64 JSON. Vercel may encode a bounded gzip-tar upload. Archive and transfer encoding remain adapter-local.

This primitive is for runtime artifacts, encrypted secure-transfer ciphertext, and other explicitly trusted control-plane payloads. It does not weaken the end-to-end secure file feature by sending user plaintext through the control plane.

### Stop, Resume, And Delete

- Stop and resume retain the same durable sandbox identity. The opaque reference may update bounded provider-private persistence metadata, such as Vercel's current automatic snapshot ID.
- Vercel session replacement is hidden below the primitive boundary.
- A stopped resource remains exactly inspectable.
- Delete is complete only when exact inspection establishes terminal absence or the provider exposes an equally strong terminal state.
- Provider-specific operation resources and polling remain adapter-local.

### Snapshots

- Snapshot create receives the Waterbox snapshot identity so providers can derive stable owned names where needed.
- Successful or exactly reconciled snapshot create returns an opaque non-null reference and may include `sourceSandboxObservation?: InfrastructureSandboxObservation`. A provider must include this provider-neutral optional source observation when snapshot creation establishes a source-state change; shared core reconciles every supplied observation, while its absence asserts no source-state update. An unresolved mutation throws ambiguity and retains the existing acknowledged no-reference recovery limitation.
- Snapshot inspect is exact and side-effect free.
- Snapshot delete accepts provider 404 or an explicit terminal deleted tombstone as deleted only after exact identity validation.
- Source-snapshot create remains provider-affine and uses the opaque snapshot reference.
- Explicit snapshot create accepts only a running source. It does not implicitly resume a stopped sandbox.
- Source-state reconciliation is shared behavior, not a Vercel branch: Box may omit the optional observation when snapshot creation leaves the source unchanged.
- Provider-generated automatic persistence snapshots are not surfaced as Waterbox snapshots.

### Inventory

Inventory is optional in the primitive type and mandatory for live leak/baseline tooling when the provider supports it. It must provide bounded pagination, cursor-cycle protection, exact project/account scoping, and ownership filtering.

Core's public `listSandboxes` and `listSnapshots` remain repository-backed. Do not add provider N+1 listing to ordinary reads.

### Errors And Cancellation

- Preserve the current public provider error categories unless shared conformance proves a missing provider-neutral category.
- Definite provider rejection maps to failure; quota/capacity maps to limit; unresolved mutation outcome maps to ambiguous execution.
- Caller abort wins only when the mutation outcome is not already known to be ambiguous.
- Every request, response stream, command wait, log read, and poll sleep is abort-aware and bounded.
- Provider response bodies, commands, paths, credentials, team/project identifiers, and provider resource identifiers do not enter public errors or ordinary diagnostics.

## Shared Runtime Contract

The shared runtime backend composes primitives as follows:

```text
prepareSandbox
    -> runCommand(verify)
    -> if incomplete: writeFile(artifact)
    -> runCommand(install)
    -> runCommand(final verify)

executeTool
    -> encode canonical CLI invocation
    -> runCommand(waterbox run ...)
    -> validate exactly one canonical event

secureFileTransfer.initiate
    -> runCommand(waterbox transfer-initiate)

secureFileTransfer.consume
    -> writeFile(ciphertext)
    -> runCommand(waterbox transfer-consume ...)

bashJobs.observe / cleanup
    -> runCommand(private CLI operation)
```

The shared layer owns protocol encoding and validation. The primitive adapter owns only transport facts. A fake primitive implementation must be able to run the complete shared runtime conformance suite without Box- or Vercel-shaped DTOs.

## Phase 1: Primitive Contract And Characterization

Status: complete

Scope:

- Add the primitive types without removing the current high-level provider interface.
- Add focused shared conformance helpers for primitive lifecycle, terminal commands, file writes, stop/resume, snapshots, source-snapshot create, and optional inventory.
- Characterize the existing Box behavior before extraction, including exact requests, state mapping, ambiguity, cancellation, response bounds, and reference shapes.
- Add a provider-neutral fake primitive implementation for shared runtime work.
- Decide and document the exact command input representation and output bounds using both Box API behavior and the completed Vercel evidence.
- Add `packages/sandbox-provider-runtime` as the host-side shared backend package; do not place this code in the existing sandbox-side `packages/sandbox-runtime` package or add CLI/artifact concerns to `sandbox-core`.
- Settle and test the semantic full-Linux runtime profile against Box behavior and Vercel evidence before extracting Box commands.
- Change generic explicit snapshot creation to require a running sandbox and update core/API/client expectations without an implicit resume.
- Require the snapshot primitive to revalidate provider-native running state at dispatch and add a concurrent stop/snapshot regression; a stale core preflight must not cause hidden resume or an unsafe mutation retry.
- Preserve lifecycle `ambiguous_execution` over a racing caller abort after provider dispatch, with regression tests for create, stop, resume, delete, and snapshot mutations.

Acceptance criteria:

- The primitive contract contains no Box or Vercel names, DTOs, endpoint versions, archive formats, or session assumptions.
- Create, inspect, run command, write file, delete, stop/resume, snapshots, and source-snapshot create have explicit semantics.
- Exact inspect is mandatory; inventory is not used as a substitute.
- Command and file limits, cancellation, ambiguity, ownership, and secret-redaction rules are testable.
- The current unresolved no-reference create/snapshot interval is characterized and remains visible; no fake durability guarantee is added.
- Existing Box, API shape, client, MCP, and local composition behavior remains unchanged except for the explicitly approved generic running-only snapshot precondition and ambiguity-over-abort correction.

Verification:

```sh
bun run test
bun run typecheck
bun run build:mcp
git diff --check
```

## Phase 2: Shared Waterbox Runtime Extraction

Status: complete; depends on Phase 1

Scope:

- Implement the shared runtime backend over a fake primitive provider.
- Extract verify-first preparation, artifact upload/install/final verification, and runtime diagnostics from Box-specific code.
- Extract CLI invocation encoding, result classification, canonical tool-event validation, and ambiguity handling.
- Extract secure-transfer initiation/consumption and Bash-job observation/cleanup command composition.
- Preserve the existing core-facing high-level provider behavior and capability groups.
- Do not change Box HTTP behavior yet beyond small seams required for extraction.

Acceptance criteria:

- One provider-neutral suite proves fresh and already-prepared runtime paths, stale snapshot runtime repair, all seven tools, secure transfer, and Bash jobs over fake primitives.
- Preparation remains idempotent, verify-first, and recoverable after ambiguous upload/install outcomes.
- Shared code contains no Box/Vercel branch and consumes no provider-specific response.
- Secure transfer uploads ciphertext only.
- Current Box tests remain green.

Verification:

```sh
bun run test
bun run typecheck
bun run build:mcp
git diff --check
```

## Phase 3: Box Primitive Migration

Status: complete; depends on Phase 2

Scope:

- Extract `BoxSandboxInfrastructure` from `BoxSandboxProvider`.
- Keep Box endpoint/authentication, native state mapping, readiness/deletion polling, idempotency, snapshot naming/reconciliation, response correlation, bounds, cancellation, and diagnostics in the Box primitive adapter.
- Compose Box through the shared runtime backend.
- Preserve the existing exported Box composition surface where useful to avoid unrelated local-control-plane churn during this phase.
- Preserve persisted `{ kind: "box-sandbox-v2", boxId }` and `{ kind: "box-named-snapshot-v2", name }` references.
- Split tests into Box primitive contracts, shared runtime behavior, and thin assembled-provider compatibility.

Acceptance criteria:

- Box-specific code no longer implements Waterbox CLI preparation, tool schemas, secure-transfer protocol, or Bash-job protocol.
- The assembled Box backend remains behaviorally equivalent at the current `SandboxService` boundary.
- Existing persisted Box references work without migration or compatibility aliases.
- No public API/client/MCP contract changes.
- Credential-free repository tests and builds remain green.

Verification:

```sh
bun test packages/sandbox-provider-box/test packages/sandbox-core/test packages/control-plane-local/test packages/sandbox-api/test packages/client/test packages/mcp/test
bun run typecheck
bun run build:mcp
git diff --check
```

## Phase 4: Box Live Regression Gate

Status: complete; depends on Phase 3

Scope:

- Run the existing separately authorized direct-REST Box capability probe, then run the assembled refactored Box backend smoke.
- Run the configured Fetch-backed MCP path through the refactored Box composition.
- Cover fresh preparation, already-current preparation, deliberately stale snapshot-sourced repair, all tools, secure transfer, Bash jobs, concurrency, stop/resume, snapshots, restore, deletion, and exact cleanup.
- Compare provider request behavior and persisted references with the pre-refactor baseline.

Acceptance criteria:

- Box passes with no behavior, durability, recovery, diagnostics, or cleanup regression.
- Exact active baseline is restored.
- No production Vercel composition begins before this gate passes.
- Any Box-specific behavior that leaked into the shared layer is removed or justified as a provider-neutral full-Linux runtime requirement.

Verification is recorded with the exact authorized commands, sanitized outcomes, Node versions, and cleanup facts. Credentials and provider identifiers are not retained in this plan.

## Phase 5: Vercel Primitive Adapter

Status: complete; depends on Phase 4

Scope:

- Add `packages/sandbox-provider-vercel` implementing only the primitive port.
- Implement the Vercel transport with injected native `fetch`; do not add the Vercel SDK or inherit hidden SDK retries.
- Implement strict typed adapter configuration and dependency validation before any Vercel request. Composition-level ordering before artifact, filesystem, and SQLite effects remains Phase 6 work.
- Implement persistent named create, exact non-resuming inspect, terminal command execution, file write, stop/resume, delete, snapshots, source-snapshot create, and inventory.
- Hide Vercel session replacement and REST endpoint-version details below the primitive boundary.
- Reuse completed probe facts for validated paths and states, but implement production-quality bounds, error mapping, diagnostics, and ownership.
- Add credential-free fake-server tests for every mutation ambiguity and cleanup case.

Acceptance criteria:

- Vercel passes the same primitive conformance expectations as Box for every shared capability.
- Deterministic name/tag ownership safely reconciles only transport-lost create responses.
- Inspection never resumes.
- Commands do not retry execution; terminal observation and logs are bounded and correlated.
- File uploads preserve exact bytes and modes required by runtime installation.
- Stop/resume preserves durable sandbox identity while replacing session identity internally.
- Snapshots handle transient states, running-source creation, source restore, automatic persistence artifacts, 404, and deleted tombstones.
- Snapshot-create contracts prove provider-neutral source-sandbox reconciliation when a manual Vercel snapshot terminally stops its source, while Box proves the optional observation can be omitted without a source-state change.
- Vercel implements bounded automatic-snapshot retention through Waterbox-tracked, ownership-verified targeted cleanup, never provider-global `keepLastSnapshots`, enumeration-and-deletion, or explicit-snapshot eviction. A successfully persisted stop may update the bounded automatic-snapshot reference; delete independently resolves, proves, and removes the current automatic snapshot before removing the sandbox without touching explicit Waterbox snapshots. Fake contracts distinguish explicit from automatic cleanup, and Phase 7 live acceptance verifies the same safety.
- Errors and diagnostics are secret-safe.
- No Vercel package is imported by core, API, client, or MCP.

Verification:

```sh
bun test packages/sandbox-provider-vercel/test packages/sandbox-provider-box/test
bun run typecheck
git diff --check
```

## Phase 6: Vercel Runtime Composition And Local Configuration

Status: complete; depends on Phase 5

Scope:

- Compose Vercel primitives through the same shared Waterbox runtime backend used by Box.
- Add explicit Vercel selection to `@waterbox/control-plane-local` while retaining Box and injected test composition.
- Load the same caller-owned runtime artifact before SQLite/provider side effects.
- Implement the settled `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` access-token configuration using official non-Vercel-hosting guidance.
- Keep external provider selection explicit; composition may pass the selected backend as core's explicit `defaultProvider`, but neither Box nor Vercel is chosen as a fallback when configuration is absent or malformed.
- Update side-effect-free unconfigured setup guidance and provider capability metadata without provider branches above composition.
- Add configured fake flows through local control plane, embedded Fetch API, client, and MCP.
- Add a Node-compatible configured provider-composition smoke script used by both minimum and current Node 24 binaries.

Acceptance criteria:

- The shared runtime suite runs unchanged over assembled Box and Vercel backends.
- Vercel does not duplicate preparation, CLI event parsing, secure transfer, or Bash-job logic.
- Invalid or incomplete Vercel configuration fails before artifacts, local files, SQLite, or provider APIs are touched.
- Unconfigured MCP setup remains connected and side-effect free.
- Provider credentials never enter tool arguments, content, SQLite, artifacts, or diagnostics.
- Core, API, client, and MCP contain no provider-name behavior branch.

Verification:

```sh
bun test packages/sandbox-provider-box/test packages/sandbox-provider-vercel/test packages/control-plane-local/test packages/sandbox-api/test packages/client/test packages/mcp/test
bun run typecheck
bun run build:mcp
"$NODE_24_15_BIN" scripts/provider-composition-node-smoke.mjs
"$NODE_24_CURRENT_BIN" scripts/provider-composition-node-smoke.mjs
git diff --check
```

## Phase 7: Authorized Vercel Acceptance And Two-Provider Closure

Status: complete; depends on Phase 6

Scope:

- Run a separately authorized isolated-project Vercel smoke through the production adapter and shared runtime composition, not the capability probe.
- Exercise fresh create and preparation, all seven tools, secure transfer, Bash jobs, command cancellation/kill where supported, stop/resume, explicit snapshots, source-snapshot create, stale-runtime repair, delete, and exact cleanup.
- Exercise every optional capability Vercel advertises to core.
- Re-run the authorized Box regression if shared code changed after Phase 4.
- Run repository-wide verification, Node compatibility, and MCP build before handing control back to the launch plan.
- Update current architecture documentation, provider package READMEs, and the provider capability/configuration reference. Root/npm installation and release documentation remain launch Phase 8 work.

Acceptance criteria:

- Box and Vercel both pass the shared mandatory backend behavior.
- Both advertised implementations pass stop/resume, running-source snapshots, and source-snapshot restore.
- Both install or repair the exact current runtime artifact and verify Node 24, `rg`, CLI health, protocol version, and digest.
- Both execute all seven tools through the same shared Waterbox runtime implementation.
- Both pass secure-transfer ciphertext-only transport and one-use consumption.
- Both pass Bash dispatch, bounded observation, terminal drain, and cleanup.
- Each live provider returns to its exact active baseline with no owned running/stopped sandbox or active snapshot leak.
- Vercel automatic snapshot retention and tombstones do not create unbounded storage leakage.
- No provider identifier, command, cwd, payload, or credential is retained in public/sanitized evidence.
- Phase 7 of the launch plan can be marked complete and Vercel can be called launch-supported at the implementation level. npm release gates remain separate.

Verification:

```sh
bun run test
bun run typecheck
bun run build:mcp
bun run test:node-sqlite
"$NODE_24_15_BIN" scripts/provider-composition-node-smoke.mjs
"$NODE_24_CURRENT_BIN" scripts/provider-composition-node-smoke.mjs
git diff --check
```

Also run the focused provider, local composition, API, client, MCP, and separately authorized live commands recorded by the implementation. Package dry-run and release-artifact closure remain launch Phase 8 work.

## Explicit Non-Goals

- No hosted Waterbox control plane.
- No provider auto-selection or credential discovery through model-visible inputs.
- No replacement of repository-backed public listing with provider inventory.
- No generic remote shell/session API exposed publicly.
- No plaintext secure-transfer shortcut through provider file upload.
- No provider-specific state or branch in contracts, core, API, client, or MCP.
- No migration framework for unpublished Vercel records.
- No removal of lifecycle checkpoints or collapse of create and preparation into one atomic-looking provider call.
- No npm publication, legal notice closure, or registry submission; those remain launch-plan work.

## Risks And Controls

| Risk | Control |
| --- | --- |
| Primitive port merely mirrors Box | Require Vercel evidence in Phase 1 semantics and unchanged conformance in Phase 5 |
| Shared layer accumulates provider branches | Inject narrow semantic runtime profile only; prohibit provider-name checks |
| Box regression during extraction | Characterization tests, preserved references, phased migration, authorized live gate before Vercel composition |
| Vercel session IDs leak into durable records | Persist only durable named sandbox reference; resolve sessions adapter-locally |
| Command abstraction favors one provider | Use bounded terminal result, not Box DTO, Vercel command handle, or provider-native stream |
| File abstraction favors one wire format | Use bytes/path/mode semantics; encode base64 or gzip-tar adapter-locally |
| Ambiguous mutation is retried unsafely | Stable operation identity, exact read-only reconciliation, no blind mutation retry |
| Automatic snapshots leak storage | Explicit retention, tracked ownership, tombstone-aware deletion, exact baseline live checks |
| Runtime extraction weakens secure transfer | Shared tests require ciphertext-only provider upload and one-use sandbox consume |
| Big-bang rewrite hides failures | Hard phase boundary: Box credential-free, then Box live, then Vercel |

## Completion Checklist

- [x] Primitive provider contract accepted and covered by shared conformance tests.
- [x] Shared Waterbox runtime behavior extracted from Box-specific code.
- [x] Box uses primitives plus shared runtime with existing references preserved.
- [x] Authorized Box regression and exact cleanup pass.
- [x] Vercel primitive adapter passes credential-free conformance.
- [x] Vercel local composition and side-effect-free configuration behavior pass.
- [x] Authorized production Vercel backend smoke and exact cleanup pass.
- [x] Shared runtime parity passes for Box and Vercel.
- [x] No provider-name branch exists above composition.
- [x] Architecture and provider capability documentation reflect the implemented boundary.
- [x] Launch Phase 7 is updated with completion evidence.

## Implementation Log

- 2026-09-01: Plan created after the completed Vercel capability probe and follow-up provider-neutrality review. The review found a direct shared infrastructure intersection across Box and Vercel, while the current provider interface mixed native lifecycle/transport with shared Waterbox runtime behavior. The approved sequence is primitive contract, shared runtime extraction, Box migration, Box live regression, Vercel primitive implementation, configured composition, and two-provider live closure. Native `fetch` against the validated REST surface is the settled Vercel production transport; no Vercel SDK dependency is planned. No production code or live provider operation occurred while writing this plan.
- 2026-09-01: Phase 1 complete: added the provider-neutral primitive contract, fake/conformance support, semantic full-Linux runtime profile, running-only snapshot and lifecycle ambiguity-over-abort corrections, plus Box native snapshot running revalidation. No architectural deviation was required. Independent review accepted the phase; credential-free verification passed with 469 tests, `bun run typecheck`, `bun run build:mcp`, and `git diff --check`.
- 2026-09-01: Phase 2 complete: extracted the shared Waterbox runtime backend over provider-neutral primitives, covering verify-first preparation, canonical CLI protocol handling, ciphertext-only secure transfer, and Bash-job operations. The full-Linux profile now provides concrete paths and a narrow injected non-interactive path provisioner; the bootstrap and launcher use the CLI's real `/run/waterbox/bash-jobs` root. No architectural deviation was required. Independent review accepted the correction set; credential-free verification passed with 476 tests, `bun run typecheck`, `bun run build:mcp`, and `git diff --check`.
- 2026-09-01: Phase 3 complete: migrated Box to `BoxSandboxInfrastructure` plus the shared `WaterboxSandboxBackend` composition. Box retains only native endpoint/authentication, state and reference mapping, polling, idempotency, snapshot reconciliation, bounded terminal/file transport, cancellation, diagnostics, and its proven non-interactive privilege provisioner; shared preparation, CLI tools, ciphertext transfer, and Bash-job behavior are no longer implemented in the adapter. Persisted `box-sandbox-v2` and `box-named-snapshot-v2` references remain unchanged. No architectural deviation was required. Independent review accepted the corrective set; credential-free focused verification passed with 179 tests, `bun run typecheck`, `bun run build:mcp`, and `git diff --check`.
- 2026-09-01: Phase 4 complete: authorized Box verification ran `BOX_CAPABILITY_PROBE_AUTHORIZATION=… bun run scripts/box-capability-probe.ts --run` and `WATERBOX_MCP_EXPERIMENT_AUTHORIZATION=… WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT=YES bun run smoke:mcp-direct`. The capability probe passed create, replay, snapshot, restore, stop/resume, and deletion. The assembled embedded smoke passed fresh/current preparation, all seven tools, ciphertext transfer, asynchronous Bash, concurrency, running-only snapshot, stale-runtime repair, restore, and deletion through stdio MCP -> authenticated embedded Fetch API -> local control plane -> SQLite + Box. Both runs reported exact active-baseline restoration; final aggregate Box inventory was zero boxes and zero snapshots. The `api-local` listener and development API variables were not used. Corrective validation confirmed lifecycle mutation ambiguity and running-only snapshot copy; no architecture deviation was required.
- 2026-09-02: DEVIATION — official Vercel Sandbox documentation verification established that provider-global `keepLastSnapshots` governs every snapshot, including explicit snapshots. The affected invariant is that automatic cleanup must never touch explicit Waterbox snapshots. Phase 5 therefore uses only Waterbox-tracked, ownership-verified targeted cleanup of automatic snapshot references, never provider-global retention or enumerate-and-delete behavior. Resulting verification is a fake-contract distinction between explicit and automatic cleanup plus Phase 7 live acceptance; no identifiers or secrets were retained.
- 2026-09-02: DEVIATION — audited Vercel evidence established that manual snapshot creation may return or transition through `snapshotting`, while bounded non-resuming lookup can terminally report the source sandbox as stopped. The prior generic snapshot result could persist only the snapshot and leave the Waterbox source state running. The affected invariants are durable source-state accuracy, no implicit resume, and safe recovery from a completed snapshot whose source stopped. Snapshot creation therefore carries a provider-neutral optional source-sandbox observation that shared core applies when supplied; Box omits it when no source-state change occurs, without provider branches. Resulting verification is fake-contract coverage for stopped-source reconciliation and omitted-observation compatibility, plus a Phase 7 live manual-snapshot test; no identifiers or secrets were retained.
- 2026-09-02: Phase 5 complete: added `@waterbox/provider-vercel`, an injected native-`fetch` direct-REST primitive adapter with no SDK. It uses named/tagged durable references with no persisted session IDs; implements exact inspect, bounded commands and file upload, stop/resume, snapshots and source-snapshot create, inventory, strict contracts, no mutation replay, and ownership-verified targeted automatic-snapshot cleanup. The two recorded deviations are retained: provider-global `keepLastSnapshots` is not used because it can evict explicit snapshots, and snapshot creation carries a provider-neutral source observation because the post-manual-snapshot source can be stopped; shared core performs that reconciliation. Independent review accepted the phase. Credential-free verification passed: `bun test packages/sandbox-core/test packages/sandbox-provider-vercel/test packages/sandbox-provider-runtime/test packages/sandbox-provider-box/test` (113 pass, 650 expectations), `bun run typecheck`, and `git diff --check`. No live Vercel operations occurred.
- 2026-09-02: Phase 6 complete: composed Vercel as a thin facade over the shared runtime, with explicit provider selection, configuration, and artifact validation below `@waterbox/control-plane-local`. MCP, core, API, and client contain no provider imports or behavior branches. Configured fake embedded Fetch API, local control plane, SQLite, and MCP flows plus the provider-composition Node smoke passed under the default Node v24.19.0; the README configuration reference was updated. Independent review accepted the phase. Credential-free verification passed: `bun test packages/sandbox-provider-box/test packages/sandbox-provider-vercel/test packages/control-plane-local/test packages/sandbox-api/test packages/client/test packages/mcp/test` (144 pass, 833 expectations), `bun run typecheck`, `bun run build:mcp`, and `git diff --check`. `$NODE_24_15_BIN` and `$NODE_24_CURRENT_BIN` were absent, so their mandated invocations were not run and no substitute was used.
- 2026-09-02: Phase 7 complete: the Vercel production adapter passed the embedded MCP acceptance flow for fresh/current preparation, all seven tools, ciphertext transfer, asynchronous Bash, concurrency, snapshot-source restore and stale-runtime repair, stop/resume, and native caller abort with one dispatch, kill, and terminal follow-up. Automatic snapshots used an exact owned sandbox link and automatic method with tombstone-aware cleanup; final active Vercel sandbox and snapshot counts were both zero. The direct embedded Box regression also passed with exact baseline restoration. Corrective provider-neutral, adapter-local work covered fresh-workspace pre-dispatch fallback, a full-Linux detached-Node expiry fallback where systemd is absent, and automatic-snapshot ownership proof from the exact owned sandbox's current snapshot plus automatic method because live metadata lacks copied source/tag fields. Full verification passed: `bun run test` (474 pass, 2433 expectations), `bun run typecheck`, `bun run build:mcp`, `bun run test:node-sqlite`, the default Node provider-composition smoke, and `git diff --check`. `$NODE_24_15_BIN` and `$NODE_24_CURRENT_BIN` were absent, so their named invocations were not run and no substitution was used. npm/release work remains in the launch plan.
