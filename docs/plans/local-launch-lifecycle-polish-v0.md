# Local Launch Lifecycle Polish V0

Status: complete

This is the standalone implementation plan for the remaining local Waterbox launch work around provider-bound resources, provider workspace durability, automatic stop configuration, request-time state convergence, model-visible lifecycle control, provider-default snapshot retention, and readable resource identifiers.

This plan records settled product and engineering decisions. An implementation assignment may refer to the entire plan or to one phase, for example: "Implement Phase 3 of `docs/plans/local-launch-lifecycle-polish-v0.md`."

Waterbox is prelaunch. Do not add compatibility aliases or broad migration machinery for unpublished local state unless an implementation issue explicitly requires it.

## How To Use This Plan

An implementation agent assigned a phase must:

1. Read this entire plan and all prerequisite phases.
2. Inspect the current worktree and preserve unrelated or concurrent changes.
3. Reconfirm referenced code before editing because package boundaries may have moved.
4. Implement only the assigned phase and its acceptance criteria.
5. Add or update focused tests for every changed invariant.
6. Run the focused package tests, repository typecheck, repository-wide tests where practical, and `git diff --check`.
7. Update the phase status and append a short implementation-log entry containing verification facts.
8. Stop at the assigned phase boundary.

Do not reinterpret settled requirements while implementing a phase. If a provider contract contradicts this plan, record the exact evidence and stop instead of introducing retries, provider discovery, silent fallback behavior, or guessed limits.

No live provider mutation is authorized merely by this document. Live probes remain separately authorized, credentialed, bounded, isolated, and cleanup-reconciled.

## Objective

This plan is complete when:

- Every registered sandbox and snapshot is bound to the exact provider resource scope that created it.
- Changing provider scope never causes Waterbox to contact the wrong provider configuration for an existing resource.
- Setup warns before changing resource scope and does not delete credentials required to switch back.
- Repository listings expose only resources belonging to the active provider binding.
- Relative paths and default commands start in a provider-selected, snapshot-durable workspace without promising a universal absolute path.
- Users may optionally configure one automatic-stop duration in whole minutes or hours at setup or through environment configuration.
- Waterbox forwards automatic-stop configuration without encoding provider plans, maxima, or enforcement promises.
- Stable provider state is treated as a last observation rather than local authority.
- Provider failures trigger bounded, operation-aware investigation when useful, without automatic mutation retries.
- An automatic provider stop is learned on the next relevant request, allowing a later ordinary tool request to resume the sandbox.
- Agents can explicitly stop a known sandbox but cannot enumerate all locally registered sandboxes.
- Vercel snapshot retention follows Vercel defaults rather than a Waterbox-defined one-day override.
- Sandbox and snapshot IDs use a vendored Friendly Words predicate-predicate-object corpus, such as `tranquil-swift-wallaby`.
- Generated-ID collisions are resolved safely before provider dispatch without corrupting idempotency ownership.

## Current State

The current repository behavior relevant to this plan is:

- Local composition stores both providers in the same default SQLite file, `~/.waterbox/direct.sqlite`, and composes only the selected provider (`packages/control-plane-local/src/index.ts`).
- Records store a provider name and opaque provider reference, but no provider-configuration binding (`packages/sandbox-core/src/records.ts`).
- Setup stores one active configuration and deletes the other provider credential after switching (`packages/mcp/src/onboarding.ts`).
- Snapshot and sandbox repository identities are account-scoped Waterbox IDs. Provider references remain private implementation data.
- Stable sandbox states are generally returned from SQLite. Explicit probe and transitional-state reconciliation inspect the provider (`packages/sandbox-core/src/service.ts`).
- Stop, resume, sandbox delete, and snapshot delete currently turn provider errors into durable `failed` states, including ambiguous outcomes.
- Tool dispatch trusts a locally recorded `running` state. A provider-side automatic stop can therefore make the first later tool request fail without updating SQLite.
- The shared runtime profile already supports a provider-selected `workspacePath`; Box and Vercel currently both use `/workspace` (`packages/sandbox-provider-runtime/src/index.ts`).
- Box named snapshots do not document `/workspace` as persistent. Box's existing capability probe validates persistence under `/home/user`.
- Box production create does not send `ttlSeconds`.
- Vercel production create does not send a session `timeout` and hardcodes `snapshotExpiration: 86_400_000` (`packages/sandbox-provider-vercel/src/index.ts`).
- Core and API already support stop and resume, but the client and MCP expose neither.
- MCP intentionally has no `list_sandboxes` tool.
- Production IDs currently use six adjectives, six nouns, and a variable-width random suffix (`packages/control-plane-local/src/index.ts`).
- Sandbox creation publishes an idempotency reservation before inserting the sandbox record. Generated-ID collisions are not retried (`packages/sandbox-core/src/service.ts`).

## Settled Decisions

### Registered Resources Only

- Waterbox operates only on resources already registered in its repository.
- Waterbox does not discover, adopt, or expose resources by listing a provider account.
- Provider inspection is allowed only through the provider reference of a known Waterbox record.
- Repository listings are not provider discovery.
- `list_sandboxes` remains absent from MCP.
- Existing provider inventory capabilities remain provider-internal and are not made authoritative by this plan.

### Provider Binding

- Every sandbox and snapshot record carries both a provider name and a stable `providerConfigurationId`.
- The identifier represents the provider resource scope, not every hydrated operational setting.
- The identifier is deterministic so the same setup and environment-only configuration activate the same records.
- Direct lookup of a registered resource under another binding returns a canonical `provider_configuration_mismatch`; it must not contact the active provider using the stale reference.
- Listings include only records belonging to the active binding.
- Provider binding is stored as a separate field. Do not concatenate provider, binding, and Waterbox ID into an opaque database primary key.
- Provider references remain opaque, private, and provider-owned.
- Provider switching does not stop, delete, migrate, or otherwise manage existing remote resources.

