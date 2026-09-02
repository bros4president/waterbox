# @waterbox/provider-vercel

`VercelSandboxInfrastructure` implements Vercel's native persistent-sandbox
primitives using injected native `fetch` and the versioned REST endpoints
validated by this repository. `VercelSandboxProvider` is only a thin
composition with `@waterbox/provider-runtime`; preparation, canonical tool
execution, secure ciphertext transfer, and Bash-job behavior are shared with
Box.

Configuration is explicit: `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and
`VERCEL_PROJECT_ID`, with an optional HTTPS-only `VERCEL_API_ORIGIN` and
bounded polling settings. No Vercel SDK is used. Durable sandbox references
contain a project-scoped name and ownership correlation only; replaced session
IDs remain adapter-local.

The adapter performs exact non-resuming inspection, sends mutations once,
and maps unresolved mutation outcomes to `ambiguous_execution`. It uses
targeted, ownership-verified cleanup for automatic stop snapshots. It never
uses a provider-global retention option or enumerates snapshots for deletion,
so explicit Waterbox snapshots are not evicted by automatic retention.

For an authorized isolated-project acceptance run, use `bun run
smoke:mcp-vercel` with the two `WATERBOX_VERCEL_SMOKE_*` acknowledgement
gates. The smoke uses a temporary SQLite database and private embedded
authentication; it does not require development-listener variables.
