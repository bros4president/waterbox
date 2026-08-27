# Box system template

Phase F provides a credential-gated builder for the deterministic named Box snapshot
used as Waterbox's system template. It compiles the shared daemon, creates a temporary
`noEnv` Box without a `from` source, installs the daemon and ripgrep, enables a systemd
service, verifies local health, stops the source, and saves the named snapshot.
The daemon build explicitly targets Bun's Linux x86-64 baseline executable format, and
the builder validates the ELF class, byte order, and machine before its first Box request.

The builder is separate from API startup and never runs under `bun test`. It uses only
the official Box v1 file, command, lifecycle, named-snapshot, and deletion endpoints.
It never sends the Box API key in a Box body, environment, command, uploaded file, or
metadata document.

## Validation and configuration

Build the standalone daemon and validate local inputs without contacting Box:

```sh
bun run --cwd packages/sandbox-daemon build
bun run scripts/build-box-system-template.ts --validate
```

The root command compiles the daemon before invoking the builder:

```sh
bun run build:box-template --validate
```

A live build additionally requires both `BOX_API_KEY` and the exact explicit
authorization printed by `bun run build:box-template --help`. Optional settings are:

- `BOX_API_BASE_URL` (defaults to the full official v1 API URL)
- `WATERBOX_BOX_TEMPLATE_NAME` (defaults to `waterbox-system-v1`)
- `WATERBOX_DAEMON_ARTIFACT`
- `WATERBOX_TEMPLATE_METADATA` (defaults to `.waterbox/box-system-template.json`)
- `WATERBOX_DAEMON_PORT` (defaults to `8080`)
- the three `BOX_TEMPLATE_*_MS` polling/request timing controls shown by `--help`

Use `--replace` only after reviewing the currently named snapshot. Without it, the
builder refuses to mutate an existing same-name template. The official contract says
a same-name save replaces the previous artifact only once the new save is ready, but
the builder still sends that mutation exactly once and never retries an ambiguous save.
If the save outcome is ambiguous, it preserves the stopped source Box for operator
reconciliation and does not write new deployment metadata.

## Installation and metadata

The artifact is uploaded only to `/tmp`, then a privileged command installs it at
`/usr/local/bin/waterbox-daemon`. The systemd service uses `/workspace`, listens on the
configured port, starts after network availability, restarts on failure, and is enabled
for boot/resume/snapshot restore. The source is stopped before `POST /named-snapshots`.

On a ready snapshot, the builder writes mode-0600 JSON under `.waterbox/` containing
only schema version, provider name, deterministic template reference, daemon port, and
build timestamp. `.waterbox/` is gitignored. The API runtime needs only `templateRef`
and the daemon port; the file contains no API credential, Box identifier, or protected
URL.

The official file-write schema does not state an upload-size ceiling. Whether the
compiled standalone artifact fits the live endpoint remains a manual verification item;
the builder correlates the returned path, base64 encoding, and exact decoded byte size.

The builder permanently deletes its stopped temporary source with the exact confirmation
header and polls the deletion operation. A `blocked` operation is reported as
`accepted_pending`; it does not claim that this particular source has been physically
deleted or released capacity, and an operator must reconcile it.
Before snapshot mutation, failures trigger bounded best-effort source deletion. After an
ambiguous snapshot mutation, preserving the stopped source takes precedence over cleanup.

## Manual verification (explicit authorization required)

No live operation is part of automated tests. In an authorized session:

1. Run the live builder and retain its sanitized NDJSON observations.
2. Create a `noEnv` Box with `from` equal to the emitted template reference.
3. Confirm `systemctl is-enabled waterbox-daemon` and `systemctl is-active
   waterbox-daemon`, and call its local `/health` endpoint.
4. Register the configured daemon port with `POST /boxes/{id}/host` using
   `{ "public": false }`; treat the returned protected URL and token as credentials.
5. Stop and resume the same Box, then confirm the service and health endpoint again.
6. Save a unique user named snapshot, restore it into a second `noEnv` Box, and confirm
   the daemon remains active.
7. Permanently delete both verification Boxes and the user snapshot, then reconcile any
   accepted-pending deletion operations.

Never paste live identifiers, protected URLs, API keys, or unredacted error bodies into
logs, issues, commits, or verification records.
