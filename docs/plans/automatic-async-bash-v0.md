# Automatic Async Bash V0 Master Plan

Status: complete; Phases 1, 2, 3, and 4 complete

This is the durable implementation plan for automatic asynchronous Bash execution in Waterbox. It is deliberately small. The feature is a detached process with file-backed output and a receipt, not a job service.

Waterbox is prelaunch. Protocol V2 and `waterbox-system-v6` replace protocol V1 and `waterbox-system-v5` directly. Do not add compatibility parsing, migrations, staged rollout logic, or V5 preservation machinery.

## How To Use This Plan

An implementation agent assigned a phase must:

1. Read this entire plan and the assigned phase.
2. Inspect the current worktree and preserve unrelated changes.
3. Implement only the assigned phase.
4. Run the phase verification and repository-wide tests/typecheck where applicable.
5. Update the phase status and implementation log.
6. Stop at the phase boundary.

If a settled requirement is impossible, report the blocker instead of adding a daemon, queue, poller, retry system, or compatibility layer.

## Goal

When a caller signals that a Bash command may run for a long time by supplying an explicit timeout above 15 seconds, Waterbox starts a detached worker and immediately returns the files the LLM can poll.

```text
timeout omitted        -> run synchronously
timeout <= 15_000 ms   -> run synchronously
timeout > 15_000 ms    -> spawn detached worker and return a receipt
```

The LLM handles orchestration. `statusPath` reports state and `outputPath` receives output continuously; the LLM uses those capabilities reasonably while avoiding context pollution from repeatedly reading duplicate output. Waterbox does not poll on its behalf.

## Non-Goals

Do not add:

- A daemon or resident supervisor.
- A queue or scheduler.
- SQS or an SQS-like abstraction.
- A job database or repository records.
- Provider-side polling.
- API job routes.
- MCP job tools.
- Retry or deduplication.
- Automatic cleanup or retention.
- Output rotation or Waterbox-managed size limits.
- Hidden-worker support in the old daemon or legacy receiver.
- Guarantees that intentionally daemonized/escaped descendants remain supervised.

Each async command gets one short-lived parent worker. The worker exits when its direct Bash child settles.

## Semantics

### Selection

The explicit `timeout` value selects behavior before execution:

| Input | Behavior |
|---|---|
| omitted | synchronous, preserving current behavior |
| `15_000` | synchronous |
| `15_001` | detached |
| `2_147_483_647` | detached |
| invalid, zero, fractional, or above maximum | rejected |

Waterbox does not predict command duration. The caller communicates that expectation through the timeout it chooses.

A command selected for detached execution remains detached even if it finishes immediately.

### Terminal Result

Bash has two terminal result variants, discriminated by top-level `outcome`.

Completed:

```json
{
  "type": "result",
  "outcome": "completed",
  "title": "Bash command",
  "output": "...",
  "metadata": {
    "command": "...",
    "workdir": ".",
    "exitCode": 0,
    "signal": null,
    "timedOut": false,
    "aborted": false,
    "durationMs": 1200,
    "outputTruncated": false
  }
}
```

Dispatched:

```json
{
  "type": "result",
  "outcome": "dispatched",
  "title": "Bash command dispatched",
  "output": "Command dispatched. statusPath reports execution state, and outputPath receives output continuously. Repeated output reads can duplicate tokens and pollute context.",
  "metadata": {
    "command": "...",
    "workdir": ".",
    "timeout": 120000,
    "jobId": "job_0123456789abcdef0123456789abcdef",
    "outputPath": "/run/waterbox/bash-jobs/job_0123456789abcdef0123456789abcdef/output.log",
    "statusPath": "/run/waterbox/bash-jobs/job_0123456789abcdef0123456789abcdef/status.json"
  }
}
```

Rules:

- Keep one public `bash` tool.
- Synchronous Bash continues streaming stdout/stderr before its completed result.
- Detached Bash returns one dispatched terminal result through the original invocation.
- A dispatched result declares success only in spawning the detached worker process and assigning its files.
- It does not promise that Bash subsequently starts, runs successfully, or finishes successfully.
- Subsequent startup or execution failure is written to `statusPath`.
- Consumers forward the result. They do not wait for detached completion.

### What Each Layer Knows

Only two components apply semantics:

- The one-shot CLI opts into async selection and calls shared runtime worker helpers to create the receipt.
- The LLM interprets the receipt and decides when to poll.

Other layers are proxies:

