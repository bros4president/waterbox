# @waterbox/client

Private workspace client for the canonical authenticated Waterbox HTTP API. `WaterboxClient` owns route paths, validation, NDJSON decoding, safe errors, Bash observation, and secure-transfer encryption. The same commands run over an injected embedded or authenticated network `ApiBackend`.

It imports no core, API server, repository, provider, MCP, or app package. Secure-transfer plaintext remains client-side, mutations are not automatically retried, response bodies are bounded, and closure is idempotent. It is bundled into MCP rather than exported as a public library.
