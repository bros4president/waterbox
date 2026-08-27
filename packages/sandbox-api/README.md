# `@waterbox/api`

Provider-neutral Web API for the Waterbox control plane. Construct it with an injected
core service and `IdentityResolver`, then call its Web-standard `fetch` method. Runtime
server adapters, credential storage, repositories, and providers belong in composition
packages.
