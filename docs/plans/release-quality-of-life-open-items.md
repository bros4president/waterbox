# Waterbox Release Quality-of-Life Open Items

Status: discussion record. This document captures observed problems, current
behavior, alternatives, and open decisions. It does not authorize or prescribe
an implementation.

Date: 2026-09-04

## SQLite Upgrades

### Problem

Package upgrades reuse `~/.waterbox/direct.sqlite`, but a future schema change
could make an existing database unusable.

### Current Behavior

Waterbox creates the current schema in an empty database. For a non-empty
database, it requires an exact schema match and otherwise reports an
incompatible-schema error. It does not currently ship versioned migrations.

### Alternatives

1. Store a separate schema version and ship every forward migration from each
   supported schema version. Apply required migrations in order and inside
   transactions at startup.
2. Keep exact-schema compatibility and require an explicit manual or stepped
   upgrade path when the schema changes.
3. Freeze the schema during the early alpha and introduce migrations before the
   first incompatible schema change.

Open questions include the minimum supported schema, backup policy, failure
recovery, and concurrent-process behavior. Upgrades must never silently erase
or replace user state.

## Automatic Stop And Resume Semantics

### Problem

Users may interpret the configured automatic-stop duration as a total runtime
or spending limit. Coding tools currently resume a stopped sandbox
automatically, so work can continue across multiple provider sessions.

### Current Behavior

Waterbox passes the configured duration to the provider during sandbox
creation. Provider limits, stopping, persistence, and resumed-session duration
remain provider-defined. Waterbox does not resend the configured duration when
resuming. Coding operations ensure the sandbox is running and transparently
resume it when supported; there is no public `resume_sandbox` tool.

### Alternatives

1. Describe the value as a provider-enforced session or automatic-stop request
   and retain transparent resume.
2. Add a separate policy that disables transparent resume or requires explicit
   authorization, making the stop a harder user boundary.
3. Warn or checkpoint near session expiry where remaining lifetime is
   observable, without claiming a provider-independent guarantee.

The agreed direction is to avoid guarantees stronger than the selected
provider's contract. Exact terminology and whether Waterbox needs an additional
resume policy remain open.

## Provider Machine Size

### Problem

Users may need a different CPU or memory class for cost control or demanding
workloads, but machine types and supported sizes are provider-specific. Exposing
raw provider values would weaken the provider-neutral interface, while allowing
an agent to select arbitrary sizes could cause unexpected spending.

### Current Behavior

Machine size is not represented in the public create request, provider port,
local setup, or persisted sandbox resource. The Box and Vercel create adapters
omit provider sizing fields and therefore use each provider's default machine.

### Alternatives

1. Add an owner-configured provider-native default during setup. Every new
   sandbox uses that size, and the agent receives no per-sandbox sizing input.
2. Expose a small canonical Waterbox tier such as `small`, `medium`, or `large`
   and let each adapter map supported tiers to native provider sizes.
3. Permit per-sandbox selection only from an owner-configured allowlist or
   maximum, combining agent flexibility with a spending boundary.
4. Continue using provider defaults until real workloads demonstrate a need for
   explicit sizing.

Open questions include which providers support size selection and restoration,
whether a size belongs to local configuration or the public create contract,
how snapshots interact with size, whether requested and effective size should
be returned, and what happens when a provider changes or rejects a size. The
feature must preserve provider neutrality and cannot let an agent silently
escalate cost. No alternative is selected yet.

## Stop And Resume Guidance

### Problem

`stop_sandbox` says that state remains resumable but does not explain how the
agent resumes work. The missing `resume_sandbox` tool can therefore look like a
capability gap.

### Current Behavior

`stop_sandbox` ends active compute while preserving resumable state, subject to
provider behavior. A later coding-tool call automatically resumes the sandbox.
Status probing and snapshot creation do not implicitly resume it.

### Alternatives

1. Explain automatic resume directly in the `stop_sandbox` tool description.
2. Put the lifecycle rule in MCP server instructions or README guidance.
3. Use both: concise tool-local guidance plus fuller lifecycle documentation.

The behavior is settled; the documentation surface and wording remain open.

## Destructive Deletion Guidance

### Problem

An agent can permanently delete a sandbox whose valuable work exists nowhere
else. The current description says deletion is permanent but does not state the
consequence for sandbox-only work.

### Alternatives

1. Strengthen the `delete_sandbox` description with an irreversible-data-loss
   warning and a reminder to commit, push, or export valuable work first.
2. Add general lifecycle documentation while keeping the tool description
   short.
3. Add a stronger confirmation or approval mechanism if tool descriptions are
   insufficient to prevent accidental deletion.

Warnings should be attached to the destructive operation rather than making
ordinary persistent sandbox use sound ephemeral. The exact mechanism remains
open.

## Agent-Facing Lifecycle Errors And Recovery Guidance

### Problem

Core lifecycle failures often know both what happened and what the agent can do
next. Traditional error propagation carries the failure, but Waterbox does not
currently have a first-class end-to-end channel for safe, actionable recovery
guidance. Useful core detail is flattened before it reaches the agent.

