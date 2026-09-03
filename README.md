# Waterbox

Waterbox gives MCP clients coding tools backed by isolated, stateful sandboxes.
The supported product is a local Node.js stdio server. It opens no listener and
has no hosted mode.

```text
MCP client -> waterbox stdio -> bundled client -> authenticated in-process API
           -> core -> local SQLite -> explicitly selected Box or Vercel Sandbox
```

## Install

Node.js 24.15.0 or newer is required.

```sh
npx add-mcp waterbox@next
```

This prerelease is distributed under the npm `next` tag. `add-mcp` installs
client configuration whose command is `npx -y waterbox@next`; it does not run
provider onboarding or collect credentials. `npx waterbox@next` starts
the stdio MCP, while these explicit commands use terminal-only onboarding:

```sh
npx waterbox@next setup
npx waterbox@next status
npx waterbox@next logout
```

Setup requires an interactive terminal. It stores Box API keys and Vercel
tokens only in the native keyring; only non-secret settings are written to
`~/.waterbox/config.json`. Persisted setup always uses the official Box
endpoint or Vercel API origin. Restart the MCP client after a change.

If the native keyring is unavailable, configure the MCP process through your
client's environment or secret facility. Select exactly one provider:

```text
WATERBOX_PROVIDER=box
BOX_API_KEY=<client-managed secret>

WATERBOX_PROVIDER=vercel
VERCEL_TOKEN=<client-managed secret>
VERCEL_TEAM_ID=<team identifier>
VERCEL_PROJECT_ID=<project identifier>
```

Environment-only configuration may additionally set a custom
`BOX_API_BASE_URL` or `VERCEL_API_ORIGIN`. Persisted keyring credentials can
never be redirected to custom endpoints. Waterbox does not load `.env` files
implicitly. Never put credentials in chat, MCP tool arguments, shell history,
or committed configuration.

Installation works before provider configuration. The MCP still initializes,
lists its complete tool surface, and returns provider-neutral setup guidance
without opening SQLite, loading an artifact, or contacting a provider.

## State And Ownership

Local records live in `~/.waterbox/direct.sqlite` by default. Sandboxes persist
when the MCP process exits. Waterbox operates only on resources recorded in
that database and never treats provider inventory as proof of ownership. Keep
the IDs returned by create operations; there is intentionally no
`list_sandboxes` tool.

Changing provider, Box account, Vercel team/project, or another resource-scope
setting does not stop, migrate, or delete prior resources. They may continue to
incur provider charges. `waterbox logout` removes only local configuration and
keyring credentials, not SQLite records or remote resources.

Fresh sandboxes receive the packaged one-shot Node CLI during creation. A
supported provider snapshot is repaired to the current packaged CLI while
preserving user data outside Waterbox-owned runtime paths. No shared system
snapshot, daemon, or Bun runtime is used.

## Tools

Lifecycle tools are `create_sandbox`, `probe_sandbox`, `stop_sandbox`, and
`delete_sandbox`. Snapshot tools are `list_snapshots`, `create_snapshot`, and
`delete_snapshot`. Coding tools are `read`, `write`, `edit`, `patch`, `glob`,
`grep`, and `bash`; each requires a sandbox ID. `send_file_securely` encrypts a
bounded local file in transit to a sandbox without placing its contents in
model context.

Box and Vercel Sandbox support the mandatory lifecycle and coding surface.
Provider plans, quotas, automatic-stop behavior, snapshot retention, and
optional capabilities remain provider-defined. Commands are not retried after
an ambiguous execution result.

## Security

The local SQLite database contains resource records but no provider
credentials. Sandbox agents and providers can read plaintext files delivered
to a sandbox, and snapshots may retain them. The MCP process can read any local
file permitted by the invoking user when `send_file_securely` is approved, so
client-side tool permissions remain important.

Official MCP registry/catalog publication is deferred. Direct npm installation
through `npx add-mcp waterbox@next` does not depend on registry metadata.

See [`packages/mcp/README.md`](packages/mcp/README.md) for all environment
settings and [`CONTRIBUTING.md`](CONTRIBUTING.md) for release gates.