- Contracts validate either result shape.
- Box parses and forwards one canonical terminal event.
- Core forwards provider events unchanged.
- HTTP API serializes the event unchanged.
- MCP returns terminal output/metadata to the model.

MCP has one small exception: existing completed Bash failures still set `isError`, while a dispatched receipt is successful. MCP does not poll or interpret job status.

## Files And Worker

### Layout

Production root:

```text
/run/waterbox/bash-jobs
```

Per job:

```text
/run/waterbox/bash-jobs/<jobId>/
  request.json
  output.log
  status.json
```

Use `job_` plus 32 lowercase hexadecimal characters generated from 16 random bytes.

Modes:

- Root and job directory: `0700`.
- Files: `0600`.

These modes avoid accidental disclosure. They are not a security boundary against the root agent that owns the sandbox.

### Dispatch

For `timeout > 15_000`, the one-shot CLI calls the runtime's async dispatch helper:

1. Validates arguments and resolves `workdir`.
2. Creates the job directory.
3. Creates `output.log`.
4. Writes private `request.json` containing command, resolved workdir, timeout, and optional description.
5. Writes initial `status.json` with `state: "starting"` using temp-file-plus-rename.
6. Spawns the same CLI artifact in detached internal-worker mode:

   ```text
   /usr/local/bin/bun /usr/local/lib/waterbox-cli.js __internal-bash-worker <jobId>
   ```

7. Waits only for the operating-system child `spawn` event.
8. Calls `unref()` and returns the dispatched receipt.

There is no READY/COMMIT handshake. Successful dispatch means the detached worker executable was spawned. If the worker starts and then immediately fails, the receipt remains valid and the LLM observes failure or stale state through `statusPath`.

If the worker executable cannot be spawned, the invocation returns an ordinary tool failure and removes the incomplete job directory best-effort.

### Worker

The internal worker uses a shared runtime worker helper:

1. Validates the generated job ID and derives all paths from the fixed root.
2. Reads and validates `request.json`.
3. Opens `output.log` for append.
4. Spawns `bash -lc <command>` with:
   - resolved cwd;
   - inherited environment;
   - ignored stdin;
   - stdout and stderr attached directly to the output file;
   - its own process group.
5. Replaces status with `state: "running"`.
6. Deletes `request.json` after Bash starts.
7. Enforces the original timeout.
8. Waits for the direct Bash child.
9. Replaces status with `state: "completed"` or `state: "failed"`.
10. Closes files and exits.

If Bash cannot spawn, the worker writes `state: "failed"` when possible and exits.

The internal worker mode is private. It is not a public tool, API route, MCP tool, or advertised CLI command.

### Output

The worker passes the already-open output file descriptor to both Bash stdout and stderr.

- Output is visible from the first byte.
- Output does not flow through the initiating CLI or Box response.
- The initiating invocation may exit while output continues.
- Async output is not subject to the synchronous 1 MiB terminal capture limit.
- Output may grow until the command or sandbox filesystem stops it.
- stdout/stderr ordering follows writes to the shared file descriptor; no stronger ordering is promised.

### Status

Status is intentionally simple and internal. It is written as complete JSON to a same-directory temporary file and renamed over `status.json`.

Representative states:

```json
{
  "state": "starting",
  "jobId": "job_...",
  "outputPath": "/run/waterbox/bash-jobs/job_.../output.log",
  "timeout": 120000,
  "createdAt": "..."
}
```

```json
{
  "state": "running",
  "jobId": "job_...",
  "outputPath": "/run/waterbox/bash-jobs/job_.../output.log",
  "timeout": 120000,
  "startedAt": "..."
}
```

```json
{
  "state": "completed",
  "jobId": "job_...",
  "outputPath": "/run/waterbox/bash-jobs/job_.../output.log",
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "durationMs": 42000,
  "finishedAt": "..."
}
```

```json
{
  "state": "failed",
  "jobId": "job_...",
  "outputPath": "/run/waterbox/bash-jobs/job_.../output.log",
  "error": "spawn_failed",
  "finishedAt": "..."
}
```

Do not put command text, environment values, credentials, provider IDs, or serialized invocations in status.

A worker crash may leave `starting` or `running` stale. This is acceptable V0 behavior. There is no recovery service.

### Timeout And Shell Semantics

The original timeout starts when Bash spawns.

At timeout the worker:

1. Marks the eventual result as timed out.
2. Sends `SIGTERM` to the Bash process group.
3. Sends `SIGKILL` after one second.
4. Waits for the direct Bash child and writes terminal status.

