# @waterbox/mcp

The supported Waterbox MCP server. It runs as a local stdio process and renders `@waterbox/client` commands over an authenticated, in-process Waterbox API. Local provider modes open no listener or daemon.

The first release requires Node.js 24.15.0 or newer and supports explicit local Box and Vercel providers. Run `waterbox setup` for an interactive local setup that stores only the provider secret in the operating-system keyring and non-secret settings in `~/.waterbox/config.json`. Waterbox Cloud is represented in configuration but is not implemented yet.

The configured Box account uses the plain provider image. Waterbox prepares the current packaged runtime after Box readiness; no provider system template is required.

## Install

After the package is published, install it without passing provider credentials through the command line. Select one local provider explicitly; MCP never auto-selects a provider:

```bash
npx add-mcp @waterbox/mcp -g \
  --name waterbox
```

For this scoped pre-launch package, run onboarding commands with npm's package selector:

```bash
npx @waterbox/mcp setup
npx @waterbox/mcp status
npx @waterbox/mcp logout
```

The future unscoped `waterbox` package name remains deferred. Setup selects Box or Vercel interactively. Status reports configuration and credential availability without printing a credential; logout removes only local configuration and both stored provider credentials. It does not stop, delete, migrate, or otherwise manage remote provider resources or the local resource registry. If the native keyring is unavailable (including a headless Linux Secret Service/keyutils setup), use environment-only configuration: `WATERBOX_PROVIDER=box` with `BOX_API_KEY`, or `WATERBOX_PROVIDER=vercel` with `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`. Never put secrets in chat, tool arguments, shell history, or a committed configuration file. Restart the client after configuration changes.

Persisted setup defaults to the official Box endpoint and Vercel origin with approved polling defaults. Valid custom endpoints may be set during setup; timing values remain advanced environment-only overrides.

Installation may be completed before credentials are available. In that state the server remains connected, and lifecycle or operation calls return safe setup guidance instead of terminating the MCP connection.

Local state is stored in `~/.waterbox/direct.sqlite` by default. Sandboxes persist when the MCP process exits.

Relative paths and default Bash commands start in the provider-selected sandbox workspace.
Waterbox does not promise a provider-independent absolute workspace path.

## Resource Ownership And Lifecycle

Waterbox operates only on sandboxes and snapshots already registered in its local repository. It never treats provider inventory as an ownership source, and MCP intentionally does not expose a sandbox-enumeration tool. Keep the IDs returned by `create_sandbox` and `create_snapshot`; `list_snapshots` lists only snapshots registered for the currently active provider configuration.

Each registered resource is bound to the exact provider resource scope that created it. Changing provider, account, endpoint, team, or project in setup changes that scope. Setup requires confirmation before such a change, retains inactive-provider credentials so a prior scope can be selected again, and does not clean up, migrate, stop, or delete resources in the old scope. Those remote resources can continue to incur provider charges. Switching back to the exact prior scope makes its registered resources active again.

Snapshot retention is controlled by the provider. A registered snapshot can expire or be externally deleted, and Waterbox may later reconcile it as deleted or report that it is unavailable; it does not promise a Waterbox-defined retention period.

`WATERBOX_AUTO_STOP` is an optional whole-minute or whole-hour duration, such as `30m` or `2h`. When configured, Waterbox passes it to the selected provider at creation time. Provider plans and limits can reject, clamp, ignore, or stop earlier than the requested duration, so it is not an enforcement guarantee. A sandbox may always be stopped or permanently deleted earlier.

## Tools

The MCP exposes explicit resource ownership rather than a process-local selected sandbox:

- `create_sandbox` requires an `idempotencyKey` and accepts an optional `sourceSnapshotId`. Reuse the key to retry the same request; use a new key to create another sandbox.
- `probe_sandbox` always queries the provider for live status and reconciles the observation into Waterbox.
- `stop_sandbox` ends current compute while preserving resumable sandbox state, subject to provider behavior.
- `delete_sandbox` permanently deletes a user-owned sandbox by `sandboxId`.
- `list_snapshots` lists user-owned snapshots with optional `cursor` and `limit` pagination.
- `create_snapshot` creates a user-owned snapshot from a running `sandboxId`; it never implicitly resumes a sandbox.
- `delete_snapshot` permanently deletes a user-owned snapshot by `snapshotId`.
- `send_file_securely` encrypts and transfers an existing local file to a sandbox without placing its contents in model context or tool arguments. The source is retained; the destination is plaintext and sandbox-readable after delivery.
- `read`, `write`, `edit`, `patch`, `glob`, `grep`, and `bash` require the target `sandboxId`.

