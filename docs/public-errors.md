# Public Error Contract

A public error has an existing `ErrorCode` and one complete, bounded, locally
authored message. `DomainError.message` and every `cause` are private unless a
core-owned public-domain factory brands that specific error. Public boundaries
preserve branded text exactly; they do not append context, interpret it, or
stack messages. Unbranded domain errors use the fixed message for their code.
Unknown errors use the generic internal-error message.

Provider errors are always untrusted. The nearest Waterbox operation boundary
maps them to a new public domain error using its own operation context, keeps
the raw error only as a private cause, and never copies provider prose or
payloads. A handler rethrows when its public outcome remains accurate, wraps
with one new complete message when it changes, and keeps secondary cleanup or
diagnostic failures private when the primary outcome remains accurate.

`lastError` stores only a branded public message or the fixed code fallback.
The API uses the strict `{error:{code,message,requestId,sandboxId?}}` envelope
and never serializes causes or diagnostic details. The client brands only
strictly validated API envelopes and reviewed local failures. MCP presents only
those branded client errors and explicit MCP-local errors. A marker makes a
message eligible for presentation if it reaches a boundary; it does not
guarantee delivery.

Recovery errors retain their underlying error as `cause` and publish one
complete recovery message, including the validated sandbox ID. Durable failed
preparation tells the caller that replaying the same creation key returns the
recorded failure; uncertain outcomes may direct inspection before retrying.
They do not automatically concatenate the underlying message or add downstream
guidance.