The worker follows ordinary shell-parent semantics: it waits for the direct Bash child. A command that deliberately backgrounds, daemonizes, calls `setsid`, or otherwise escapes may continue after Bash and the worker exit. Waterbox does not turn unrestricted Bash into a containment system.

### Cancellation

- Before worker spawn, caller cancellation aborts dispatch and removes incomplete files best-effort.
- After worker spawn, the detached worker is no longer owned by the request or runtime shutdown.
- If the response is lost after worker spawn, the job may run without the caller receiving its receipt. That is an accepted ambiguous execution outcome.
- Waterbox never retries the command.

## Greenfield Versioning

- Set `CLI_PROTOCOL_VERSION` to `2`.
- Encode canonical tool invocations with `j2.` and reject `j1.`.
- Secure-transfer `t1.` framing is a separate unchanged format and does not need an unrelated version bump.
- Use `waterbox-system-v6` as the only active template default.
- Do not parse V1 CLI errors/results as compatible.
- Do not preserve V5 template metadata or live resources after V6 is verified.

## Phase 1: Receipt, Worker, And CLI

Status: complete

### Goal

Implement the complete feature locally at its true semantic boundary: canonical Bash result, synchronous threshold, detached worker, files, timeout, and one-shot CLI receipt.

### Owned Files

- `packages/sandbox-contracts/src/tools.ts`
- Contract tests for Bash results/arguments
- `packages/sandbox-runtime/src/runtime.ts`
- `packages/sandbox-runtime/src/index.ts`
- New `packages/sandbox-runtime/src/async-bash.ts` if useful
- Runtime Bash tests
- `packages/sandbox-cli/src/protocol.ts`
- `packages/sandbox-cli/src/index.ts`
- `packages/sandbox-cli/src/main.ts`
- `packages/sandbox-cli/test/cli.test.ts`
- Runtime/CLI README sections directly describing Bash

### Tasks

1. Add strict completed/dispatched Bash result variants.
2. Add `outcome: "completed"` to synchronous results without changing streaming behavior.
3. Add async dispatch selection at explicit timeout above 15,000.
4. Implement job directory, request, output, and status handling.
5. Implement the hidden CLI worker mode.
6. Return after the detached worker process emits `spawn`; add no readiness handshake.
7. Implement direct file-backed stdout/stderr.
8. Implement timeout TERM-to-KILL behavior.
9. Change CLI invocation protocol to V2/`j2` only.
10. Keep secure-transfer framing unchanged.

Async selection is a one-shot CLI opt-in, not a default behavior change in `createRuntime`. The canonical daemon and legacy receiver continue using synchronous runtime execution and require no hidden worker entrypoint.

### Tests

- Omitted timeout is synchronous.
- 15,000 is synchronous.
- 15,001 is dispatched.
- A fast command with 15,001 still returns dispatched.
- Dispatch returns before a long command completes.
- Worker-spawn failure returns failure rather than a receipt.
- Bash-spawn failure appears in status after a valid receipt.
- Output exists immediately and grows after the initiating CLI exits.
- stdout and stderr both reach the same file.
- Status moves from starting to running to completed/failed.
- Status reads never observe partial JSON.
- Timeout kills the Bash process group with TERM then KILL.
- Caller/runtime shutdown after worker spawn does not stop the worker.
- Command text is absent from worker argv and status.
- V2/`j2` round-trips; V1/`j1` is rejected.

### Acceptance

- Focused tests pass.
- Repository typecheck passes or only downstream fixture failures explicitly owned by Phase 2 remain.
- No daemon, poller, queue, repository, or public job operation was added.

## Phase 2: Proxy Propagation

Status: complete

Depends on: Phase 1

### Goal

Make existing proxy layers accept and forward the new terminal variant with the smallest possible changes.

### Owned Files

- `packages/sandbox-core` Bash types, fixtures, and tests
- `packages/sandbox-provider-box/src/index.ts`
- Box provider tests and README
- `packages/sandbox-api` fixtures/tests and OpenAPI example only as required
- `packages/mcp/src/server.ts`
- Supported MCP tests
- Experimental MCP parser/tests
- Daemon/receiver fixtures only where the new completed result requires `outcome`

### Tasks

1. Remove Box's `580_000` timeout rejection.
2. Parse V2 CLI errors/results only.
3. Let Box yield either canonical terminal result unchanged.
4. Keep exactly one Box `/commands` request and no polling/retry.
5. Let core and API forward either result unchanged.
6. Let MCP return either terminal result to the LLM.
7. Preserve MCP `isError` for failed completed commands; treat dispatched as success.
8. Keep the Bash tool description limited to capability and location; put receipt-file guidance in the dispatched receipt.
9. Do not add hidden workers to daemon/receiver. They remain outside the immediate Box one-shot path.