### Provider Binding Derivation

Derive `providerConfigurationId` from a canonical, versioned identity projection. Do not hash the entire hydrated configuration.

The derivation must:

1. Normalize all included values before serialization.
2. Serialize a fixed-order tuple or another demonstrably canonical representation.
3. Include a domain and schema version such as `waterbox-provider-binding-v1`.
4. Hash with SHA-256.
5. Encode to a constrained internal string, for example `pcfg_<base64url digest>`.
6. Never log or expose the canonical material.
7. Produce identical output in persisted-setup and environment-only paths.

Vercel binding material contains only identity-bearing values:

```text
waterbox-provider-binding-v1
vercel
normalized API origin
trimmed team ID
trimmed project ID
```

The Vercel token is excluded. Rotating credentials for the same team/project must not stale resources.

Box has no currently established stable account identifier. Its binding material therefore contains:

```text
waterbox-provider-binding-v1
box
normalized API base URL
SHA-256 fingerprint of the exact API key
```

The raw Box API key is never serialized into persisted configuration, records, errors, or diagnostics. A Box key change conservatively creates a different binding. Restoring the exact former key recreates the former binding. If Box later exposes a stable account identifier, adopt it only through a separately planned binding schema version.

Exclude all operational settings from provider binding material, including:

- Automatic-stop duration.
- Polling intervals and deadlines.
- Request timeouts.
- SQLite paths.
- Runtime artifact versions or locations.
- Human-facing provider labels.

### Provider Switching

- Interactive setup warns and requires confirmation when the resulting binding differs from the current binding.
- The warning states that existing resources are not stopped, deleted, or migrated and may continue incurring provider charges.
- Setup retains credentials for inactive providers. It must not delete the other provider credential.
- Only one provider binding is active in the embedded V0 composition.
- Switching back to exactly the prior resource scope makes its registered resources active again.
- Waterbox does not attempt multi-provider orchestration, cleanup, or migration.
- `logout` may continue removing all Waterbox credentials, but its user-facing contract must not imply that remote resources or SQLite records are deleted.

### Local State Authority

- Keep durable sandbox and snapshot states.
- Stable provider states such as `running`, `stopped`, `terminated`, `ready`, and `deleted` are last-observed caches.
- Waterbox-owned workflow states such as `provisioning`, `preparing`, `stopping`, `resuming`, `terminating`, `creating`, and `deleting` remain durable checkpoints.
- Do not add a daemon, startup sweep, provider webhook listener, or periodic background reconciliation.
- Do not inspect before every happy-path operation.
- Reconcile in response to provider results and errors.
- Never automatically retry a user command, file mutation, lifecycle mutation, snapshot mutation, or secure-transfer consumption after an ambiguous result.

### Attempt Then Investigate

The common policy is:

```text
attempt operation
  -> success: validate and persist its observation
  -> known canonical provider result: run the operation-specific handler
  -> other provider failure: inspect the registered resource once when exact inspection is available
       -> useful observation: persist only conclusions valid for that operation
       -> unchanged or inconclusive observation: preserve required recovery state
       -> inspection failure: preserve the original safe provider error
  -> surface the operation result or safe original error
```

Investigation and retry are separate concepts. This plan adds investigation and prohibits automatic mutation retry.

Operation-specific rules include:

- Stop reporting an already-stopped sandbox persists `stopped` and succeeds idempotently.
- Resume reporting an already-running sandbox persists `running` and succeeds idempotently.
- Exact provider absence persists the appropriate terminal state only when the adapter establishes that absence is authoritative for the registered resource.
- A definite pre-dispatch rejection may restore the prior stable state and surface the canonical error.
- An ambiguous lifecycle mutation retains its transitional checkpoint. Do not replace it with `failed` merely because the mutation response was lost.
- Observing the old state immediately after an ambiguous asynchronous mutation can be inconclusive. Retain the transition when delayed completion remains possible.
- Inspecting sandbox state after an ambiguous command or file mutation can update a newly observed stopped or terminated state, but it cannot establish whether the command or write ran. Surface the original ambiguity.
- Snapshot mutation reconciliation remains snapshot-specific. Sandbox status cannot prove whether a snapshot mutation succeeded.
- Existing provider-local exact reconciliation remains provider-owned. Core must not repeat an investigation that an adapter has already resolved conclusively.

The provider error boundary may be refined to express at least:

- A known observed resource state or exact absence.
- A provider limit.
- A definite generic failure.
- An ambiguous execution or mutation outcome.

Do not expose raw HTTP status codes or provider response bodies above the adapter boundary.

### Workspace

- The public invariant is "relative paths start in the sandbox workspace," not "all providers use `/workspace`."
- Commands start in the provider runtime profile's `workspacePath`.
- Box uses a snapshot-durable location under `/home/user`, preferably `/home/user/workspace`.
- Vercel retains its current workspace unless provider evidence requires a change.
- Do not create a `/workspace` symlink solely for compatibility.
- Absolute paths remain available where the underlying tool contract permits them.
- MCP descriptions and launch documentation must not promise a provider-independent absolute workspace path.

### Automatic Stop

- Add one optional operator setting named automatic-stop duration.
- Environment form: `WATERBOX_AUTO_STOP`.
- Accept positive whole minutes or hours only: `30m`, `90m`, `2h`, `24h`.
- Reject decimals, compound durations, seconds, days, zero, negative values, whitespace-only values, unsafe numeric conversions, and unknown units.
- Blank during setup means provider default. An absent environment variable also means provider default.
- The setup prompt explains:

```text
Choose a duration long enough for your longest uninterrupted workflow.
Providers and plans enforce different limits and may reject, clamp, or stop
earlier than requested. Leave blank to use the provider default. A sandbox can
be stopped or permanently deleted earlier.
```

