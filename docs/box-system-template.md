# Box system template builder

`scripts/box-template-builder.ts` reproducibly builds the provider-owned system
template used by `@waterbox/provider-box`. It is separate from API startup and does
not modify the existing AWS deployment or smoke scripts.

## Configuration

Required for a real build:

- `BOX_API_KEY`: Box account API credential. It is used only in control-plane HTTP
  authorization and is never sent to, uploaded to, or written inside the temporary Box.
Optional variables are `BOX_API_BASE_URL` (default `https://ascii.dev/api/box/v1`),
`BOX_SYSTEM_TEMPLATE_NAME` (default `waterbox-system-v1`), `WATERBOX_DAEMON_PORT`
(default `8080`), `WATERBOX_TEMPLATE_METADATA`, `WATERBOX_DAEMON_ARTIFACT`,
`BOX_TEMPLATE_POLL_INTERVAL_MS`, and `BOX_TEMPLATE_POLL_TIMEOUT_MS`.
`BOX_TEMPLATE_REQUEST_TIMEOUT_MS` bounds each HTTP request (default 30 seconds).
The overall `BOX_TEMPLATE_POLL_TIMEOUT_MS` defaults to 20 minutes and cannot be
configured below 20 minutes, leaving bounded time for the 540-second install command,
response margin, readiness polling, snapshot replacement, and metadata publication.

Validate configuration, compile the self-contained daemon, and print the planned
provider operations without making Box requests:

```sh
bun run scripts/box-template-builder.ts --dry-run
```

Run an explicitly authorized real build:

```sh
BOX_API_KEY=... bun run scripts/box-template-builder.ts
```

The script fingerprints every output-affecting input: artifact bytes,
template name/schema, daemon port, unit, install/health commands, and dependencies.
An exact completed rerun returns the existing strict metadata without provider work.
A changed fingerprint re-saves the single configured named snapshot, replacing its
artifact without consuming another named-snapshot quota slot. Existing boxes created
from an earlier artifact are unaffected.

The script creates a stable-idempotency, `noEnv: true` temporary Box, uploads the
self-contained daemon and a systemd unit, installs only `ripgrep` and `curl`, enables
the service, and checks `/health` internally. It then stops the source cleanly,
creates/updates the named system snapshot, waits for it to become ready, and writes
strict machine-readable metadata at `.waterbox/box-system-template.json`. Configure
the API/provider with the resulting `templateRef`. Metadata contains no API key, Box
endpoint, protected hosting URL, or temporary Box ID.

## Failure cleanup policy

The provider snapshot name is the configured deterministic
`BOX_SYSTEM_TEMPLATE_NAME` (validated as a safe, non-reserved 1..63 character name).
The builder uses `GET /named-snapshots/{name}` as its
preflight and reconciliation mechanism. The provider documents replacement by name;
there is no invented snapshot idempotency header or snapshot-list filter.

On failure, timeout, SIGINT, or SIGTERM, the builder deletes a newly-created snapshot
and permanently deletes a newly-created temporary Box, in that order. Replayed or
pre-existing provider resources are never deleted. A stopped idempotency replay is
resumed and reconciled before installation; if anything later fails, it is restored
to stopped with a fresh cleanup signal and is never deleted. Cleanup uses fresh bounded signals, is
best-effort and idempotent, and reports failures with credentials
and protected URLs redacted; operators must then locate the build Box by the stable
idempotency key prefix `waterbox-template-` and delete it manually. After a successful
build, the source Box remains cleanly stopped. Metadata is written atomically only
after the snapshot is ready, using an exclusive lock, unpredictable no-follow temp
file, file/directory sync, and atomic rename.

Before source creation a durable operation journal is atomically fsynced beside the
deployment metadata. It records the schema version, fingerprint, exact create-body
digest, stable idempotency key, correlated Box ID, and snapshot-stage evidence. After
a crash or lost response, the builder replays the documented `POST /boxes` with that
same key and byte-for-byte logical body to recover the original operation. The journal
is the ownership record for this build workflow; corrupt or mismatched journals fail
closed and never authorize deletion. The non-secret `WATERBOX_BUILD_FINGERPRINT`
environment tag remains useful to operators, but the builder does not rely on
undocumented list response fields.

Journal timestamps are canonical UTC instants and recovery is accepted only within a
conservative 23-hour window (with five minutes of future clock-skew tolerance), below
the provider's 24-hour create-idempotency retention. An expired, future-dated,
malformed, or stage-inconsistent journal is never replayed and never authorizes
cleanup. Manual recovery then requires an operator to inspect the recorded file and
provider console, identify the non-secret fingerprint-tagged Box and configured named
snapshot, clean up only resources whose ownership is independently proven, and move
the journal aside before starting a fresh build. Do not simply delete a journal while
an operation may still be active.

When the builder classifies an outcome as requiring manual recovery, it skips **all**
destructive cleanup—even for a temporary Box or snapshot that appeared owned by the
current attempt—and retains the complete journal evidence. This prevents a `finally`
path from destroying either side of a same-name race. Operators must resolve that
state using the manual procedure above.

Ready named snapshots must expose a nonempty provider snapshot artifact ID. Changed
builds publish metadata only after that ID differs from the prior ready artifact and
the snapshot name and source Box both correlate with this journal. A competing save
or same-name race fails closed, retains the journal, and does not delete the shared
named snapshot.

Install commands explicitly request 540 seconds and health checks 30 seconds, within
the documented 600-second cap. Their owning HTTP timers include an additional
10-second response margin while the overall build deadline remains bounded.

The HTTP adapter follows the official Public API v1 contract: JSON base64 uploads to
`/tmp` or `/home/user`, privileged installation via the command endpoint, named
snapshot lookup by name, and confirmed asynchronous permanent deletion with bounded
deletion-operation polling. The earlier fake contract was provisional and has been
replaced by fixtures from the official OpenAPI examples.

## Manual verification (never run in automated tests)

With explicit Box credentials and after a successful build:

1. Read `templateRef` from `.waterbox/box-system-template.json` and create a
   `noEnv: true` Box using that template.
2. Poll the Box until ready, then run an internal command checking
   `systemctl is-enabled waterbox-daemon`, `systemctl is-active waterbox-daemon`, and
   `curl -fsS http://127.0.0.1:8080/health`.
3. Stop and resume the Box, wait for ready, and repeat the systemd and health checks.
4. Create a named user snapshot, wait for ready, create a second Box from its snapshot
   reference, and repeat the checks to prove the daemon survives snapshot restore.
5. Permanently delete both verification Boxes and the verification snapshot. Confirm
   no verification-owned Box remains running or stopped.
6. Run the builder twice with identical inputs and verify the provider returns the
   same configured snapshot without duplication. Change one fingerprint input
   (for example the daemon port), rerun, and verify the same configured name now
   references the replacement artifact without consuming another quota slot.
   Interrupt a build after resuming an idempotently reused stopped source and verify
   the source is stopped again.

Never place `BOX_API_KEY` in a command body, environment map, uploaded file, base
template, systemd unit, metadata file, shell history, or manual-verification log.
