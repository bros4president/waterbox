# @waterbox/mcp

The supported Waterbox MCP server. It runs as a local stdio process and connects directly to the configured sandbox provider.

The first release requires [Bun](https://bun.sh/) 1.3.2 or newer and supports the Box provider. Waterbox Cloud is represented in configuration but is not implemented yet.

The configured Box account must contain the immutable `waterbox-system-v6` named template. The repository template builder provisions it for development accounts; managed distribution of provider templates remains separate from npm installation.

## Install

After the package is published, install it without passing provider credentials through the command line:

```bash
npx add-mcp @waterbox/mcp -g \
  --name waterbox \
  --env WATERBOX_PROVIDER=box
```

Then configure `BOX_API_KEY` using the secret or environment mechanism recommended by your MCP client. Do not put the key in chat, tool arguments, shell history, or a committed configuration file. Restart the client after providing the credential so the local MCP process receives it.

Installation may be completed before credentials are available. In that state the server remains connected, and lifecycle or operation calls return safe setup guidance instead of terminating the MCP connection.

Direct state is stored in `~/.waterbox/direct.sqlite` by default. Sandboxes persist when the MCP process exits.

## Tools

The MCP exposes explicit resource ownership rather than a process-local selected sandbox:

- `create_sandbox` requires an `idempotencyKey` and accepts an optional `sourceSnapshotId`. Reuse the key to retry the same request; use a new key to create another sandbox.
- `probe_sandbox` always queries the provider for live status and reconciles the observation into Waterbox.
- `delete_sandbox` permanently deletes a user-owned sandbox by `sandboxId`.
- `list_snapshots` lists user-owned snapshots with optional `cursor` and `limit` pagination.
- `create_snapshot` creates a user-owned snapshot from a running or stopped `sandboxId`.
- `delete_snapshot` permanently deletes a user-owned snapshot by `snapshotId`.
- `send_file_securely` encrypts and transfers an existing local file to a sandbox without placing its contents in model context or tool arguments. The source is retained; the destination is plaintext and sandbox-readable after delivery.
- `read`, `write`, `edit`, `patch`, `glob`, `grep`, and `bash` require the target `sandboxId`.

Tool invocations are dispatched independently. Waterbox does not impose command ordering, concurrency limits, deduplication, or automatic retries; provider and filesystem behavior remain authoritative. An uncertain command response is reported as `ambiguous_execution`.

The one-shot `bash` path starts every command in a detached worker. Quick commands return completed normally; longer-running commands may yield a dispatched receipt. `timeout`, when supplied, is only the command's execution deadline. A receipt confirms only the worker process and assigned `statusPath` and `outputPath`, not command startup, completion, or success. `statusPath` reports execution state and `outputPath` receives output continuously. Models decide whether and when to use those capabilities; repeated output reads can duplicate tokens and pollute context. Waterbox, Box, and MCP do not poll, retry, or reconcile detached commands.

The provider's system template is not a user-owned Waterbox snapshot, does not appear in `list_snapshots`, and cannot be addressed by `delete_snapshot`.

Secure file transfer uses a fresh sandbox-side age/X25519 key with a fixed ten-minute expiry and single-use consumption. Files are limited to 1 MiB. The transport does not prevent the sandbox agent or provider from reading the decrypted destination, and persistent destination files may be included in later snapshots. Avoid reading sensitive destination contents back through model-facing tools.

The sandbox command deletes its uploaded ciphertext after every attempted consumption. If provider delivery becomes ambiguous before that command starts, an encrypted temporary artifact can remain until the sandbox is discarded; the corresponding private key still expires after ten minutes.

`send_file_securely` may read any local file accessible to the MCP process. This follows Waterbox's inherited agent-access model rather than creating a second local filesystem policy; MCP clients should apply their normal tool approval and local-process permission controls.

## Configuration

| Variable | Required | Default |
| --- | --- | --- |
| `WATERBOX_PROVIDER` | Yes | none |
| `BOX_API_KEY` | For `box` | none |
| `WATERBOX_SQLITE_PATH` | No | `~/.waterbox/direct.sqlite` |
| `BOX_API_BASE_URL` | No | `https://ascii.dev/api/box/v1` |
| `BOX_SYSTEM_TEMPLATE_REF` | No | `waterbox-system-v6` |
| `BOX_POLL_INTERVAL_MS` | No | `1000` |
| `BOX_POLL_TIMEOUT_MS` | No | `120000` |

Setting `WATERBOX_PROVIDER=waterbox` currently exits with a clear unsupported-provider error.