- Waterbox defines no provider-specific maximum and carries no plan matrix.
- Do not expose this value through `create_sandbox` or any model-visible tool.
- Do not promise that providers reject values above a plan limit.
- Map the canonical duration to Box `ttlSeconds` and Vercel session `timeout` using provider-native units.
- Omitting the setting must omit the corresponding provider request field rather than supplying a Waterbox default.
- Automatic stop is not permanent deletion, retention, snapshot expiration, idempotency expiration, command timeout, or a Waterbox reaper.

Before declaring provider acceptance complete, separately authorized live evidence must confirm that Box `ttlSeconds` and Vercel `timeout` behave sufficiently like automatic compute stop for this common setting. If either provider deletes durable state instead, stop and revise the common contract.

### Snapshot Retention

- Remove Waterbox's hardcoded one-day Vercel `snapshotExpiration`.
- Omit provider snapshot-retention fields and inherit provider defaults.
- Do not configure indefinite retention.
- Do not add a provider-neutral snapshot-expiration setting in this plan.
- An expired or externally deleted registered snapshot may later reconcile to `deleted` or surface not found.
- Documentation states that retention is provider-controlled and snapshots may expire.
- Keep targeted cleanup of superseded Vercel automatic snapshots where it is already proven safe.
- Do not introduce `keepLastSnapshots`; it can affect explicit user snapshots.

### Model-Visible Lifecycle Tools

- Add `stop_sandbox` to the client and MCP.
- Do not add `list_sandboxes`.
- Do not add model-visible automatic-stop configuration.
- Do not add `resume_sandbox` to MCP in this plan. Ordinary sandbox tools already auto-resume a locally observed stopped sandbox.
- Keep `probe_sandbox` as the explicit live observation tool.
- Keep `delete_sandbox` as permanent cleanup distinct from stop.

### Readable IDs

- Vendor a pinned snapshot of Glitch `friendly-words`; do not add its npm package.
- Use upstream commit `f94b4639c71c26875f7684fa86a214c7f30deaad` unless implementation-time verification proves it invalid.
- Preserve the upstream MIT notice and add attribution to `THIRD_PARTY_NOTICES.md`.
- Use predicates as the corpus names them. Do not perform subjective adjective or grammar filtering.
- Generate two independent predicates and one object:

```text
sbx_tranquil-swift-wallaby
snap_tranquil-swift-wallaby
```

- Do not append an opaque random suffix.
- IDs are handles, not secrets or authorization tokens.
- Select each word uniformly. Do not use random-byte modulo list length.
- Enforce existing Waterbox ID schemas and provider-native name limits.
- Repository uniqueness remains authoritative.
- Retry generated-ID collisions a bounded number of times before any provider mutation.

The pinned corpus is expected to contain approximately 1,450 predicates and 3,062 objects, yielding roughly 6.44 billion predicate-predicate-object combinations. That namespace requires collision handling but does not require a suffix when allocation is correct.

### Collision And Idempotency Safety

- A simple retry around the current sandbox `createIfAbsent` call is not sufficient.
- The current idempotency reservation points to a generated resource ID before the sandbox row is inserted. A collision can therefore associate a reservation with an unrelated existing sandbox.
- Add a repository-level atomic sandbox-creation reservation operation, or an equivalently rigorous transaction-backed mechanism.
- The operation must atomically establish ownership of both the idempotency reservation and sandbox row when an idempotency key is present.
- Concurrent callers using the same idempotency key must converge on the same owned sandbox.
- A candidate collision must not publish that candidate as the idempotent request's resource.
- Once a sandbox row is reserved successfully, its Waterbox ID stays stable through provider dispatch, restart, preparation, and reconciliation.
- Retry only candidate allocation collisions. Never retry provider mutations because their result is ambiguous.
- Snapshot allocation does not share the sandbox idempotency reservation and may use a bounded repository insertion loop.
- Exhausting the allocation bound returns a safe internal allocation error and performs no provider mutation.

## Non-Goals

Do not add in this plan:

- A daemon, scheduler, startup sweep, or webhook listener.
- Provider account discovery or adoption.
- MCP `list_sandboxes`.
- Multi-provider composition in one embedded process.
- Cross-provider migration or cleanup.
- Automatic cleanup when switching providers.
- Automatic retries after ambiguous provider mutations.
- Provider plan tables or hardcoded provider maxima.
- A model-visible per-sandbox lifetime argument.
- Permanent sandbox expiration or a Waterbox reaper.
- Waterbox-defined snapshot retention.
- A `/workspace` compatibility symlink.
- Subjective filtering of the Friendly Words corpus.
- An opaque ID suffix.
- Public provider references or provider-configuration identifiers.
- Vercel session IDs in durable core records.
- General schema migration infrastructure solely for unpublished prelaunch SQLite files.
- The deferred smaller MCP description, error-message, rate-limit, concurrency, and package-release polish items unless directly required by a phase below.

## Target Architecture

```text
persisted/environment provider settings
    |
    +-- identity projection -> providerConfigurationId
    |
    `-- operational settings -> provider adapter config

active configured provider
    |
    v
SandboxService
    |
    +-- repository lookup by account + Waterbox ID
    +-- provider binding check before provider access
    +-- operation-specific attempt/investigate policy
    |
    v
registered record
    provider
    providerConfigurationId
    opaque providerRef
    last-observed or workflow state