### Current Behavior

Core raises `DomainError` values with a structured code and an internal message.
The API preserves the code but replaces the message with generic public text.
The client retains the code, HTTP status, and request ID, while the MCP renderer
normally exposes only the generic message. Recovery guidance is special-cased
for a recovery sandbox ID rather than represented as a general contract.

### Alternatives

1. Preserve stable error codes end to end and translate each code into safe,
   agent-readable failure and recovery text at the MCP presentation boundary.
2. Add an explicitly public-safe message channel at the core boundary and
   guarantee that its message and recommendation fields survive unchanged
   through API, client, and MCP layers.
3. Use a hybrid structured contract: stable code plus separately modeled safe
   summary and recommended next action, allowing presentation layers to render
   them without parsing prose.

### Safety Invariant

Every field surfaced to an agent or user must be designed and reviewed as
public-safe. It must not expose credentials, provider payloads, private resource
references, implementation details, internal paths, or other sensitive
diagnostics. Private diagnostic information must travel through a separate
non-agent-facing channel.

Open questions include whether recommendations are stable typed actions or
prose, which layer owns their wording, and how clients that do not understand a
new structured field degrade safely. The need for actionable, safe lifecycle
guidance is agreed; the contract remains open.

### Adjacent Issue: Tool-Input Validation

Invalid tool input is not a core lifecycle failure, but it ultimately needs the
same safe downstream message path to the agent. Coding tools currently return a
tool-specific invalid-arguments message, while schema failures for lifecycle
and transfer tools fall through to the generic `Waterbox MCP request failed`
response. Options are to represent validation failures in the shared
agent-facing error contract or retain MCP-local validation messages while
making them consistent across every tool. The classification and rendering
choice remains open.

## Provider Error Granularity Evaluation

### Problem

Provider failures may contain distinctions that would help an agent recover,
but translating every provider's error model into a canonical Waterbox model
would make provider ports, adapters, conformance tests, and public contracts
more complex. It is not yet clear whether that complexity produces enough
additional value after core lifecycle guidance is exposed properly.

### Current Behavior

Provider adapters classify errors primarily for execution safety: definite
failure, limit, ambiguous execution, known state, exact absence, and secure
transfer expiry or consumption. Core uses known observations to reconcile state
but maps most remaining provider distinctions to a generic `provider_failure`.
This is sufficient for many retry-safety decisions but offers limited
provider-specific recovery guidance to an agent.

### Alternatives

1. Keep the provider port deliberately coarse. Use the core agent-facing
   message channel for lifecycle guidance and accept generic provider-failure
   guidance where Waterbox lacks reliable detail.
2. Expand the canonical provider error taxonomy only for distinctions with
   materially different agent recovery actions, such as authentication,
   permission, quota or rate limit, resource absence, conflict, or temporary
   unavailability.
3. Keep a narrow machine-readable taxonomy but allow provider adapters to
   attach explicitly public-safe contextual summaries and recommendations,
   avoiding a separate canonical code for every provider condition.

### Dependency And Decision Status

Defer this decision until the core agent-facing message channel is implemented
and verified end to end. Then evaluate real remaining provider failures and add
granularity only where it changes what the agent should do. The value of richer
provider guidance is recognized, but no port expansion is currently selected.
Any future provider-derived content remains subject to the same public-safety
invariant and must never pass through raw provider payloads.

### Concrete Candidate: Insufficient Provider Funds

Insufficient credits or funds materially changes the agent's next action: the
service is not broken, and retrying cannot help until the user funds the provider
account or selects another provider. This distinction is not currently preserved.
The Box adapter reads bounded error details but, outside named-snapshot quota
detection, reduces them to an HTTP failure. The Vercel adapter discards error
bodies and recognizes only HTTP 429 as a generic provider limit. Core then
reduces those outcomes to generic `provider_failure` or `provider_limit` text.

### Decision

Waterbox should surface an actionable, public-safe insufficient-funds message
when a supported provider exposes a reliable signal for that condition. The
guidance should explain that Waterbox is not broken and that the user must fund
the provider account or select another provider before retrying.

This is deliberately a narrow product decision, not a commitment to translate
each provider's complete error model. Provider-specific mappings can expand
without bound and would increase adapter and conformance-test complexity. Only
high-value conditions that materially change the next action should be
considered, and unknown conditions must continue to degrade to the safe generic
provider failure. The representation—canonical code, safe contextual guidance,
or both—remains an implementation choice. Recognition must use reliable
provider signals and preserve the distinction between definite pre-dispatch
rejection and uncertain post-dispatch outcome.

## MCP Tool Annotations

### Problem

Waterbox does not publish the optional standard MCP annotations that help
clients and agents distinguish inspection, mutation, destructive behavior,
idempotency, and open-world interaction. Without annotations, MCP's conservative
defaults describe tools as not read-only, potentially destructive, not
idempotent, and open-world.

### Current Behavior

Every Waterbox tool publishes a name, description, and input schema. Only
`bash` additionally publishes an output schema. No tool currently supplies
`readOnlyHint`, `destructiveHint`, `idempotentHint`, or `openWorldHint`.

