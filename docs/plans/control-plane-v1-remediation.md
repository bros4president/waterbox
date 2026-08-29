# Control Plane V1 Remediation

Status: complete

Checkpoint: `857d791eafe11bdf28263dd1d11f0665bfa6be8b`

This plan narrows the draft implementation without changing its provider-neutral architecture. It is the execution record for remediation of PR #1. The stable architecture and final phase statuses remain in [`control-plane-v1.md`](./control-plane-v1.md).

## Stopping Condition

Remediation is done when all approved changes below are integrated, focused and repository-wide verification passes, four independent review lenses have no unresolved concrete findings, and one new remediation commit exists on the PR branch without rewriting the checkpoint commit. No real Box call is part of this stopping condition.

After that point, implementation stops. The next path forward from the remediated core requires a separate decision.

## Preserved Architecture

```text
apps and transports
    -> generic control-plane core
    -> sandbox, snapshot, and idempotency repositories
    -> selected provider
    -> common provider-neutral daemon and runtime
```

Waterbox remains multi-provider. Provider selection, the registry and default, opaque provider references, source-snapshot ownership, account isolation, CAS transitions, create idempotency, automatic resume, cancellation, ambiguous-execution handling, and secret redaction are not simplification targets. Creating a sandbox from a provider snapshot remains the generic fork operation; there is no separate generic fork method.

The V1 runtime remains the canonical seven-tool runtime. The Pi-wrapper decision is deferred. Existing v0 Pi endpoints and `@earendil-works/pi-coding-agent` remain unchanged.

## Approved Work

### Contracts And Core

- Make `createSandbox`, `inspectSandbox`, `deleteSandbox`, and `executeTool` mandatory provider methods.
- Replace capability booleans with cohesive optional `stopResume` and `snapshots` groups represented by presence.
- Rename only V1 `suspendSandbox` to `stopSandbox` and `suspending`/`suspended` to `stopping`/`stopped`, retaining `resumeSandbox` and `resuming`.
- Allow snapshot creation from running or stopped sandboxes.
- Reject unavailable optional operations before IDs, persistence, state transitions, or provider dispatch.
- Keep the canonical snapshot and sandbox state sets, provider registry, provider-owned source snapshots, CAS, account scoping, idempotency, automatic resume, cancellation, ambiguity handling, and redaction.
- Remove the reusable provider-conformance framework, corruption matrices, and provider wrappers that exist only for that framework. Keep direct core and Box tests with simple fakes.

### Repositories

- Remove sandbox and snapshot `conditionalDelete`.
- Remove idempotency `list` and `conditionalDelete`.
- Keep three repositories, versioned records, account-scoped access, sandbox/snapshot keyset listing, CAS, SQLite persistence, and malformed-document validation.
- Replace encrypted cursors and injected keys with strict canonical Base64URL JSON containing only `{ "v": 1, "after": "<resource-id>" }`.
- Never encode account IDs, provider data, or credentials. Every query continues to use the authenticated account independently.

### Runtime And Daemon

- Keep the incremental 1 MiB raw-body limit, fatal UTF-8, JSON and canonical Zod validation, caller and shutdown cancellation, process-group termination, bash NDJSON, atomic writes, and patch preflight. The later agent-owned-sandbox policy intentionally removed workspace containment and symlink rejection.
- Remove exact Content-Length equality and delayed trailing-byte machinery.
- Remove synthetic hostile/non-settling/rejecting reader-cancellation handling and dedicated tests.
- Remove daemon and runtime mutation serialization. Every invocation dispatches independently; operation-local atomic writes remain, and patch reports operations completed before a commit failure rather than attempting rollback across concurrent commands.
- Retain focused overflow, cancellation, all-tool, streaming, process-tree, and concurrent-mutation tests.
- Preserve existing v0 receiver and Pi behavior and their build/test paths.

### Box And Probe

