# `@waterbox/contracts`

Canonical runtime contracts shared by the Waterbox control plane, providers, runtime, and public API. Zod schemas are the source of truth; TypeScript types are inferred from them.

Prereleases use the `next` dist-tag while the API is being validated against the hosted Waterbox implementation. Pre-1.0 releases may contain breaking changes.

## Public And Internal Data

The resource schemas in this package describe public data. They deliberately cannot represent account ownership, opaque provider references, provider credentials, protected URLs, tokens, or other provider implementation state. Public API implementations must serialize records through these schemas rather than returning internal records directly.

`IdentitySchema` is a trusted boundary contract passed to core after authentication. It is not a public resource DTO. Internal persistence records, provider ports, provider references, and business logic belong in later packages and are not defined here.

All exported object schemas reject unknown keys. V1 public error envelopes are closed objects containing only the stable safe fields defined by `ErrorEnvelopeSchema`; arbitrary `details` are not part of the public contract and are rejected rather than filtered or redacted.

## Wire Compatibility

`CreateSandboxHeadersSchema` validates the HTTP wire shape directly, including the exact optional `Idempotency-Key` header name. Adapters must not rename it to a camelCase contract before validation.

Canonical final tool events are flattened as `{ type: "result", title, output, metadata }`. Bash metadata always includes `outputTruncated`. This intentionally matches the proven v0 receiver behavior, and Phase D must preserve the shape when extracting the shared runtime.