There is no `list_sandboxes` or `resume_sandbox` MCP tool. Ordinary sandbox operations may resume a locally observed stopped sandbox where the provider supports it.

Tool invocations are dispatched independently. Waterbox does not impose command ordering, concurrency limits, deduplication, or automatic retries; provider and filesystem behavior remain authoritative. An uncertain command response is reported as `ambiguous_execution`.

The one-shot `bash` path starts every command in a detached worker. Quick commands return completed normally; if the CLI yields a dispatched receipt, supported MCP privately samples that same job until it is terminal and fully drained. MCP sends content-free progress notifications when the caller supplied a progress token, returns Bash output as ordinary text plus canonical `structuredContent`, and starts terminal job cleanup asynchronously on a best-effort basis. Cleanup has a finite private deadline and never delays the completed result. MCP never retries or terminates the command. Cancellation or observation failure preserves the job files and returns the original receipt with recovery guidance when a response remains possible. `timeout`, when supplied, remains only the command's execution deadline; nonzero and timed-out commands are completed results with MCP `isError` set.

Fresh Box sandboxes are created from the plain provider image and receive the packaged Waterbox CLI during creation. Sandboxes created from a user snapshot receive the current packaged CLI over inherited Waterbox-owned runtime files while preserving user data outside those paths.

Secure file transfer uses a fresh sandbox-side age/X25519 key with a fixed ten-minute expiry and single-use consumption. Files are limited to 1 MiB. The transport does not prevent the sandbox agent or provider from reading the decrypted destination, and persistent destination files may be included in later snapshots. Avoid reading sensitive destination contents back through model-facing tools.

The sandbox command deletes its uploaded ciphertext after every attempted consumption. If provider delivery becomes ambiguous before that command starts, an encrypted temporary artifact can remain until the sandbox is discarded; the corresponding private key still expires after ten minutes.

`send_file_securely` may read any local file accessible to the MCP process. This follows Waterbox's inherited agent-access model rather than creating a second local filesystem policy; MCP clients should apply their normal tool approval and local-process permission controls.

## Configuration

| Variable | Required | Default |
| --- | --- | --- |
| `WATERBOX_PROVIDER` | Yes: `box` or `vercel` | none |
| `BOX_API_KEY` | For `box` | none |
| `BOX_API_BASE_URL` | No | `https://ascii.dev/api/box/v1` |
| `BOX_POLL_INTERVAL_MS` | No | `1000` |
| `BOX_POLL_TIMEOUT_MS` | No | `120000` |
| `VERCEL_TOKEN` | For `vercel` | none |
| `VERCEL_TEAM_ID` | For `vercel` | none |
| `VERCEL_PROJECT_ID` | For `vercel` | none |
| `VERCEL_API_ORIGIN` | No; HTTPS origin only | `https://api.vercel.com` |
| `VERCEL_POLL_INTERVAL_MS` | No | `1000` |
| `VERCEL_POLL_TIMEOUT_MS` | No | `120000` |
| `VERCEL_REQUEST_TIMEOUT_MS` | No | `30000` |
| `WATERBOX_AUTO_STOP` | No; whole minutes or hours, for example `30m` or `2h` | provider default |
| `WATERBOX_SQLITE_PATH` | No | `~/.waterbox/direct.sqlite` |

MCP does not infer a provider from available credentials. `WATERBOX_PROVIDER`, when set, resolves the selected provider entirely from environment variables and never mixes with local keyring/configuration data. Provider-specific variables without `WATERBOX_PROVIDER` are rejected with setup guidance. Waterbox never loads `.env` implicitly. Setting `WATERBOX_PROVIDER=waterbox` keeps the server connected and returns clear unsupported-provider setup guidance from tool calls because Waterbox Cloud is not available yet.