```

Provider binding selects which records are operable. Provider reference identifies the exact native resource within that binding. These concepts must remain separate.

## Phase 1: Provider Binding Derivation

Status: complete

### Scope

Implement one shared, tested derivation path used by persisted setup and environment-only composition.

### Work

1. Add a constrained internal `ProviderConfigurationId` type or validation boundary in the lowest package that can be shared without reversing dependencies.
2. Implement canonical Vercel and Box identity projections exactly as settled above.
3. Normalize API origins/base URLs consistently with provider configuration parsing.
4. Ensure operational settings do not affect the result.
5. Hydrate the derived identifier into `LocalConfiguredMcpBackend` and local control-plane configuration.
6. Ensure secret values and canonical binding material cannot reach errors or diagnostics.

### Acceptance

- Reordered input object properties produce the same identifier.
- Setup and environment paths produce the same identifier for equivalent provider scope.
- Vercel token rotation preserves the identifier.
- Vercel team, project, or normalized origin changes alter the identifier.
- Box key changes alter the identifier.
- Box base URL changes alter the identifier.
- Auto-stop, polling, and request-timeout changes preserve the identifier.
- No test snapshot, error, or diagnostic contains a provider secret.

## Phase 2: Bound Resource Persistence And Lookup

Status: complete

Prerequisite: Phase 1.

### Scope

Bind every newly registered sandbox and snapshot to the active provider configuration and enforce that binding before provider access.

### Work

1. Add `providerConfigurationId` to sandbox and snapshot records and strict SQLite document validation.
2. Carry the active provider name and configuration ID into `SandboxService` composition.
3. Persist both values during sandbox and snapshot creation.
4. Check both values before every provider-backed direct operation, including source-snapshot restore.
5. Add canonical `provider_configuration_mismatch` error handling through contracts, API, client, and MCP safe rendering as required.
6. Filter sandbox and snapshot repository listings by active provider binding at the repository query boundary so pagination remains correct.
7. Keep direct lookup capable of distinguishing missing Waterbox IDs from registered-but-inactive resources.
8. Do not contact a provider after a binding mismatch.

### Acceptance

- Same provider and binding can operate an existing record.
- Different provider with the same Waterbox ID returns configuration mismatch without provider I/O.
- Same provider with a stale binding returns configuration mismatch without provider I/O.
- Switching back to the exact binding restores access.
- Listings return only active-binding records and preserve cursor pagination.
- Restoring from an inactive-binding snapshot is rejected before create dispatch.
- Public DTOs do not expose `providerConfigurationId`.
- Repository strict-validation and account-isolation tests remain green.

### Prelaunch State Boundary

Existing unpublished records lack a trustworthy provider binding. Do not silently assign them to the currently active configuration. If strict schema evolution makes an old local database unreadable, provide a precise prelaunch reset/cleanup note rather than guessing ownership. Any compatibility requirement must be separately authorized before implementation.

## Phase 3: Provider-Switch Onboarding Safety

Status: complete

Prerequisites: Phases 1-2.

### Scope

Make setup changes explicit and reversible without pretending to manage inactive resources.

### Work

1. Compute the prospective binding after collecting and validating required setup values.
2. When it differs from the current binding, show the settled warning and require explicit confirmation before mutation.
3. Preserve the existing atomic config/keyring rollback discipline.
4. Stop deleting the inactive provider credential.
5. Preserve existing credentials when setup fails or confirmation is declined.
6. Update logout/status wording only as needed to accurately distinguish local credentials/configuration from remote resources.

### Acceptance

- First-time setup does not show a switch warning.
- Operational-setting-only changes do not show a binding-change warning.
- Provider, Vercel team/project, Vercel origin, Box origin, or Box key changes require confirmation.
- Declining confirmation changes neither config nor credentials.
- Successful switching retains the inactive provider credential.
- Setup rollback restores both prior configuration and all prior credentials.
- No output implies remote resources were stopped, deleted, or migrated.

## Phase 4: Provider Workspace Durability

Status: complete

### Scope

Use provider-selected snapshot-durable workspaces and remove the universal `/workspace` promise.

### Work

1. Change the Box runtime profile workspace and persistent workspace to `/home/user/workspace`, unless current provider evidence establishes a better `/home/user` path.
2. Keep Box runtime installation paths outside the workspace where already proven and appropriate.
3. Let shared runtime commands and launchers consume the profile path without provider branches.
4. Replace MCP and launch-document references that promise relative paths start at `/workspace` with provider-neutral workspace wording.
5. Do not rewrite examples that intentionally demonstrate valid absolute paths unless they make a false portability promise.
6. Add provider tests proving generated preparation and launcher commands use the configured workspace.

### Acceptance

- Relative Box operations and default Bash commands start in `/home/user/workspace`.
- Relative Vercel behavior remains unchanged.
- Box snapshot/restore acceptance verifies that a relative workspace marker survives.
- Vercel snapshot/restore acceptance verifies the same invariant.
- MCP tool descriptions contain no universal absolute workspace promise.
- No compatibility symlink is introduced.

## Phase 5: Automatic-Stop Configuration And Snapshot Defaults

Status: complete

Prerequisite: Phase 1, because operational settings must be proven not to affect binding.

### Scope

Add optional operator-controlled automatic stop and remove Waterbox-defined Vercel snapshot retention.

### Work

1. Implement one shared parser for positive whole-minute/hour values.
2. Add optional automatic-stop configuration to persisted setup and environment hydration.
3. Add the setup prompt and settled guidance, allowing blank.
4. Carry a canonical numeric duration into provider configuration without adding it to public create contracts.
5. Map configured duration to Box `ttlSeconds`.
6. Map configured duration to Vercel sandbox session `timeout` in milliseconds.
7. Omit both request properties when configuration is absent.
8. Remove Vercel's hardcoded `snapshotExpiration` and its obsolete rationale comment.
9. Keep provider plan maxima out of validation and documentation.

### Acceptance

- `30m`, `90m`, `2h`, and `24h` parse exactly.
- Invalid units, fractions, compounds, zero, negatives, overflow, and malformed values fail before provider or SQLite side effects.
- Blank setup and absent environment values use provider defaults by omitting request fields.
- Box receives exact whole `ttlSeconds` when configured.
- Vercel receives exact `timeout` milliseconds when configured.
- Vercel create no longer sends `snapshotExpiration`.
- Automatic-stop changes do not alter `providerConfigurationId`.
- Create-sandbox MCP and public API schemas remain unchanged.
- Credential-free provider contract tests assert exact request bodies.

### Live Gate

Run live behavior probes only with separate authorization. Confirm configured durations are accepted within the test plan and result in resumable stopped compute rather than unannounced durable deletion. Record observed provider behavior without generalizing plan-specific maxima.

## Phase 6: Request-Time State Convergence

Status: complete

Prerequisite: Phase 2.

### Scope

Implement operation-aware attempt-then-investigate across existing-reference operations without happy-path preflight latency or automatic retries.

### Work

1. Refine provider error/result types enough to carry canonical known state, exact absence, limits, definite failure, and ambiguity.
2. Preserve redaction and keep provider transport details below adapters.
3. Implement lifecycle-specific handlers for stop, resume, sandbox delete, and snapshot delete.
4. Retain transitional states after ambiguous lifecycle errors instead of writing `failed`.
5. Add one exact inspection after otherwise unhandled provider failure when the operation has an actionable registered provider reference.
6. Wrap async tool event consumption so stream-time provider errors can trigger one state investigation.
7. Apply the same state-learning behavior where appropriate to secure transfer and Bash-job operations.
8. If a tool attempt establishes that a sandbox is stopped, persist `stopped` and surface the first error. A later ordinary tool call may use existing auto-resume behavior.
9. Preserve the original ambiguity for commands, writes, and snapshot mutations even when investigation updates sandbox state.
10. Do not add provider inventory, startup reconciliation, background polling, or mutation retry.

### Acceptance

- Native automatic stop followed by a tool call records `stopped` without retrying the tool.
- A subsequent ordinary tool call resumes through the existing lifecycle and dispatches once.
- Already-stopped stop and already-running resume converge idempotently.
- Ambiguous stop/resume/delete retains an investigable transition.
- Immediate observation of the old state does not incorrectly prove an ambiguous asynchronous mutation failed.
- Exact terminal absence converges to the canonical terminal state where provider semantics make it authoritative.
- Unknown failure plus failed inspection surfaces the original safe failure.
- Ambiguous command/write is never reported as successful based on sandbox status.
- Provider mutation dispatch counts prove no automatic retries.
- Cancellation behavior and redaction remain intact.

### Scope Boundary

This phase applies where an actionable provider reference already exists. It does not invent generic recovery for response-lost Box sandbox creation or response-lost Vercel snapshot creation. Existing provider-local exact create reconciliation remains unchanged unless a separately proven exact identity mechanism is available.

## Phase 7: MCP Stop Sandbox

Status: complete

Prerequisite: Phase 6.

### Scope

Expose semantic early stop to agents that already possess a sandbox ID.

### Work

1. Add `WaterboxClient.stopSandbox` using the existing API stop route.
2. Add MCP `stop_sandbox` with the existing strict sandbox-ID input schema.
3. Describe stop as ending current compute while preserving resumable sandbox state, subject to provider behavior.
4. Preserve safe error rendering and cancellation.
5. Update supported MCP tool documentation.

### Acceptance

- Client tests cover request method, path, response validation, cancellation, and API errors.
- MCP tests cover declaration, dispatch, invalid input, success, and safe errors.
- `stop_sandbox` appears in the tool catalog.
- `resume_sandbox` and `list_sandboxes` do not appear.
- `delete_sandbox` remains clearly permanent and distinct.

## Phase 8: Atomic Collision-Safe Allocation

Status: complete

### Scope

Correct allocation before expanding and changing the human-readable namespace.

### Work

1. Add a repository transaction/port that atomically reserves an idempotent sandbox creation and its sandbox row.
2. Return explicit outcomes for newly reserved, existing matching idempotency reservation, request mismatch, and generated-ID collision.
3. Add bounded candidate regeneration on collision before provider dispatch.
4. Repair the crash gap between idempotency reservation and sandbox insertion.
5. Keep non-idempotent sandbox allocation collision-safe.
6. Add bounded snapshot ID insertion retries.
7. Preserve account scoping and optimistic concurrency for later lifecycle updates.
8. Do not use provider calls inside repository transactions.

### Acceptance

- First candidate collision and second candidate success dispatch provider create exactly once with the second ID.
- A collision never causes an idempotency key to resolve to an unrelated sandbox.
- Concurrent same-key callers converge on one sandbox and one provider dispatch.
- Same key with a different request remains an idempotency conflict.
- Process reconstruction finds both reservation and sandbox; no reservation-only crash window remains.
- Retry exhaustion performs no provider mutation and returns a safe allocation failure.
- Snapshot collisions regenerate before insertion; once inserted, a snapshot ID remains stable.
- Cross-account reuse of the same Waterbox ID remains valid.

### Existing Idempotency Expiration

The currently persisted 24-hour `expiresAt` is not enforced. This plan does not authorize silently reusing or deleting expired idempotency records. If the new atomic port must touch this behavior, either enforce the existing contract with focused tests or remove the inert expiration field in the same phase; document the chosen behavior in the implementation log.

## Phase 9: Friendly Words IDs

Status: complete

Prerequisite: Phase 8.

### Scope

Vendor the corpus and replace the current small-word-plus-suffix generator.

### Work

1. Vendor the exact upstream predicate and object data from the pinned Friendly Words revision.
2. Preserve the upstream words without subjective filtering.
3. Add the MIT attribution and pinned revision to `THIRD_PARTY_NOTICES.md`.
4. Keep vendored data buildable and included in the installed artifact without a runtime npm dependency.
5. Extract the readable-ID generator from composition-heavy code if needed for focused tests.
6. Implement unbiased uniform index selection, such as rejection sampling over random unsigned integers.
7. Generate exactly predicate-predicate-object for sandboxes and snapshots.
8. Remove the opaque suffix and obsolete six-word corpora.
9. Use the bounded allocation behavior from Phase 8.

### Acceptance

- Generated sandbox and snapshot IDs satisfy existing public schemas.
- IDs contain exactly three corpus words after their resource prefix.
- Sampling code has no modulo bias.
- Vendored-list tests verify expected counts, uniqueness, lowercase ASCII, and pinned file hashes.
- Longest supported words remain within Waterbox, Box snapshot-name, and Vercel sandbox-name handling.
- Vercel deterministic native naming and Box snapshot naming remain collision-safe after truncation/hashing.
- No Friendly Words npm dependency is added.
- Package/tarball tests prove required vendored data is present or bundled.

## Phase 10: Documentation And Full Verification

Status: complete

Prerequisites: Phases 1-9.

### Scope

Close cross-cutting documentation, regression, and launch verification for this plan only.

### Work

1. Document registered-resources-only behavior.
2. Document provider switching, inactive bindings, retained credentials, and remote-cost warning.
3. Document provider-controlled snapshot retention and possible expiration.
4. Document optional automatic stop and its non-guaranteed provider enforcement.
5. Document generic sandbox workspace semantics.
6. Document `stop_sandbox` and the absence of sandbox enumeration.
7. Update relevant launch-plan status references without rewriting unrelated launch phases.
8. Run complete credential-free verification.
9. Run separately authorized provider live gates if approval and credentials are supplied.

### Acceptance

- Documentation makes no universal `/workspace`, snapshot-retention, or automatic-stop enforcement promise.
- Documentation never implies provider switching cleans resources.
- All package tests and typechecks pass.
- `git diff --check` passes.
- Installed-artifact verification includes the readable-name corpus and notices.
- Live-gate results, if authorized, include exact cleanup reconciliation.

## Cross-Phase Invariants

Every phase must preserve these invariants:

1. Provider credentials never enter model-visible arguments, content, ordinary logs, SQLite resource records, or public errors.
2. A provider reference is used only with the exact provider binding that created it.
3. Provider inventory never becomes an ownership source.
4. Provider mutations are never blindly retried after uncertain dispatch.
5. A successful provider result is checkpointed before dependent preparation or cleanup work.
6. Public Waterbox IDs remain account-scoped handles, not secrets.
7. SQLite uniqueness and repository transactions, not random entropy, establish allocation correctness.
8. Provider-specific transport behavior remains below the provider boundary.
9. Stable local status is observational cache; workflow transitions remain Waterbox-owned.
10. No phase introduces proactive background processes into the embedded local pipeline.

## Verification Matrix

At minimum, the completed plan must cover:

| Area | Credential-free verification | Live verification when separately authorized |
| --- | --- | --- |
| Binding derivation | Canonical unit vectors, secret-redaction tests | Not required |
| Binding enforcement | Core/repository/API/client tests with provider spies | Switch away/back without wrong-provider calls |
| Onboarding | Keyring/storage fakes, decline and rollback tests | Native keyring smoke where supported |
| Workspace | Runtime/profile/provider request tests | Relative marker survives snapshot/restore on Box and Vercel |
| Automatic stop | Parser and exact provider request-body tests | Stop occurs and sandbox remains resumable |
| Snapshot defaults | Exact Vercel request-body tests | Not required; omission is the asserted behavior |
| Reconciliation | Fault-injected provider/core tests and dispatch counts | Provider auto-stop learned on request |
| MCP stop | Client and in-memory MCP tests | Stop then ordinary-tool resume smoke |
| Allocation | Repository transaction, collision, crash-window, concurrency tests | Not required |
| Friendly IDs | Corpus integrity, format, length, package tests | One create per provider naturally exercises names |

## Implementation Log

Append entries in this format when a phase is completed:

```text
### YYYY-MM-DD - Phase N

