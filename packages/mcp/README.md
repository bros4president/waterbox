# waterbox

`waterbox` is the supported local stdio MCP for isolated, stateful coding
sandboxes. It requires Node.js 24.15.0 or newer, opens no listener, and supports
hosted Waterbox plus explicitly configured direct Box and Vercel Sandbox accounts.
It is not the hosted Waterbox service and has no JavaScript library API.

## Install And Configure

```sh
npx add-mcp waterbox@next
```

This prerelease is distributed under the npm `next` tag. The command installs
MCP client configuration equivalent to `{ "command": "npx", "args": ["-y",
"waterbox@next"] }`. It does not collect provider credentials. Running `npx
waterbox@next` directly starts the stdio server; use an explicit argument for
terminal-only onboarding:

```sh
npx waterbox@next setup
npx waterbox@next status
npx waterbox@next logout
```

Interactive setup stores only the provider credential in the native keyring.
Non-secret settings are written atomically to `~/.waterbox/config.json` using
the exact official direct-provider endpoints `https://ascii.dev/api/box/v1` and
`https://api.vercel.com/`; hosted Waterbox is pinned to `https://api.waterbox.ai/`.
Interactive setup shows hosted Waterbox only when its public capability document
advertises availability. Existing hosted keyring configuration and explicit
`WATERBOX_PROVIDER=waterbox` environment configuration remain valid independently.
`FORCE_DISPLAY_WATERBOX=1` is a development/debug override that shows it without
fetching capabilities.
Status never prints credentials. Logout removes local settings and all three
keyring entries but does not alter remote resources or
the SQLite resource registry.

For headless systems without a usable keyring, place a complete provider
configuration in the MCP client's environment/secret facility. Do not put
secrets in command arguments:

```text
Waterbox: WATERBOX_PROVIDER=waterbox, WATERBOX_API_KEY=<client-managed secret>
Box:    WATERBOX_PROVIDER=box, BOX_API_KEY=<client-managed secret>,
        WATERBOX_AUTO_STOP=40m
Vercel: WATERBOX_PROVIDER=vercel, VERCEL_TOKEN=<client-managed secret>,
        VERCEL_TEAM_ID=<team identifier>, VERCEL_PROJECT_ID=<project identifier>,
        WATERBOX_AUTO_STOP=40m
```

Hosted Waterbox always targets `https://api.waterbox.ai/`. Custom Box/Vercel
endpoints are supported only when the complete provider
selection and credentials come from process environment. Environment and
persisted sources are never mixed. `.env` is never loaded implicitly.

An unconfigured server remains connected and returns setup guidance from all
tools before filesystem, SQLite, artifact, or provider I/O.

## Configuration

| Variable | Required | Default |
| --- | --- | --- |
| `WATERBOX_PROVIDER` | Environment setup: `waterbox`, `box`, or `vercel` | none |
| `WATERBOX_API_KEY` | Hosted Waterbox environment setup | none |
| `FORCE_DISPLAY_WATERBOX` | Development/debug interactive-setup override; only `1` enables it | none |
| `BOX_API_KEY` | Box environment setup | none |
| `BOX_API_BASE_URL` | Environment-only override | `https://ascii.dev/api/box/v1` |
| `BOX_POLL_INTERVAL_MS` | No | `1000` |
| `BOX_POLL_TIMEOUT_MS` | No | `120000` |
| `VERCEL_TOKEN` | Vercel environment setup | none |
| `VERCEL_TEAM_ID` | Vercel environment setup | none |
| `VERCEL_PROJECT_ID` | Vercel environment setup | none |
| `VERCEL_API_ORIGIN` | Environment-only HTTPS-origin override | `https://api.vercel.com/` |
| `VERCEL_POLL_INTERVAL_MS` | No | `1000` |
| `VERCEL_POLL_TIMEOUT_MS` | No | `120000` |
| `VERCEL_REQUEST_TIMEOUT_MS` | No | `30000` |
| `WATERBOX_AUTO_STOP` | Box and Vercel environment setup; whole minutes/hours such as `40m` or `6h` | none |
| `WATERBOX_SQLITE_PATH` | No | `~/.waterbox/direct.sqlite` |

## Lifecycle And Tools

Waterbox exposes `create_sandbox`, `probe_sandbox`, `stop_sandbox`,
`list_snapshots`, `create_snapshot`, `delete_snapshot`,
`send_file_securely`, `read`, `write`, `edit`, `patch`, `glob`, `grep`, and
`bash`. Resource IDs are explicit; there is no selected sandbox or
`list_sandboxes` tool.

Direct Box/Vercel mode owns only records in its local SQLite database and does
not infer ownership from provider inventory. Hosted Waterbox records are owned
by the hosted service. Sandboxes persist after the MCP exits.
Changing provider scope does not migrate or clean old resources, which may
continue to incur charges. Fresh and snapshot-sourced sandboxes receive the
current packaged Node CLI without a shared system snapshot, Bun, or daemon.

Secure transfer keeps file contents out of MCP arguments and model context in
transit, but the destination is plaintext and provider/sandbox-readable.
Ordinary operations are not retried after ambiguous execution. Provider quotas,
automatic stopping, snapshot retention, and optional capabilities remain
provider-defined.

Official MCP registry and catalog discovery are deferred; no `server.json` is
included in the npm package.