- Keep strict validation at external responses, stored opaque references, lifecycle identifiers, response identity, snapshot source/artifact identity, protected URLs, and lifecycle states.
- Remove redundant reparsing of typed core inputs and unused provider response fields.
- Preserve `noEnv`, secret-free configuration, protected URLs, exact create replay, no blind retries for commands or ambiguous snapshots, permanent deletion confirmation, cancellation, and redaction.
- Delete the unverified Box template builder, its tests, and its root script. Remove implementation claims from the template documentation while retaining Phase F requirements.
- Add a small raw-fetch capability probe independent of the provider and builder. It requires credentials and explicit authorization, never performs live calls under `bun test`, emits sanitized observations, and cleans up best-effort on failure.
- The probe covers limits and zero-data-retention, exact create replay, readiness, a unique marker, running snapshot creation, snapshot restore, stop/archive, resume of the same Box, marker continuity, permanent deletion polling, and snapshot deletion.
- The probe excludes daemon installation, hosting, same-name replacement, forced stop, a fork endpoint, webhooks, snapshot trees/downloads, and artificial failures.
- No live Box call is authorized in this remediation session.

## Phase Status Target

- Phase A: complete.
- Phase B: complete with the narrowed provider contract.
- Phase C: complete with simplified local persistence.
- Phase D: complete with the simplified daemon.
- Phase E: complete with live lifecycle capability calibration.
- Phase F: ready to begin from reviewed live probe observations.
- Phase G: ready to begin against injected fakes.
- Phase H: pending E, F, and G; real Box composition remains gated on calibrated E/F behavior.

## Execution Checklist

- [x] Inspect PR #1, its diff, and the stable architecture plan.
- [x] Check out checkpoint `857d791`.
- [x] Establish baseline: 216 tests pass and typecheck passes after installing the frozen lockfile.
- [x] Record this remediation before source edits.
- [x] Integrate contracts, core, provider contract, focused fakes, and repository changes.
- [x] Integrate runtime, daemon, and v0 compatibility changes.
- [x] Integrate Box validation changes, reset Phase F, and add the gated probe.
- [x] Run focused tests after each area.
- [x] Run full tests, typecheck, diff check, standalone daemon build, v0 receiver tests and bundle check, plugin tests, and Pi MCP tests.
- [x] Confirm no generated binary, credentials, or provider calls.
- [x] Complete independent reviews for core/repositories, runtime/daemon, Box/probe, and overengineering.
- [x] Resolve concrete findings and rerun verification.
- [x] Condense the stable plan implementation log and record final phase statuses and verification facts.
- [x] Prepare one remediation commit without amending or pushing the checkpoint.

## Verification Record

Initial checkpoint verification on 2026-08-27 after `bun install --frozen-lockfile`:

- `bun test`: 216 passed, 0 failed, 1,153 assertions across 19 files.
- `bun run typecheck`: passed.
- No source files were changed before this baseline.

Final post-review verification on 2026-08-27:

- `bun test`: 201 passed, 0 failed, 906 assertions across 18 files.
- `bun run typecheck`: passed.
- Explicit receiver, plugin, and Pi MCP suite: 45 passed, 0 failed, 179 assertions across 8 files.
- `git diff --check`: passed.
- Standalone daemon compilation to an external temporary directory: passed.
- V0 receiver Node bundle and `node --check` in an external temporary directory: passed.
- Four independent review lenses approved after concrete findings were corrected.
- No generated daemon binary remains in the worktree.
- No credentials were loaded and no real Box request was made.

## Post-Remediation Capability Probe

The separately credential-authorized Box capability probe completed on 2026-08-27 with sanitized observations:

- Account capacity and disabled zero-data-retention were confirmed through `/limits` and `/account/data-retention`.
- Exact create replay preserved Box identity; a replay may report the Box's current state rather than `provisioning`.
- File writes may return paths relative to `/home/user`; that directory, unlike `/tmp`, persisted through named snapshot restore.
- Running snapshot creation, snapshot-sourced creation, marker restoration, stop/archive, resume with the same identity, and marker continuity all succeeded.
- Permanent Box deletion was accepted irreversibly but entered `blocked` background status. Both Boxes immediately left listings and active capacity returned to its preflight baseline, so the probe reports `accepted_pending` rather than claiming physical deletion completed.
- The named snapshot was deleted, and final cleanup verification found zero active or visible probe Boxes and no probe snapshot.

Post-probe verification passed 201 tests with 907 assertions, typecheck, and diff checking. Phase F may now be designed from these observations; daemon installation, protected hosting, and template construction remain Phase F work rather than probe claims.
