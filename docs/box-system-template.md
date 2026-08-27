# Box system template

Phase F is pending a credential-gated, probe-driven implementation. There is no
system-template builder in this repository and no current claim that Box supports the
file, command, snapshot, or lifecycle behavior needed to build and operate a system
template safely.

`scripts/box-capability-probe.ts` is a deliberately small raw-fetch capability probe.
It does not install or host the Waterbox daemon and does not produce template metadata.
Automated tests use an injected fake fetch; a real run requires `BOX_API_KEY`, the
`--run` CLI flag, and the exact environment authorization documented by `--help`.

## Probe scope

The probe must establish all of the following before Phase F implementation begins:

- Account limits are observable and zero-data-retention is disabled.
- A small, short-TTL `noEnv` Box can be created with an idempotency key, and exact
  replay of the same logical request returns the same Box ID.
- Box readiness states are observable and a unique marker can be written using a
  documented file or command endpoint.
- A unique named snapshot can be created while its source is running, observed from
  `saving` through `ready`, and used as the generic source of a second Box.
- The restored Box contains the marker.
- The source can be stopped, observed as `archived`, resumed with the same Box ID, and
  still contains the marker.
- Both Boxes can be permanently deleted with explicit confirmation and deletion
  operation polling, and the named snapshot can be deleted.
- Output and failures contain only sanitized observations. Cleanup after failure is
  bounded, best-effort, and uses fresh abort signals.

The probe intentionally excludes daemon installation and hosting, same-name snapshot
replacement, forced stop, a provider-specific fork endpoint, webhooks, snapshot
download or tree APIs, and artificial failure injection against a real account.

## Phase F safety requirements

Any future implementation must preserve `noEnv`, credential-free configuration,
the explicit non-secret `WATERBOX_SANDBOX_ID` tag, protected URL handling, exact
documented create replay, and strict identity correlation.
It must not blindly retry commands or ambiguous snapshot mutations. Permanent deletion
must use confirmation and reach a confirmed terminal deletion operation. Cancellation,
bounded operations, redaction, named snapshot source/artifact correlation, and cleanup
ownership must remain explicit.

Acceptance requires a separately authorized real probe run, reviewed sanitized
observations, implementation against the confirmed endpoints and fields, focused fake
HTTP tests, and manual end-to-end verification. `BOX_API_KEY` must never appear in a
Box environment map, command body, uploaded file, template, metadata, or log.
