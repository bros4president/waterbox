# @waterbox/control-plane-local

Private local composition for the canonical API over core, SQLite, and an explicit Box, Vercel, or injected test provider. `createEmbeddedApiBackend` authenticates in-process Fetch requests at the synthetic `http://waterbox.local/` origin and opens no listener. `createLocalControlPlane` exposes the raw authenticated handler used by the thin `apps/api-local` development listener.

`WATERBOX_PROVIDER` is required for direct local composition. `box` requires
`BOX_API_KEY`; `vercel` requires `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and
`VERCEL_PROJECT_ID`. The selected adapter is assembled below this package;
core, API, client, and MCP remain provider-neutral. Configuration and the
caller-owned runtime artifact are validated before SQLite or provider effects.

Callers load the runtime artifact before composition. Provider and artifact validation precede SQLite side effects, and owned resources close idempotently.
