# `@waterbox/core`

Transport-neutral Waterbox domain service and integration ports.

The root export contains the service, dependency interfaces, and typed domain errors. Repository and provider adapters should import their contracts from `@waterbox/core/ports`, `@waterbox/core/provider`, and `@waterbox/core/records`. Persistence records include account ownership and opaque provider state and must never be serialized as public DTOs.

`@waterbox/core/test-support` contains in-memory adapters for tests only. Production composition must provide durable repositories and a real provider.
