# Box system template

The Box system template contains the one-shot Waterbox CLI used by the Box provider.
It does not run a daemon, install a systemd service, listen on a port, or register Box
hosting. Tool calls use the authenticated Box command endpoint.

## Validation and configuration

Build and validate locally without contacting Box:

```sh
bun run build:box-template --validate
```

A live build requires `BOX_API_KEY` and the explicit authorization printed by
`bun run build:box-template --help`. Optional settings are:

- `BOX_API_BASE_URL`
- `WATERBOX_BOX_TEMPLATE_NAME` (defaults to `waterbox-system-v6`)
- `WATERBOX_CLI_ARTIFACT`
- `WATERBOX_TEMPLATE_METADATA` (defaults to `.waterbox/box-system-template.json`)
- the `BOX_TEMPLATE_*_MS` timing controls shown by `--help`

The builder always refuses an existing name; changed artifacts require a new immutable
versioned template. It never retries an ambiguous snapshot mutation and preserves the
stopped source Box for reconciliation.

## Installation

The builder creates a temporary `noEnv` Box, uploads the Node bundle, and installs:

- the existing Node runtime at `/usr/local/bin/node`
- the CLI bundle at `/usr/local/lib/waterbox-cli.js`
- the `waterbox` launcher at `/usr/local/bin/waterbox`
- `ripgrep`

The launcher recreates `/home/user/workspace` after snapshot restore and creates
`/run/waterbox/bash-jobs` with mode `0700`. It uses that snapshot-durable workspace for
relative paths and shell commands. The CLI runs as root and accepts absolute paths,
workspace traversal, and normal symbolic links across the entire Box filesystem. The Box
itself is the security boundary; Waterbox does not impose a second filesystem boundary
inside an agent-owned sandbox. Box named snapshots preserve the `/home/user` workspace.

Each invocation is sent independently through Box's command endpoint. Waterbox does not
queue, serialize, throttle, deduplicate, or retry commands; provider concurrency behavior
is authoritative. The builder checksum-verifies the pinned Bun archive and verifies
protocol V2 from both `waterbox health` and `waterbox version`, stops the source, saves
`waterbox-system-v6`, writes schema-v2 local
metadata, and permanently deletes the source. Metadata contains only the template name,
artifact kind, CLI protocol version, and build timestamp.

## Tool protocol

The provider validates canonical arguments and sends one command:

```text
/usr/local/bin/waterbox run j2.<unpadded-base64url-json>
```

The envelope contains `protocolVersion`, `tool`, and `arguments`. Encoded input is bounded
to 96 KiB and decoded input to 72 KiB. The CLI validates the same canonical schemas and
prints exactly one canonical result line. Bash output is buffered by Box and represented
by its terminal result rather than incremental chunks.

For every one-shot Bash call, the CLI creates private receipt files and spawns
`/usr/local/bin/node /usr/local/lib/waterbox-cli.js __internal-bash-worker <jobId>` directly.
Quick commands return a bounded completed result; longer-running commands may yield a
dispatched receipt. `timeout` is only an optional execution deadline. A receipt confirms
worker-process spawn, not Bash startup, completion, or success. Output is appended to
`outputPath`; startup and terminal state are written to `statusPath`. Hidden CLI modes sample
bounded byte ranges by validated `jobId`, derive all paths from `/run/waterbox/bash-jobs`, and
remove terminal jobs best-effort. MCP starts cleanup asynchronously after terminal drain with a
finite private deadline, so it cannot delay the completed result or retain transport handles
indefinitely. The hidden modes are not public tools and exist so MCP can
absorb a receipt
without line-based reads. Box and core perform one command per sample and never poll or retry;
MCP alone owns observation. There is no public job API, queue, or resident worker service.

## Secure file transfer

`waterbox transfer-initiate` creates a fresh age/X25519 identity under `/run/waterbox/transfers`, returns only its public recipient and fixed ten-minute expiry, and schedules removal through a transient systemd timer. The provider uploads only ciphertext to a random `/tmp` path, then invokes `waterbox transfer-consume t1.<metadata>`. Consumption atomically claims and destroys the identity, decrypts at most 1 MiB, writes the destination with mode `0600`, and removes the uploaded ciphertext. Transfer identities are runtime state and are not stored in Waterbox repositories.

## Manual verification

In an explicitly authorized session:

1. Build `waterbox-system-v6` and retain only sanitized observations.
2. Create a `noEnv` Box from the emitted template reference.
3. Run `waterbox health` through `POST /boxes/{id}/commands`.
4. Execute all seven canonical tools through the control plane.
5. Verify stop/resume and snapshot restore retain the CLI.
6. Permanently delete verification resources and reconcile pending deletion operations.

Never log API keys, serialized invocations, provider IDs, or unredacted response bodies.
The MCP experiment additionally requires `WATERBOX_MCP_EXPERIMENT_AUTHORIZATION` with
the builder's exact authorization phrase and `WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT=YES`.