### Tests

- Box accepts a dispatched result for timeout above 580,000.
- Box makes one request and performs no status reads.
- V1 response is invalid/ambiguous with no fallback.
- Core/API forward dispatched unchanged.
- MCP returns receipt paths and does not mark dispatch as an error.
- Completed nonzero/timeout/abort retains existing MCP error behavior.
- Tool discovery still exposes one Bash tool and no job tool.

### Acceptance

- Proxy changes are schema/fixture propagation, not orchestration.
- No layer other than the CLI/runtime starts, polls, stores, or reconciles jobs.
- Repository tests and typecheck pass.

## Phase 3: V6 Template, Defaults, And Documentation

Status: complete

Depends on: Phases 1 and 2

### Goal

Install the new CLI artifact and job root in the sole active Box template, update defaults, and document the LLM-facing behavior.

### Owned Files

- `scripts/build-box-system-template.ts`
- Template builder tests
- `packages/mcp/src/config.ts`
- MCP config tests and `server.json`
- `packages/mcp/README.md`
- `docs/box-system-template.md`
- `apps/api-local/README.md`
- Active smoke scripts and tests
- Root package scripts only if required
- Ignored `.waterbox/box-system-template.json` local metadata state

### Tasks

1. Change active template references to `waterbox-system-v6`.
2. Set template metadata to CLI protocol V2.
3. Create `/run/waterbox/bash-jobs` with mode `0700` in the launcher.
4. Configure the CLI worker to re-exec `/usr/local/bin/bun /usr/local/lib/waterbox-cli.js` directly.
5. Validate built CLI health/version reports V2.
6. Update active documentation and examples.
7. Explain that the receipt is dispatch success, not command success.
8. Explain that the LLM polls with existing `read`; Waterbox has no poller.
9. Do not create live Box resources in this phase.
10. Remove stale ignored V5/V1 local template metadata. Do not synthesize V6 metadata before an authorized successful build; Phase 4 regenerates it.

### Verification

```text
bun test
bun run typecheck
bun run --cwd packages/sandbox-cli build
bun run build:mcp
bun run build:box-template --validate
npm pack --dry-run ./packages/mcp
git diff --check
```

### Acceptance

- V6/V2 are the only active defaults.
- Built artifacts contain the hidden worker path but advertise no new public tool.
- Full local matrix is green.

## Phase 4: Authorized Live Box Verification

Status: complete

Depends on: Phase 3

### Goal

Prove that Box allows the detached worker to survive the one-shot CLI response, then clean the trial account.

### Preconditions

- Explicit live and destructive-cleanup authorization is present.
- `BOX_API_KEY` comes from environment only.
- The account is confirmed as the isolated free-trial account.
- Phase 3 verification is green immediately before mutation.

### Live Sequence

1. Build `waterbox-system-v6`.
2. Verify V2 health/version.
3. Create a V6 Box.
4. Verify omitted timeout and 15,000 complete synchronously.
5. Run a 20-second command with timeout 20,000 and verify dispatch returns promptly.
6. Read output more than once and observe growth after the Box command response.
7. Poll status to terminal completion.
8. Run a timeout case and verify terminal status reports timeout.
9. Run two async commands and verify they use independent files.
10. Exercise the same behavior through Direct MCP.
11. Delete temporary Boxes and snapshots.
12. After V6 succeeds, delete obsolete V5 trial resources when authorized.
13. Reconcile to zero run-owned active/visible Boxes.

### Stop Condition

If Box reaps the detached worker when the one-shot CLI exits, stop and report that provider behavior. Do not respond by inventing a queue, service, or retry system without a new architecture decision.

### Acceptance

- Output continues after the original Box command response.
- Status reaches completed/failed as expected.
- Direct MCP gives the LLM a usable receipt and existing tools can poll it.
- V5 and temporary trial resources are removed when authorized.
- No secrets or serialized invocations appear in retained logs.

## Delegation

Use this prompt for future implementation agents:

```text
Implement Phase N of docs/plans/automatic-async-bash-v0.md.
Read the whole plan, stay within the phase boundary, run its verification,
update phase status and the implementation log, and report changed files and blockers.
```

Phases are sequential. Do not split a phase among agents that would edit the same files.

## Completion Criteria

The feature is complete when:

- One Bash tool uses the omitted/15,000/15,001 split.
- Long explicit timeouts return a dispatched receipt promptly.
- A detached per-command worker writes continuous output and simple status.
- The worker enforces the original timeout and exits after its Bash child.
- The LLM polls using existing tools.
- Proxies only validate/forward and never poll.
- Box performs one request with no retry.
- Protocol V2 and V6 are the only active paths.
- Local and live verification pass.
- No queue, daemon, scheduler, database, or job API exists.

## Implementation Log

- 2026-08-29: Initial exhaustive nine-phase plan was replaced before implementation with this four-phase receipt model. No feature code had been written.
- 2026-08-29: Phase 1 completed. Contracts now define strict completed/dispatched Bash results; synchronous runtime Bash emits `outcome: "completed"`; the one-shot CLI alone selects detached execution above 15,000ms and emits a receipt after the worker process `spawn` event. Shared runtime helpers implement private request/output/status files, atomic status replacement, direct file-backed output, worker timeout escalation, and the hidden CLI worker mode. CLI protocol V2 uses `j2` exclusively while secure-transfer `t1` remains unchanged. Focused contracts/runtime/CLI tests pass (71 tests), the CLI build passes, and `git diff --check` passes. Repository `bun test` has four expected Phase 2-owned failures in Box/MCP fixtures and V1 parsing; `bun run typecheck` has six expected Phase 2-owned MCP narrowing errors for dispatched metadata.
- 2026-08-29: Phase 1 review follow-up fixed post-spawn worker ownership. Timeout accounting now begins immediately at the Bash `spawn` event, before running-status or request-file operations. Any later worker failure terminates and waits for the direct child, escalating the process group from TERM to KILL when necessary, and writes `worker_failed` status when possible. Deterministic regressions cover post-spawn metadata failure, timeout accounting during a delayed status write, nonzero terminal status, and command-text omission from status variants. Focused tests pass (74 tests), the CLI build and `git diff --check` pass, and typecheck remains blocked only by the six documented Phase 2 MCP narrowing errors.
- 2026-08-29: Phase 2 completed. Box now accepts the V2 completed/dispatched terminal union without the former 580,000ms rejection, recognizes only V2 structured CLI errors, and still makes one command request with no tool-result polling or retry. Core and API forwarding regressions preserve dispatched receipts unchanged. Supported and experimental MCP expose one Bash tool with capability/location-only descriptions, return receipt output and paths as success, and retain `isError` for nonzero, timed-out, or aborted completed commands. Focused Phase 2 tests pass (97 tests), the full repository suite passes (288 tests), typecheck passes, and `git diff --check` passes.
- 2026-08-29: Phase 3 completed. The sole active Box template/default is `waterbox-system-v6` with CLI protocol V2 metadata. Its launcher creates `/run/waterbox/bash-jobs` as `0700`, and artifact validation requires the hidden direct `/usr/local/bin/bun /usr/local/lib/waterbox-cli.js` worker re-exec while built `health` and `version` are executed and checked as V2. MCP defaults, active smokes, and documentation now describe receipts as dispatch-only success and direct LLM polling through the existing `read` tool without Waterbox polling. Stale ignored V5/V1 local metadata was removed without generating V6 metadata or creating live Box resources. The complete Phase 3 verification matrix passes.
- 2026-08-29: Phase 4 completed under explicit isolated-account live and destructive-cleanup authorization. The pre-mutation Phase 3 matrix passed, and the trial baseline had zero active/visible Boxes and six named snapshots. All six snapshots, including obsolete V5, were deleted and reconciled before rebuilding V6 from the current protocol-V2 artifact; ignored local metadata was regenerated as schema V2/CLI protocol V2. The authorized Direct MCP smoke verified omitted and 15,000ms synchronous Bash, prompt dispatch above 15,000ms, output growth after the original Box response, successful and timed-out terminal status, two independent detached jobs, receipt polling through the existing `read` tool, all seven sandbox tools, and snapshot lifecycle. The live smoke cleanup was strengthened to wait for provider accounting after issuing a single delete rather than treating delayed active-count convergence as failure. Final account-wide reconciliation found zero visible and active Boxes, zero user snapshots, no V5, and exactly one ready named snapshot: rebuilt `waterbox-system-v6`. No provider IDs or secrets were retained in the plan.
- 2026-08-29: The Direct MCP live gate now rejects stale dispatched guidance unless it explains `statusPath` state, continuous `outputPath` output, and duplicate-token/context-pollution risk without advertising the dispatch threshold or prescribing polling both files.