### Alternatives

1. Classify every tool and publish all applicable annotations, with tests that
   keep the metadata aligned with behavior.
2. Start with only unambiguous classifications, such as read-only file search
   and explicit deletion, leaving subtle provider-backed operations at their
   conservative defaults.
3. Keep descriptions as the only behavioral guidance and omit annotations.

Annotations are advisory hints, not authorization or security enforcement.
Provider reads may still reconcile local state, and operations such as snapshot
creation may have provider-specific source effects, so classifications require
careful review rather than inference from tool names. The improvement appears
valuable and mechanically small; exact per-tool annotations remain open.

## MCP Server Instructions

### Problem

Individual tool descriptions do not give an agent a shared mental model of how
the tools fit together. Waterbox currently has no server-level instructions, so
agents must infer cross-tool lifecycle rules such as automatic resume, stopping
versus snapshotting, and preserving valuable output before deletion.

### Current Behavior

The MCP SDK used by Waterbox supports an optional server `instructions` string,
but Waterbox initializes the server without one. Some lifecycle guidance exists
in tool descriptions and project documentation, but clients are not guaranteed
to place that material in the agent's context as a coherent operating model.

### Alternatives

1. Add concise server instructions containing only stable, cross-tool rules and
   keep operation-specific preconditions and warnings in tool descriptions.
2. Add a more complete server-level usage guide, accepting greater context cost
   and duplication with tool descriptions and documentation.
3. Keep server instructions minimal or absent and publish a separate skill for
   richer, conditional Waterbox workflows.
4. Use a layered approach: essential portable semantics in server and tool
   metadata, with an optional skill for detailed workflows, examples, scripts,
   or provider-specific guidance.

There is no word-count requirement in the SDK contract. The instructions should
be judged by whether every connected agent needs the content on every session,
not by a fixed size threshold. Essential safety and lifecycle semantics must not
exist only in a host-specific skill. Exact content, size, and whether Waterbox
also benefits from an optional skill remain open.

## Snapshot Preconditions And Source Outcome

### Problem

The sentence "It never implicitly resumes a sandbox" does not clearly identify
the source sandbox or distinguish pre-snapshot and post-snapshot behavior. The
tool result also does not tell the agent whether the provider left the source
sandbox running or stopped it.

### Current Behavior

Snapshot creation requires the source sandbox to be running. Core and both
current provider adapters reject a stopped source instead of resuming it. A
provider may stop the source as part of snapshot creation; Waterbox can apply
that provider observation internally, but the public `create_snapshot` result
contains only the snapshot.

### Alternatives

1. Clarify only the description: a stopped source is rejected without resume,
   and a provider-stopped source is left stopped.
2. Return a compound result containing both the snapshot and the reconciled
   source sandbox state.
3. Keep the result stable and tell the agent to call `probe_sandbox` afterward.

If a snapshot succeeds but source-state observation fails, the successful
mutation must not be reported as an overall failure that encourages an unsafe
retry. The response could instead mark source state as unavailable. The public
contract remains open.

## Everyday Lifecycle: Stop Versus Snapshot

### Problem

The tools expose mechanics but do not teach their distinct roles. An agent may
create routine snapshots merely to pause work, or treat provider-managed
sandbox storage as the ultimate system of record.

### Intended Mental Model

- Use one sandbox as the working instance for a task.
- Use `stop_sandbox` to pause that instance and reuse it later. Normal coding
  calls resume it automatically.
- Use snapshots sparingly as named, described, reusable setup or templates from
  which future sandboxes can be created. They are not the ordinary pause
  mechanism.
- Consider `list_snapshots` before starting project work when an existing
  reusable setup may exist. If a request is ambiguous, distinguish creating a
  fresh sandbox from creating one from an existing snapshot.
- Persist valuable final output outside the sandbox before deletion. Provider
  retention and persistence guarantees differ, even though Waterbox sandboxes
  are designed to be persistent and resumable.
- Do not casually bake credentials or other secrets into reusable snapshots.

### Alternatives

1. Encode this model in MCP server instructions so every agent receives it.
2. Put the distinctions primarily in lifecycle tool descriptions.
3. Add a README lifecycle section for users and keep tool descriptions concise.
4. Combine all three with each surface carrying only the detail appropriate to
   it.

The intended distinction is agreed; placement, wording, and how prescriptive
the agent guidance should be remain open.

## npm Release Channel

### Problem

The public `latest` and `next` tags currently both point to
`0.1.0-alpha.1`, while the package configuration publishes new releases to
`next`. Publishing alpha.2 without correcting the channel would leave the
default installation on the older alpha.1 release.

### Alternatives

1. Publish alpha.2 to `latest`, making an unqualified install select the current
   alpha release.
2. Publish alpha.2 only to `next` and remove or otherwise correct the accidental
   stale `latest` tag, requiring an explicit prerelease channel.
3. Keep both tags but move them together for alpha.2.

The current tag state was accidental. The intended channel policy remains open
for discussion; no npm tag change is authorized yet.
