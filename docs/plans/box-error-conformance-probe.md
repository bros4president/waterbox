# Box Error Conformance Probe

## Purpose

This probe captures operation-specific Box HTTP error envelopes before Waterbox changes any public error mapping. It is research tooling only. It does not call Waterbox, the Box provider, or either MCP implementation, and it must not be used as an account cleanup utility.

The raw artifact is ignored evidence. The sanitized artifact is the only input permitted for a checked-in research report.

## Safety Model

- Live execution requires exact `--run`, `BOX_ERROR_CONFORMANCE_PROBE_AUTHORIZATION=I_UNDERSTAND_THIS_ERROR_PROBE_CREATES_STOPS_RESUMES_SNAPSHOTS_AND_PERMANENTLY_DELETES_BOX_RESOURCES`, `WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT=YES`, and `BOX_API_KEY`.
- Execution is refused under `bun test`. `BOX_API_BASE_URL` must be HTTPS and contain no credentials, query, or fragment.
- Preflight records the complete visible Box ID set and active count. It requires capacity for two active probe Boxes.
- Only valid IDs returned by positively correlated successful run-specific creates are owned. Only unique `waterbox-error-<run>` names are owned. Baseline resources are never lifecycle-mutated, commanded, snapshotted, or deleted.
- Mutations are issued once. The numbered replay and concurrent idempotency cases are intentional independent requests. A response-lost create permits one separately recorded exact same-key/same-body reconciliation request and requires a 2xx response with exactly one Box identity. A non-2xx, another transport loss, a missing identity, or an identity different from an already visible original identity is an unreconciled ownership blocker.
- Concurrent same-key/same-body creates share one reconciliation decision. Any successful concurrent response supplies the identity for every uncertain peer; differing successful identities are fatal. If no peer succeeds and at least one is uncertain, the probe makes at most one separately recorded exact replay and requires its successful identity.
- A transport-uncertain command is never replayed. A transport-uncertain stop, resume, snapshot save/delete, or Box delete must be proven by bounded read-only state/absence checks before another lifecycle mutation. If proof is unavailable, the evidence sequence aborts to cleanup and reporting.
- Permanent deletion always carries `X-Ascii-Confirm-Delete` equal to the exact tracked Box ID. Deletion polling is bounded; target absence is accepted as deletion completion.
- Cleanup deletes only tracked names and IDs. After a transport-uncertain tracked-Box delete, cleanup first inspects and waits boundedly for absence. It issues one new, separately recorded delete with the exact confirmation header only if the Box remains proven present; another uncertainty must reconcile to absence. Unknown Boxes are never deleted.
- Cleanup never attempts to force an empty account. Success requires exact visible Box set equality with the baseline, the active count to equal its baseline, and every tracked Box to be absent. Any unknown extra Box is a blocker.
- Billing failure, organization suspension, quota exhaustion, rate limiting, and provider 5xx induction are documentation-only cases and are never triggered.
- A cleanup blocker fails the run even if all evidence cases completed.

## Evidence

Each capture records the case and operation, HTTP method, abstract path template, mutation status, response status/media type/body kind/top-level shape, `ok`/`type`, bounded lexical codes, inner status/code consistency, message byte length and SHA-256, request-ID presence, ownership correlation, an authored expectation label, and observed certainty.

Raw JSON retains bounded parsed response bodies and non-secret probe request metadata. It never stores the API key, authorization headers, API base URL, process environment, or concrete request URL. Empty and non-JSON bodies are classified but not dumped. JSON is limited to 1 MiB and must be strict UTF-8 JSON.

Sanitization removes response bodies after deriving the schema fields. It replaces Box/deletion IDs, run-scoped names, timestamps, URLs, request IDs, and token-like values with stable placeholders. Raw messages are represented only by byte length and SHA-256. Console output contains aggregate status and artifact paths, never response bodies or resource identities.

Both files are created with mode `0600` under ignored `.waterbox/probes/`:

- `<timestamp>-<run>.raw.json`: sensitive live evidence; never inspect for report writing and never commit.
- `<timestamp>-<run>.sanitized.json`: report input.

## Cases

1. Invalid API key.
2. Inspect nonexistent Box.
3. Stop, resume, and permanently delete a nonexistent Box.
4. Command a nonexistent Box.
5. Invalid command timeout with nonexistent-target precedence preserved as observed.
6. Inspect nonexistent named snapshot.
7. Delete nonexistent named snapshot.
8. Save a named snapshot from a nonexistent Box.
9. Create from a unique nonexistent named snapshot with an idempotency key.
10. Inspect nonexistent deletion operation.
11. Successful keyed create, exact replay, and same-key/different-body request.
12. Best-effort concurrent same-key create. `idempotency_in_progress` is observed if it occurs but is not required.
13. Immediate command after create acceptance.
14. Stop and immediate repeated stop.
15. Resume and immediate repeated resume.
16. Named snapshot save, immediate duplicate, delete while saving, eventual ready inspection, successful delete, and repeated delete. If early deletion succeeds, a separately recorded re-save preserves the eventual-ready portion.
17. Permanent Box deletion, deletion-operation inspection, repeated delete, and deleted-target inspection.

## Local Fault Injection

Credential-free injected-fetch tests simulate server-side execution followed by a lost response. They cover keyed create followed by one exact successful replay and one owned identity, a command loss with no replay, and lost stop/resume/Box-delete/snapshot-save/snapshot-delete responses with a read-only reconciliation capture before any later mutation. They also reject a lost create whose exact replay is non-2xx. These are local fault-injection results, not live evidence.

## Runbook

1. Run credential-free checks: `bun test scripts/box-error-conformance-probe.test.ts`, `bun run typecheck`, and `git diff --check`.
2. Inspect baseline and limits with bounded read-only requests. Do not print IDs or response bodies.
3. Run with bounded timings:

```sh
BOX_ERROR_CONFORMANCE_PROBE_AUTHORIZATION=I_UNDERSTAND_THIS_ERROR_PROBE_CREATES_STOPS_RESUMES_SNAPSHOTS_AND_PERMANENTLY_DELETES_BOX_RESOURCES \
WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT=YES \
BOX_ERROR_PROBE_REQUEST_TIMEOUT_MS=30000 \
BOX_ERROR_PROBE_POLL_INTERVAL_MS=1000 \
BOX_ERROR_PROBE_POLL_TIMEOUT_MS=300000 \
bun run scripts/box-error-conformance-probe.ts --run
```

4. Require `cleanup.complete`, exact-set `baselinePreserved`, `trackedBoxesAbsent`, and `activeCountRestored` to all be true.
5. Read only the `.sanitized.json` artifact to produce the research report. Never print or commit raw evidence.
6. Re-run focused/full tests, typecheck, and `git diff --check`.

If the process is interrupted, do not delete account-wide differences. Use the private raw artifact only for manual emergency identification of exact tracked IDs/names, then apply the same exact confirmation and bounded reconciliation rules.
