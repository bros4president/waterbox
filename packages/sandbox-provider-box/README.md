# @waterbox/provider-box

`BoxSandboxProvider` implements the provider-neutral core port over Box Public API v1.
Lifecycle and snapshots use first-class Box endpoints. Tool execution invokes the
one-shot Waterbox CLI through `POST /boxes/{id}/commands`; no hosted daemon or protected
URL is used or persisted.

Configuration supplies the API base URL, API key, V2 system-template reference, polling
policy, clock, and `fetch`. User Boxes are `noEnv` and receive only a non-secret sandbox
tag. Opaque V2 references contain the Box ID only; legacy daemon references are rejected.

Canonical tool arguments are encoded as a bounded, versioned base64url envelope and sent
as one `waterbox run` argument. Commands are never retried. Lost responses, Box 5xx,
timeouts, truncation, malformed CLI output, and internal CLI failures are surfaced as
ambiguous execution. Definite API 4xx and structured CLI rejections are ordinary provider
failures. Bash returns one buffered terminal event because Box commands are synchronous.
That event may report completed execution or detached dispatch; the adapter forwards either
receipt unchanged and does not read or poll its output/status files.

Each tool invocation is sent as one independent Box command request. The adapter does not
queue, serialize, deduplicate, or throttle command execution. Any provider-side command
ordering or concurrency limit is surfaced as Box behavior rather than recreated by
Waterbox.
