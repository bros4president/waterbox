# @waterbox/control-plane-local

Private local composition for the canonical API over core, SQLite, and Box or an injected test provider. `createEmbeddedApiBackend` authenticates in-process Fetch requests at the synthetic `http://waterbox.local/` origin and opens no listener. `createLocalControlPlane` exposes the raw authenticated handler used by the thin `apps/api-local` development listener.

Callers load the runtime artifact before composition. Provider and artifact validation precede SQLite side effects, and owned resources close idempotently.