## Approved Always-Dispatch Follow-Up

Status: implemented locally; verification recorded below

The approved simplification supersedes timeout-based selection without rewriting the
completed V0 history above. Every one-shot CLI/Box Bash invocation creates the existing
private files and detached worker, then waits directly on that worker for an internal
15,000ms yield window. Worker exit returns the existing bounded `completed` result and
removes its job directory best-effort; expiration returns the existing `dispatched` receipt
and preserves the files. There is no file polling, readiness/commit IPC, process handoff,
or new public tool. `timeout` is only an optional worker execution deadline. `createRuntime`,
the daemon, and the legacy receiver retain synchronous streaming. Tests inject a shorter
`yieldAfterMs`; cancellation while waiting unrefs but does not kill the worker, accepting a
lost receipt and preserving files.

- 2026-08-29: The always-dispatch follow-up is implemented. The one-shot CLI now creates a
  worker for every Bash invocation and races direct worker exit against the production
  15,000ms yield window; quick commands return bounded completed results with best-effort
  cleanup, while elapsed-window and canceled calls preserve detached-worker files. Timeout
  omission is retained through requests, status, and receipts, and nonzero or timed-out
  terminal worker states return completed metadata rather than tool failures. Focused tests
  pass (33 tests), the full suite passes (291 tests), typecheck, CLI/MCP builds, template
  validation, and `git diff --check` pass. No live Box resources were mutated.
- 2026-08-29: Review follow-up bounded completed output by the UTF-8 byte length of the
  returned string as well as bytes read from disk. Invalid-byte replacement expansion now
  truncates within 1 MiB and sets `outputTruncated`; a deterministic raw `0x80` regression
  covers the case without unbounded reads. The production yield constant is internal, and
  public documentation now says only that quick commands complete while longer-running
  commands may yield receipts. Focused runtime/CLI tests pass (25 tests), the full suite
  passes (292 tests), and typecheck, CLI/MCP builds, template validation, and diff checking
  pass. No live resources were mutated.
- 2026-08-29: The authorized always-dispatch live phase completed against the isolated Box
  account. The local artifact matrix passed before mutation. The sanitized baseline had one
  active/visible Box, zero user snapshots, no V5, and one ready V6; the Box and immutable V6
  were each deleted once and absence reconciled before V6 was rebuilt from the current
  protocol-V2 CLI. Direct MCP over Box verified quick completed results with explicit and
  omitted execution timeouts, completed-job cleanup, yielded omitted and conservative
  execution-timeout jobs with continuing output/status files, existing-read polling,
  educational receipt guidance, and a completed hard-timeout result. All seven sandbox tools,
  Direct MCP lifecycle tools, secure transfer, concurrency, and temporary snapshot cleanup
  passed. The durable live smoke now asserts these semantics without publishing the internal
  yield duration. Final account-wide reconciliation found zero active/visible Boxes, zero user
  snapshots, no V5, and exactly one ready named snapshot, rebuilt `waterbox-system-v6`.
  Ignored metadata was regenerated as schema V2/CLI protocol V2. No provider identifiers,
  credentials, protected URLs, commands, headers, or serialized invocations were retained.

## Current-Presentation Receipt Absorption

- 2026-08-29: Phase 1 current-presentation absorption supersedes the earlier MCP presentation
  notes without changing CLI protocol V2 or detached execution. Dispatched content remains a
  recovery receipt in CLI/API/core transport, but supported Direct MCP and the experimental
  control-plane MCP privately observe the same `jobId` until terminal and byte-drained, then
  synthesize one completed result. Hidden CLI observation accepts only a validated job ID,
  nonnegative byte offset, and bounded byte count; paths are derived from the fixed job root,
  chunks are Base64, status and receipt paths are correlated, and terminal cleanup is a separate
  best-effort operation. Provider/core only sample and never poll or retry; MCP owns cadence,
  streaming UTF-8 decode, 1 MiB retention, truncation, progress heartbeats, and cancellation
  fallback. Completed Bash text is plain MCP text with canonical metadata in
  `structuredContent`; Phase 2 native-like streaming presentation remains out of scope.
- Normal MCP operation has no elapsed-time fallback and exposes no job tool. Command failure or
  timeout is completed content with `isError`; observation failure/cancellation preserves files
  and returns a non-error receipt when possible. The Direct live smoke now expects a single Bash
  call to absorb slow jobs rather than manually reading receipt paths. No V6 rebuild or live Box
  operation is part of this implementation.