- Implemented: concise factual summary.
- Verification: exact commands and outcomes.
- Live evidence: not run, or authorization/scope/result/cleanup facts.
- Deviations: none, or exact approved/blocking difference.
```

Do not mark a phase complete based on intent or partial implementation.

### 2026-09-02 - Phase 1

- Implemented: added a validated internal provider-configuration ID, canonical SHA-256 binding derivation for Box and Vercel, normalized local composition inputs, and binding hydration through MCP and local API composition.
- Verification: `bun test apps/api-local/test/integration.test.ts packages/control-plane-local/test/control-plane-local.test.ts packages/mcp/test/config.test.ts` passed (26 tests); `bun run typecheck` passed; `bun test` passed (506 tests); `git diff --check` passed.
- Live evidence: not run; no live provider mutation is authorized for this phase.
- Deviations: none.

### 2026-09-02 - Phase 2

- Implemented: bound every new sandbox and snapshot to the active provider name and configuration ID; made SQLite records strict about that binding; filtered repository pages by active binding before cursor pagination; and rejected inactive direct resources, including restore source snapshots, before provider access. Added the safe `provider_configuration_mismatch` contract/API rendering without exposing bindings publicly.
- Verification: focused regression tests passed (65 tests); `bun test` passed (512 tests); `bun run test:node-sqlite` passed; `bun run typecheck` passed after restoring the frozen workspace dependencies; `git diff --check` passed.
- Live evidence: not run; no live provider mutation is authorized for this phase.
- Deviations: none.

### 2026-09-02 - Phase 3

- Implemented: setup now accepts validated, canonical Box API base URLs and Vercel API origins; derives prospective and current provider bindings through the shared Phase 1 path; requires explicit confirmation before a resource-scope change; retains inactive-provider credentials; and preserves prior local configuration and both credentials on decline or failure. Logout/status wording now distinguishes local credentials/configuration from remote resources and SQLite records.
- Verification: `bun test packages/mcp/test/onboarding.test.ts packages/mcp/test/config.test.ts packages/control-plane-local/test/control-plane-local.test.ts` passed (38 tests); `bun run typecheck` passed; `bun test` passed (517 tests); `bun run test:node-sqlite` passed; `git diff --check` passed.
- Live evidence: not run; no live provider mutation is authorized for this phase.
- Deviations: none.

### 2026-09-02 - Phase 4

- Implemented: moved Box's provider runtime profile and template launcher workspace to `/home/user/workspace` while retaining Box runtime installation paths under `/usr/local`; kept the shared runtime profile-driven; updated the authorized Box snapshot marker flow; and replaced MCP and launch-document universal workspace claims with provider-neutral semantics. Vercel retains `/workspace`.
- Verification: `bun test packages/sandbox-provider-runtime/test/runtime.test.ts packages/sandbox-provider-box/test/provider.test.ts packages/sandbox-provider-vercel/test/infrastructure.test.ts packages/mcp/test/server.test.ts scripts/build-box-system-template.test.ts scripts/box-capability-probe.test.ts scripts/control-plane-box-smoke.test.ts` passed (95 tests); `bun run typecheck` passed; `bun test` passed (517 tests); `bun run test:node-sqlite` passed; `git diff --check` passed.
- Live evidence: not run; no live provider mutation is authorized for this phase.
- Deviations: none.

### 2026-09-02 - Phase 5

- Implemented: added strict shared `WATERBOX_AUTO_STOP` parsing and optional persisted setup/environment hydration; carried canonical milliseconds only through provider configuration; mapped configured values to Box `ttlSeconds` and Vercel session `timeout`; and removed the Waterbox-defined Vercel `snapshotExpiration` override.
- Verification: `bun test packages/control-plane-local/test/control-plane-local.test.ts packages/mcp/test/onboarding.test.ts packages/sandbox-provider-box/test/provider.test.ts packages/sandbox-provider-vercel/test/infrastructure.test.ts` passed (85 tests); `bun test` passed (522 tests); `bun run test:node-sqlite` passed; `bun run typecheck` passed; `git diff --check` passed.
- Live evidence: not run; this phase prohibits provider mutation absent separate authorization.
- Deviations: none.

### 2026-09-02 - Phase 6

- Implemented: added a redacted provider-known-observation boundary; made stop, resume, sandbox delete, and snapshot delete converge known/exact outcomes while preserving uncertain workflow checkpoints; and added one bounded state inspection for failed existing-resource operations. Definite pre-dispatch rejections restore their prior stable checkpoint while still surfacing the canonical error. Tool streams, secure transfer, and Bash-job failures now learn exact sandbox state without replaying the original operation.
- Verification: `bun test packages/sandbox-core/test/service.test.ts` passed (71 tests); `bun run typecheck` passed; `bun test` passed (528 tests); `bun run test:node-sqlite` passed; `git diff --check` passed.
- Live evidence: not run; no live provider mutation is authorized for this phase.
- Deviations: none.

### 2026-09-02 - Phase 7

- Implemented: added the canonical client `stopSandbox` request and exposed MCP `stop_sandbox` with the existing strict sandbox-ID schema. The model-visible description distinguishes a provider-dependent resumable compute stop from permanent sandbox deletion; no list or explicit resume tool was added.
- Verification: `bun test packages/client/test/client.test.ts packages/mcp/test/server.test.ts` passed (41 tests); `bun run typecheck` passed; `bun test` passed (530 tests); `bun run test:node-sqlite` passed; `git diff --check` passed.
- Live evidence: not run; no live provider mutation is authorized for this phase.
- Deviations: none.

### 2026-09-02 - Phase 8

- Implemented: added a SQLite transaction-backed sandbox-creation reservation that owns an optional idempotency record and sandbox row together, with explicit new, matching, request-mismatch, and candidate-collision outcomes. Sandbox and snapshot allocation now regenerate candidates within a bounded pre-dispatch loop, preserving an accepted row ID through creation and recovery. Removed the previously inert idempotency `expiresAt` field rather than silently reusing or deleting expired records; unpublished old local state is intentionally subject to the existing prelaunch reset boundary.
- Verification: `bun test packages/sandbox-core/test/service.test.ts packages/sandbox-repository-sqlite/test/repositories.test.ts` passed (101 tests); `bun run typecheck` passed; `bun run test:node-sqlite` passed; `bun test` passed (538 tests); `git diff --check` passed.
- Live evidence: not run; this phase authorizes no live provider mutation.
- Deviations: none.

### 2026-09-02 - Phase 9

- Implemented: vendored the exact Glitch Friendly Words predicate and object lists from commit `f94b4639c71c26875f7684fa86a214c7f30deaad`; replaced the small-word-plus-suffix generator with `predicate-predicate-object` IDs selected with uint32 rejection sampling; and retained Phase 8's bounded repository allocation as the collision authority. Added root and MCP-package MIT notices, bundled the corpus into the MCP artifact, and added a release verifier for the bundle and tarball contents.
- Verification: `bun test packages/control-plane-local/test/friendly-words.test.ts packages/sandbox-provider-box/test/provider.test.ts packages/sandbox-provider-vercel/test/infrastructure.test.ts` passed (55 tests); `bun test` passed (544 tests); `bun run test:node-sqlite` passed; `bun run typecheck` passed; `bun run build:mcp && bun run scripts/verify-mcp-package.ts` passed; `git diff --check` passed.
- Live evidence: not run; this phase has no live-provider behavior to exercise.
- Deviations: none.

### 2026-09-02 - Phase 10

- Implemented: documented registered-resource ownership, inactive provider bindings and retained credentials, no-cleanup remote-cost warning, provider-controlled snapshot retention, optional non-guaranteed automatic stop, provider-selected workspaces, and MCP stop-only lifecycle visibility in the supported MCP README. Updated this plan's status only.
- Verification: `bun run check:release` passed: `bun run typecheck`, `bun test` (544 passed), `bun run test:node-sqlite` (1 passed), merge-base/worktree/index diff checks, MCP build, and installed-artifact/tarball verification for the Friendly Words corpus and notices. A final `git diff --check` passed.
- Live evidence: no live calls ran. `BOX_API_KEY`, `BOX_API_BASE_URL`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `WATERBOX_PROVIDER`, and `WATERBOX_AUTO_STOP` were absent, and the supported `/root` persisted configuration/keyring lookup reported `configured:false`; no scoped provider account or project was available for safe mutation or cleanup reconciliation.
- Deviations: none.

### 2026-09-03 - Issue #9 item 1 remediation

- Implemented: added an exact startup schema boundary for the three SQLite repository tables. Fresh and current databases open normally; empty and populated pre-polish databases fail closed before repositories are exposed, preserve the legacy file unchanged, and report the exact database path with guidance to clean remote resources using the prior build and provider configuration before moving, removing, or resetting the local database. No legacy document or provider reference is read into a repository.
- Verification: `bun test packages/sandbox-repository-sqlite/test/repositories.test.ts` passed (30 tests); `bun run test:node-sqlite` passed (1 test); `bun run typecheck` passed; `bun test` passed (547 tests); `git diff --check` passed.
- Live evidence: not run; this remediation performs no provider access and authorizes no live provider mutation.
- Deviations: automatic recreation of an empty pre-polish database was not implemented; it fails unchanged with the same safe guidance as a populated incompatible database.

### 2026-09-03 - Issue #9 item 2 remediation

- Implemented: made the atomic sandbox-creation repository a mandatory `SandboxService` dependency and removed the split sandbox/idempotency write fallback. Every production and test composition now supplies an atomic implementation: durable local composition uses the SQLite transaction-backed repository, while isolated tests use the serialized in-memory repository. Added a two-service concurrency regression over shared repositories and one shared allocation port that proves one sandbox row, one matching idempotency reservation, and one provider create dispatch while provider I/O remains outside the reservation boundary.
- Verification: the focused core/API/control-plane/Box/Vercel composition suite passed (190 tests); the two-service allocation race passed 20 repeated runs; the focused SQLite repository suite passed (30 tests); `bun run typecheck` passed; `bun run test:node-sqlite` passed (1 test); `bun test` passed (547 tests); `git diff --check` passed.
- Live evidence: not run; this remediation performs no provider access and authorizes no live provider mutation.
- Deviations: none.

### 2026-09-03 - Issue #9 items 3-4 remediation

- Implemented: converged authoritative terminal absence from stopping, resuming, and terminating checkpoints; unified known and inspected lifecycle observations behind one operation-specific decision path; and defined `failure` and `limit` as the only provider error kinds that restore an exactly confirmed prior state. Stop treats terminal absence as satisfying its no-running-compute result, resume persists absence while surfacing the original canonical error, and delete remains terminal and idempotent. Definite limits restore stop, resume, sandbox-delete, and snapshot-delete checkpoints; ambiguous old-state observations retain their transitions without redispatch.
- Verification: `bun test packages/sandbox-core/test/service.test.ts` passed (77 tests); `bun run typecheck` passed; `bun run test:node-sqlite` passed (1 test); `bun test` passed (550 tests); `git diff --check` passed.
- Live evidence: not run; this remediation performs no live provider access and authorizes no live provider mutation.
- Deviations: none.

### 2026-09-03 - Issue #9 item 5 remediation

- Implemented: removed cached-target success from explicit sandbox stop and resume. Each explicit request now claims its transition from either relevant stable checkpoint, retains the exact claimed prior state for items 3-4 recovery policy, and dispatches the requested provider mutation once. Canonical already-stopped and already-running provider observations remain idempotent. Ordinary tool execution continues to trust an observed running checkpoint optimistically and learns provider-side stopping only after its single failed operation, without an eager resume or mutation replay.
- Verification: `bun test packages/sandbox-core/test/service.test.ts` passed (78 tests); `bun run typecheck` passed; `bun run test:node-sqlite` passed (1 test); `bun test` passed (551 tests); `git diff --check` passed.
- Live evidence: not run; this remediation performs no live provider access and authorizes no live provider mutation.
- Deviations: none.

### 2026-09-03 - Issue #9 items 6-7 remediation

- Implemented: bumped newly written setup configuration to version 2 and persisted the non-secret `providerConfigurationId` solely as provider-switch warning metadata. Setup compares the prospective binding to that metadata even when the prior credential is missing, while runtime hydration continues to derive its active binding from the validated provider identity values and exact credential bytes. Version 1 remains readable for the narrow setup transition: Vercel scope can be established without its excluded token, Box uses an available valid prior key, and setup warns conservatively when the prior binding cannot be established. Operational-only changes with a proven unchanged binding do not warn. Inactive credentials remain retained, decline remains side-effect free, and an attempted configuration write is now rollback-eligible before it executes so a commit-then-throw result restores the prior configuration and both credentials.
- Credential boundary: setup prompts, native keyring hydration/storage, environment parsing, direct binding derivation, and composed runtime configuration share exact-byte validation. Non-empty credentials with leading or trailing whitespace are rejected rather than trimmed, before keyring mutation, SQLite creation, or provider construction; accepted bytes are preserved unchanged and failures remain secret-free.
- Verification: `bun test packages/mcp/test packages/control-plane-local/test` passed (85 tests); `bun run typecheck` passed; `bun run test:node-sqlite` passed (1 test); `bun test` passed (557 tests); `git diff --check` passed.
- Live evidence: not run; this remediation performs no live provider access and authorizes no live provider mutation.
- Deviations: none.
