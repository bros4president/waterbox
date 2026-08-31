# Box Error Conformance, 2026-08-30

## Scope

This report was derived only from the sanitized artifact at `.waterbox/probes/<run>.sanitized.json` and the public documentation cited below. The raw artifact was not inspected for any report conclusion. All identifiers and messages remain redacted; this report contains no Box IDs, deletion IDs, snapshot names, request IDs, raw messages, concrete request URLs, or credentials.

The gated playground run recorded 159 bounded captures, not 159 distinct semantic cases. Many captures are polling and cleanup observations. Every observed JSON error used `application/json`, `ok: false`, `type: box.error`, matching outer/inner codes and HTTP status, a request ID, and a bounded message representation. Cleanup preserved the single visible pre-existing Box, restored the active count from 0 to 0, and verified both run-created Boxes absent.

## Documentation Basis

Retrieved 2026-08-30:

- [Box Public API v1](https://docs.ascii.dev/box/api/v1)
- [Box v1 OpenAPI](https://docs.ascii.dev/openapi/box-v1.yaml)
- [Create box](https://docs.ascii.dev/box/api/reference/boxes/create-box)
- [Get box](https://docs.ascii.dev/box/api/reference/boxes/get-box)
- [Stop and archive box](https://docs.ascii.dev/box/api/reference/boxes/stop-and-archive-box)
- [Resume box](https://docs.ascii.dev/box/api/reference/boxes/resume-box)
- [Permanently delete Box data](https://docs.ascii.dev/box/api/reference/boxes/permanently-delete-box-data)
- [Execute Box command](https://docs.ascii.dev/box/api/reference/agent/execute-box-command)
- [Get deletion operation](https://docs.ascii.dev/box/api/reference/account/get-deletion-operation)
- [Save a named snapshot](https://docs.ascii.dev/box/api/reference/snapshots/save-named-snapshot)
- [Get a named snapshot](https://docs.ascii.dev/box/api/reference/snapshots/get-named-snapshot)
- [Delete a named snapshot](https://docs.ascii.dev/box/api/reference/snapshots/delete-named-snapshot)

Authored probe expectation strings are test labels, not documentation. A behavior is called documented below only when supported by these retrieved sources.

## Evidence Classes

| Case | Evidence | Classification |
| --- | --- | --- |
| Invalid API key | Docs and live `401 unauthorized` | Documented + live-confirmed |
| Missing target Box for get/stop/resume/delete/command | Docs specify 404; live returned `404 not_found` | Documented + live-confirmed; Waterbox treatment remains operation-specific |
| Invalid command timeout | Docs specify `400 invalid_timeout`; live matched | Documented + live-confirmed |
| Missing named snapshot get/delete | Docs specify 404; live returned `404 not_found` | Documented + live-confirmed; deletion absence satisfies the requested terminal state |
| Save named snapshot from missing source Box | Docs specify 404; live returned `404 not_found` | Documented + live-confirmed |
| Missing deletion operation | Docs specify 404; live returned `404 not_found` | Documented + live-confirmed |
| Keyed create and exact same-body replay | Docs promise the same Box; live identities correlated | Documented + live-confirmed |
| Changed-body key reuse | Docs specify `409 idempotency_key_reused`; live matched | Documented + live-confirmed |
| Concurrent early keyed retry | Docs specify `409 idempotency_in_progress`; not observed | Documented only; contract-testable |
| Create from missing named snapshot | Live returned `404 snapshot_not_found`; create docs do not specify 404 or this code for `from` | Live-observed but undocumented |
| Stop while already stopping | Stop docs describe 202 when already in progress; live returned 202 | Documented + live-confirmed |
| Repeated resume | Live returned 202; docs do not promise retry/idempotency behavior | Single-run lifecycle observation |
| Repeated Box delete | Live returned 202; docs do not promise retry/idempotency behavior | Single-run lifecycle observation |
| Duplicate named-snapshot save | Docs and live `409 save_in_progress` | Documented + live-confirmed |
| Delete named snapshot while saving | Docs and live `409 save_in_progress` | Documented + live-confirmed |
| Ready snapshot get/delete | Docs and live successful lifecycle, followed by `404 not_found` on repeated delete | Documented + live-confirmed |
| Rate limiting | Docs include `429 rate_limited`; one concurrent create incidentally returned it | Documented + live-confirmed |
| Command `box_direct_failed` / lost response | Docs say a command may already have executed; injected-fetch test records uncertainty and no replay | Documented + local fault-injection, not live-confirmed |
| Lost keyed-create/lifecycle/snapshot response | Injected-fetch tests cover exact create replay and read-only lifecycle reconciliation | Local fault-injection, not live-confirmed |

The incidental rate-limit observation does not establish thresholds, retry timing, or generic mutation retry safety. No live lost-response experiment occurred.

## Live Lifecycle Detail

| Case | Documentation | Live observation | Scope |
| --- | --- | --- | --- |
| Invalid API key | `401 unauthorized` | `401 unauthorized` | High, direct observation |
| Inspect nonexistent Box | Box-specific not found | `404 not_found` | High |
| Stop nonexistent Box | Box-specific not found | `404 not_found` | High |
| Resume nonexistent Box | Box-specific not found | `404 not_found` | High |
| Delete nonexistent Box | Box-specific not found | `404 not_found` | High |
| Command nonexistent Box | Box-specific not found | `404 not_found` | High |
| Invalid command timeout | Validation error; target lookup precedence unclear | `400 invalid_timeout` even with a nonexistent target | High; validation precedes lookup |
| Inspect nonexistent named snapshot | Snapshot-specific not found | `404 not_found` | High |
| Delete nonexistent named snapshot | Snapshot-specific not found | `404 not_found` | High |
| Save snapshot from nonexistent Box | Box-specific not found | `404 not_found` | High |
| Create from nonexistent named snapshot | No documented 404/code for missing `from` | `404 snapshot_not_found` | Live-undocumented; do not stabilize |
| Inspect nonexistent deletion operation | Deletion-specific not found | `404 not_found` | High |
| Keyed create | `202 box.created` | `202 box.created` | High |
| Same-key/same-body replay | Same Box result | `202 box.created`, correlated to the tracked create | High |
| Same-key/different-body replay | Idempotency conflict | `409 idempotency_key_reused` | High |
| Concurrent same-key create | Same identity or documented `idempotency_in_progress` | One `202 box.created`; one incidental `429 rate_limited` | `idempotency_in_progress` remains documented-only |
| Command immediately after create | Starting-state conflict was possible | `200 command.finished` | High for this run; no conflict evidence |
| Stop ready Box | `202 box.stopping` | `202 box.stopping` | High |
| Immediate repeated stop | `202` when archival is already in progress | `202 box.stopping` again | Documented + live-confirmed |
| Resume archived Box | `202 box.resuming` | `202 box.resuming` | High |
| Immediate repeated resume | Retry behavior not specified | `202 box.resuming` again | Single-run observation only |
| Save named snapshot | `202 snapshot.named.saving` | `202 snapshot.named.saving` | High |
| Duplicate save while saving | Duplicate/save-in-progress conflict | `409 save_in_progress` | High |
| Delete while saving | State conflict | `409 save_in_progress` | High |
| Eventual snapshot inspect | `200 snapshot.named.info`, ready | Repeated bounded `200 snapshot.named.info` followed by successful ready-only delete sequencing | High |
| Delete ready snapshot | `200 snapshot.named.deleted` | `200 snapshot.named.deleted` | High |
| Repeat snapshot delete | Not found | `404 not_found` | High |
| Delete Box | `202 box.deleting` | `202 box.deleting` | High |
| Deletion operation | Inspectable until completion/absence | `200 deletion.operation`; target absence completed reconciliation | High |
| Repeat Box delete | Retry behavior not specified | `202 box.deleting` with a correlated deletion operation | Single-run observation only |
| Inspect deleted Box | Not found | `404 not_found` | High |
| Billing, suspension, quota exhaustion, deliberate rate-limit exhaustion, provider 5xx | Documentation only | Not induced | Unproven by design |

The concurrent create happened to encounter a real `rate_limited` response. The probe did not attempt to exhaust a rate limit and inserted a fresh request-window delay before lifecycle cases. This confirms this response for the observed operation but does not characterize thresholds, retry timing, or whether any mutation is safe to retry.

## Waterbox Mappings

### Supported Now

| Box observation | Operation context | Waterbox code | Rationale |
| --- | --- | --- | --- |
| `404 not_found` | Inspect/stop/resume/command Box | `not_found` | Absence prevents the requested non-delete operation; use Box operation context. |
| `404 not_found` | Delete Box already represented by a Waterbox record | Successful terminal deletion | Provider absence proves the deletion goal. Mark the Waterbox sandbox terminated rather than returning a failed delete. A sandbox ID absent from Waterbox storage remains a local `not_found` before dispatch. |
| `404 not_found` | Inspect named snapshot | `not_found` | Snapshot-specific public wording comes from operation context, not the generic Box code. |
| `404 not_found` | Delete named snapshot already represented by a Waterbox record | Successful terminal deletion | Provider absence proves the deletion goal. Mark the Waterbox snapshot deleted. A snapshot ID absent from Waterbox storage remains a local `not_found`. |
| `404 not_found` | Save named snapshot from missing source Box | `not_found` | Use source-Box resource context, not the destination snapshot context. |
| `404 snapshot_not_found` | Create Box from named snapshot | `provider_failure` | Keep only safe operation/source-snapshot/provider diagnostics; neither this status nor code is documented for missing `from`, so do not promote it to stable Waterbox `not_found`. |
| `400 invalid_timeout` | Command request validation | `invalid_request` | This is request-shape/range validation, not resource state. |
| `409 idempotency_key_reused` | Same create key with changed body | `idempotency_conflict` | Exact match for Waterbox's stable idempotency mismatch semantics. |
| `409 save_in_progress` | Duplicate save of the same named snapshot | `conflict` | The requested creation conflicts with an existing in-progress name/save. |
| `409 save_in_progress` | Delete that same saving snapshot | `invalid_state` | The target exists but cannot be deleted in its current state. |
| `429 rate_limited` | Provider request window | `provider_limit` | A provider-side limit, not caller authentication or an internal Waterbox conflict. |
| `401 unauthorized` from Box | Any provider call | `provider_failure` | This identifies Waterbox's upstream credential/configuration failure. It must not be presented as Direct MCP caller authentication failure. |
| `409 idempotency_in_progress` | Concurrent/early keyed create | Existing Waterbox in-progress contract | Documented-only and contract-testable; not live-confirmed by this run. |
| `502 box_direct_failed` or response-lost command | Command | `ambiguous_execution` | Documentation says execution may have occurred; local injection confirms no automatic replay. |
| Potentially dispatched stop/resume/delete/snapshot mutation failure | Mutating provider call | `ambiguous_execution` unless read-only reconciliation proves outcome | Never infer rejection from a lost response. |
| Malformed/unknown definite provider failure | Any provider call | `provider_failure` | No narrower stable semantic mapping is established. |

Waterbox must accept the observed 2xx responses for repeated stop, repeated resume, and repeated Box delete rather than manufacture errors. Only keyed same-body create replay and stop-already-in-progress have documentation supporting retry semantics here; the repeated-resume and repeated-delete observations do not establish generally safe mutation retries.

### Incorrect Or Unproven

- Mapping generic Box `not_found` by lexical code alone to a specific Waterbox resource type is incorrect. Use operation context.
- Treating provider-confirmed absence as a failed delete is incorrect when Waterbox already owns the resource record. Absence satisfies deletion; only a missing Waterbox record should produce local `not_found` before dispatch.
- Mapping upstream Box `401 unauthorized` to Waterbox/Direct MCP `unauthorized` is incorrect. Direct MCP made the provider request; its configuration failed.
- Mapping `idempotency_key_reused` to generic `conflict` loses a proven stable distinction. Use `idempotency_conflict`.
- Mapping duplicate save and delete-while-saving identically is too coarse. The same Box code has operation-specific Waterbox meanings: creation `conflict`, deletion `invalid_state`.
- Rejecting the observed repeated stop/resume 2xx responses or repeated Box-delete 2xx response would be incorrect, but treating all such retries as stable or generally safe is also unsupported.
- `idempotency_in_progress` was not observed live, but is documented and contract-testable.
- Box quota, billing, organization suspension, deliberate rate limiting, provider 5xx, and malformed live envelopes remain unproven.
- Provider status and allowlisted lexical code can be safe diagnostic facts; they are not the stable Waterbox semantic contract.

## Direct MCP Recommendation

Direct MCP should eventually expose stable Waterbox domain errors through a strict safe error object, not a Box envelope. The object should contain only:

- Stable Waterbox `code` and its fixed public message.
- Waterbox operation enum/context.
- Public Waterbox resource kind and ID only when that ID was already known to the caller.
- Outcome certainty: `rejected` or `unknown`.
- Provider diagnostics limited to the known provider name, a valid HTTP status, and an operation-specific allowlisted, bounded lexical provider code.

Provider status/code are diagnostic facts, not the stable Waterbox semantic contract. Never expose provider message/body/details, request ID, URLs, authorization or authentication material, provider references, commands, file or environment content, or stack traces.

Expose these proven operation-level codes now:

- `not_found` for missing Waterbox sandbox or snapshot records and provider-confirmed absence when the requested non-delete operation requires the resource to exist.
- Successful terminal deletion when the provider confirms that an existing Waterbox-owned target is already absent.
- `invalid_request` for documented and observed command timeout validation.
- `idempotency_conflict` for changed-body reuse of a create idempotency key.
- `conflict` for duplicate snapshot creation while the same provider name is saving.
- `invalid_state` for deleting a snapshot while it is saving.
- `provider_limit` for observed provider rate limiting and only other positively identified provider limits.
- `ambiguous_execution` for unreconciled mutating outcomes.
- `provider_failure` for upstream authentication/configuration failure, malformed envelopes, and definite failures without a narrower proven mapping.

Keep `idempotency_in_progress` in the Waterbox contract as a documented-only Box mapping; do not claim live validation. Preserve successful responses for same-body create replay and observed repeated lifecycle calls without inferring generic retry safety. Until this strict structured output is implemented, the current generic `Waterbox MCP request failed` remains safer than exposing unbounded provider material, but it should eventually be replaced by the stable semantics and constrained diagnostics above.
