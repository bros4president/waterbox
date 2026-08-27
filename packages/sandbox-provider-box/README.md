# @waterbox/provider-box

`BoxSandboxProvider` implements the provider-neutral core port over the Box Public API v1 and the canonical Waterbox daemon protocol. Box response DTOs, resource identifiers, API credentials, and protected-hosting URLs are private implementation details stored only in opaque provider references.

Configuration is explicit and injectable. Production composition supplies the full API base URL (normally `https://ascii.dev/api/box/v1`), API key, deterministic named system-snapshot reference, daemon port, polling policy, clock, and `fetch`. Tests use fake fetch implementations; this package never reads environment variables and does not include a real Box smoke test.

The adapter follows the official operation-specific success envelopes and provider states. User boxes are `noEnv`, receive only a non-secret Waterbox sandbox tag, and use named snapshot names as opaque provider references. Permanent box deletion is confirmed with `X-Ascii-Confirm-Delete` and reconciled through the asynchronous deletion operation; named snapshot deletion is separate.

Mutating Box and daemon calls are issued once. In particular, daemon transport failures after dispatch and `502 box_direct_failed` responses are surfaced as ambiguous execution errors and are never automatically retried.

Protected hosting URLs may carry credentials in their path and query. Tool routes are appended after that path without replacing it, and the query is preserved. Daemon responses are media-type checked, byte bounded, decoded with fatal UTF-8 handling, and validated against the canonical event schemas. Bash accepts only ordered output events followed by exactly one terminal result.
