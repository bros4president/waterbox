# Runtime Separation and Remote Execution Research

> Status: research and discussion only. This document records observations and open questions; it does not establish product or implementation decisions.

Date: 2026-08-23

## Problem Context

The original experiment replaced local coding-agent tools with remote equivalents so the agent behaved as though it were operating inside an AWS Lambda MicroVM. That approach exposed a broader scaling question: how can an agent system hold many horizontally scalable sessions without one permanently large central machine?

Two broad arrangements were discussed:

1. A central session store consumed by distributed agent runtimes, each close to its execution environment.
2. A central agent runtime close to its session store, delegating workspace operations to distributed execution environments.

The OpenCode integration was an attempt at the second arrangement through tool replacement. Codex contains a more explicit execution-environment boundary.

## Four Useful Layers

The discussion began with three layers, but remote execution is useful enough to model separately:

1. Session and state persistence
2. Agent orchestration: history, prompts, inference, tool routing, approvals, and hooks
3. Execution substrate: processes, filesystem, sandbox, and network
4. Presentation: TUI, web, IDE, or another client

Most coding agents do not expose all four as independently replaceable services.

## Observed Project Boundaries

### OpenCode 2

- The server owns session persistence and the agent runtime.
- The TUI can attach to the server, giving it a clean presentation boundary.
- Native tools and plugin tools are part of the server/runtime process.
- The `oc-remote` experiment replaced local tools with project-plugin tools backed by a MicroVM.
- Sharing the same sandbox with subagents was difficult because sandbox ownership lived in plugin/runtime state rather than an explicit execution-environment identity.

### Codex

Codex exposes two relevant server boundaries:

```text
TUI / IDE / custom client
            |
            | app-server protocol
            v
Codex app-server
  - threads and session history
  - model interaction and agent loop
  - tool routing, approvals, hooks
            |
            | exec-server protocol
            v
Codex exec-server environment
  - process and PTY management
  - stdout/stderr and stdin
  - filesystem operations
```

Current source observations:

- The TUI accepts `--remote ws://...` or `--remote wss://...` and can authenticate with a bearer token sourced from an environment variable.
- `app-server` can listen over stdio, Unix sockets, or WebSocket.
- Ordinary Codex session rollouts are stored on the machine running app-server under `CODEX_HOME`, primarily as rollout JSONL plus local SQLite state.
- OpenAI receives context for inference but is not the authoritative resumable store for ordinary self-run app-server threads.
- `EnvironmentManager` can contain multiple execution environments.
- Threads can select sticky environments; turns can override environment selection.
- The first selected environment acts as the primary environment when a tool call omits an environment.
- Multiple threads can share an environment, or each thread can receive its own environment.
- Remote app-server and per-thread environment surfaces still include experimental APIs.

Codex therefore supports the spirit of arrangement 2: state and orchestration can remain together while execution runs close to an independently provisioned workspace.

### Pi

- Pi is designed for dependency injection and extension more than for separate network services.
- Its message/session storage can be replaced by an application integration.
- A distributed deployment still needs external concurrency control or distributed locking.
- This is a meaningful step toward arrangement 1, although it is not a turnkey hosted session-store protocol.

## General Remote Sandbox Service Discussed

A harness-neutral service could expose an opaque `sandbox_id` and operations against it:

```text
create_sandbox
get_sandbox
list_sandboxes
terminate_sandbox

bash
read_file
write_file
edit_file
apply_patch
list_directory
glob
grep
```

Every workspace operation would take an explicit sandbox ID. A root agent could pass that ID to subagents in the same way it passes a working directory or repository identity. This removes the need for harness-specific tool-state inheritance.

The model-visible ID must not be the authorization boundary. Possible controls include opaque IDs, tenant-scoped authentication, sandbox-scoped capability tokens, quotas, maximum lifetimes, and platform-enforced cleanup.

A small control-plane store would still be required for provider identifiers, state, ownership, endpoint/token references, and expiry. This would not be the agent sessions database.

## Interface Options Discussed

### Direct HTTP API

- Natural canonical service boundary.
- Straightforward for SDKs, CLIs, and non-agent consumers.
- SSE or NDJSON can stream one-way process output.
- WebSocket or process resources are needed for bidirectional PTY interaction.

### HTTP MCP

- Gives MCP-capable harnesses model-visible tools without harness-specific output adaptation.
- MCP `content`, `structuredContent`, and error semantics are close to the typed-output architecture found in OpenCode v2.
- Registration and trust remain adoption friction even when no local MCP process is installed.

### CLI and Skill

- Broadest initial compatibility because most agents can call a CLI through their shell tool.
- A skill can teach lifecycle and command syntax.
- This is convention rather than enforcement: the harness may still expose its local shell and filesystem.

The discussed direction was to keep REST and MCP thin over one canonical domain/tool implementation. No interface choice has been finalized.

## Lifecycle Considerations

Agents may create and terminate sandboxes, but infrastructure cannot depend on the model remembering cleanup. Relevant mechanisms include:

- Idempotent creation
- Idle suspension
- Absolute lifetime limits
- Explicit termination
- Automatic expiry
- Quotas and concurrency limits
- Optional process and sandbox leases
- Recovery through `get_sandbox` or `list_sandboxes`

Long-running process support may eventually require separate operations such as `start_process`, `read_process`, `write_process`, and `signal_process`. A bounded synchronous `bash` operation is simpler for an initial contract.

## Open Questions

- Should one sandbox normally belong to a thread, a user, a project, or an explicit capability?
- Should subagents receive the same sandbox capability automatically or only through explicit instructions?
- How should concurrent mutations from multiple agents be serialized or versioned?
- Is the workspace ephemeral until termination, or should snapshots be first-class?
- Which operations need bidirectional streaming rather than request/response?
- Should the first distribution be a CLI and skill, HTTP MCP, or both?
- How much local-tool enforcement is required versus simply making remote execution convenient?
- Can Codex `exec-server` be used directly as an execution backend, or is a smaller provider-neutral protocol preferable?
- How should credentials and egress policy be scoped per sandbox?

## Source Snapshot

The Codex observations were made against `openai/codex` commit `c9b19deb09c1841ce7acc33ddb96276030936a29`. Important source areas include:

- `codex-rs/app-server`
- `codex-rs/app-server-client`
- `codex-rs/app-server-protocol`
- `codex-rs/exec-server`
- `codex-rs/exec-server-protocol`
- `codex-rs/core/src/tools`
