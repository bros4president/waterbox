# Waterbox MCP npm Launch V0

Status: implementation in progress. Phase 8 credential-free package, endpoint-safety, legal, documentation, and exact-artifact closure is complete. Phase 9 workflow implementation and hosted CI are complete, but protected-environment and trusted-publisher validation remain pending. Phase 10 alpha publication remains pending.

This is the durable launch plan for publishing the supported local Waterbox MCP as the unscoped npm package `waterbox`, making `npx add-mcp waterbox@next` the primary alpha installation path, removing Bun and per-account Box system snapshots from the runtime requirements, and adding a controlled npm release process.

Waterbox is prelaunch. The package and runtime changes in this plan replace the unpublished `@waterbox/mcp` package and `waterbox-system-v6` bootstrap directly. Do not add compatibility aliases, migrations, deprecation packages, or preservation machinery for artifacts that have never been publicly released.

## How To Use This Plan

An implementation agent assigned a phase must:

1. Read this entire plan and every prerequisite phase.
2. Inspect the current worktree and preserve unrelated or concurrent changes.
3. Implement only the assigned phase and its acceptance criteria.
4. Run focused verification, repository-wide tests, typecheck, and diff checking where applicable.
5. Update the phase status and append a short implementation-log entry with verification facts.
6. Stop at the phase boundary.

Do not reinterpret settled requirements inside a phase. If provider behavior, Node behavior, npm behavior, or an external registry contract contradicts this plan, record the exact blocker and stop instead of adding an unsafe fallback.

No live provider mutation is authorized merely by this document. Every live capability probe and smoke run remains separately credentialed, explicitly authorized, isolated-account gated, bounded, and cleanup-reconciled.

## Launch Objective

The package launch is successful when a new user can run:

```sh
npx add-mcp waterbox@next
```

and receive a valid local stdio MCP configuration whose process:

- Runs on Node.js 24 without Bun installed locally.
- Connects successfully even before a provider is configured.
- Explains provider setup without accepting secrets through model-visible tool arguments.
- Uses an explicitly selected user-owned provider after credentials are supplied through native-keyring onboarding or the MCP client's environment or secret mechanism.
- Creates a fresh sandbox with either explicitly configured launch provider, Box or Vercel Sandbox, without a Waterbox system snapshot.
- Reinstalls the current Waterbox one-shot CLI when creating from a supported provider user snapshot where that provider advertises snapshots.
- Persists the provider resource identity before preparation/bootstrap starts, while retaining the acknowledged provider-return/result-persistence failure interval.
- Publishes from a reviewed Git commit through a reproducible, tested npm tarball.

The launch command installs configuration. It does not silently choose a provider or acquire credentials.

## Settled Decisions

### Product And Package

- The public npm package name is `waterbox`.
- The package has one public executable named `waterbox`.
- The package is CLI-only in V0. It has no public JavaScript `exports` entry and ships no declarations.
- `npx add-mcp waterbox@next` is the primary advertised alpha installation command.
- The supported server remains a local Node stdio MCP with no listener: MCP renderer -> private `@waterbox/client` -> authenticated in-process Fetch `ApiBackend` -> `@waterbox/api` -> core -> SQLite/provider.
- `@waterbox/control-plane-local` owns embedded core, repository, and provider composition. Its embedded bearer is process-private; synthetic URLs are in-process Fetch routing, not network traffic. A remote `ApiBackend` seam does not imply hosted Waterbox exists.
- Waterbox remains provider-neutral. Box and Vercel Sandbox are the launch-supported providers, neither is an implicit default.
- Missing provider configuration is a connected setup state, not a process startup failure.
- Provider credentials are supplied by the user through environment or client-specific secret facilities, or by the bounded native-keyring onboarding flow: `npx waterbox@next setup`, `npx waterbox@next status`, and `npx waterbox@next logout`.
- Native onboarding stores only Box API keys and Vercel tokens under keyring service `waterbox`; strict versioned non-secret provider settings are atomically stored in `~/.waterbox/config.json`. Persisted records allow only `https://ascii.dev/api/box/v1` and `https://api.vercel.com/` with approved defaults, preventing redirected keyring credentials; custom endpoints remain environment-only. Environment-only configuration remains the sole fallback, `.env` is never loaded implicitly, and headless Linux Secret Service/keyutils availability remains an operational durability caveat.
- Credentials are never accepted through MCP tool arguments, returned in MCP content, or written to ordinary diagnostics.

### Runtime

- The local MCP runtime is Node.js 24.
- The in-sandbox one-shot CLI runtime is Node.js 24.
- The minimum supported Node version is `24.15.0`, where `node:sqlite` is release-candidate quality.
- CI and release builds should test a current Node 24 patch in addition to the declared minimum where practical.
- Bun may remain repository-only build or test tooling temporarily. Bun is not required by npm consumers or created Boxes.
- The local repository uses `node:sqlite`; no native npm SQLite addon is introduced.
- The Box base image's documented Node 24 and ripgrep installations are used instead of downloading Bun or installing packages with apt.

### Sandbox Provisioning

- One public `create_sandbox` action covers the existing provider create operation followed by Waterbox runtime preparation.
- The public sandbox is `provisioning` while provider creation runs, `preparing` after the provider resource is known while Waterbox installs, and `running` only after health verification succeeds.
- Fresh Box creation omits `from` and does not require a named system snapshot.
- Creation from a Waterbox user snapshot uses that snapshot as the Box source, then installs the current Waterbox runtime over any inherited version.
- Stop and resume preserve the installed runtime according to Box's documented filesystem behavior. Resume does not automatically upgrade an existing sandbox in V0.
- Every supported provider implements preparation. A future provider may use a different preparation mechanism, but provider readiness alone must never make a sandbox usable.

### Safety And Release

- MIT is the project license for the public package.
- Release attribution uses `Waterbox contributors`.
- The npm tarball includes the project license, project notice, and notices required by embedded dependencies and adapted code.
- npm publication uses a controlled GitHub Actions workflow with npm trusted publishing, OIDC, and provenance.
- The exact tarball is tested after packing and before publication.
- Official MCP registry publication and add-mcp catalog discovery are separate from direct npm installation and do not block V0.
- The final official MCP registry name is deferred until a project domain is selected and controlled. Reverse-DNS naming has no bearing on `npx add-mcp waterbox@next`.

## Non-Goals

Do not add in this launch:

- A managed Waterbox Cloud provider.
- A hosted streamable-HTTP or SSE MCP transport.
- Provider-specific browser authentication embedded in the generic MCP.
- Custom OS-specific credential-store adapters or a general-purpose Waterbox credential vault.
- Plaintext credential persistence or a fallback credential file.
- Secret entry through chat, MCP tools, shell arguments, or committed configuration.
- An npm alias or forwarding package for `@waterbox/mcp`.
- A public library API from the `waterbox` package.
- Hosted Waterbox or a network listener in the supported MCP process.
- A daemon inside Box.
- An HTTP receiver inside Box.
- A systemd service for ordinary tool execution.
- A shared Waterbox system snapshot.
- apt-based bootstrap.
- Automatic upgrade on resume.
- Blind retries of user commands, secure-transfer consumption, snapshot mutations, or other ambiguous user operations.
- Official MCP registry publication before namespace ownership is settled.
- Complete migration of all repository development tooling from Bun to Node unless required to produce or verify the release.

## Launch Architecture

```text
MCP client
    | stdio: npx -y waterbox@next
    v
thin MCP renderer
    -> private @waterbox/client
    -> authenticated in-process Fetch ApiBackend
    -> @waterbox/api
    -> core -> SQLite repositories -> selected provider registry entry
```

`@waterbox/control-plane-local` composes the embedded API, core, repositories, selected provider, and process-private bearer. The supported MCP has no network listener; synthetic request URLs never leave the process. Its remote `ApiBackend` seam is a product boundary and test seam, not a hosted-service commitment.

The one-shot CLI remains the execution boundary inside full-Linux sandboxes:

```text
Box command API
    -> /usr/local/bin/waterbox
    -> /usr/local/bin/node /usr/local/lib/waterbox-cli.js
    -> canonical invocation
    -> one canonical result
```

There is no resident Waterbox process inside Box.

## Package Contract

### Manifest

The publishable package manifest must have this effective shape:

```json
{
  "name": "waterbox",
  "version": "0.1.0-alpha.1",
  "private": false,
  "type": "module",
  "description": "Run coding tools in isolated, stateful sandboxes through MCP.",
  "bin": {
    "waterbox": "./dist/waterbox.js"
  },
  "engines": {
    "node": ">=24.15.0"
  },
  "license": "MIT",
  "author": "Waterbox contributors",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/bros4president/waterbox.git",
    "directory": "packages/mcp"
  },
  "homepage": "https://github.com/bros4president/waterbox#readme",
  "bugs": {
    "url": "https://github.com/bros4president/waterbox/issues"
  },
  "keywords": [
    "mcp",
    "model-context-protocol",
    "sandbox",
    "coding-agent",
    "ai-agent",
    "stdio"
  ],
  "publishConfig": {
    "access": "public",
    "tag": "next"
  }
}
```

Exact descriptions and keywords may be tightened during implementation, but metadata must remain factual and must not claim unsupported providers or managed hosting.

### Tarball Contents

The package allowlist must contain only release inputs:

```text
dist/waterbox.js
dist/waterbox-cli.js
README.md
LICENSE
THIRD_PARTY_NOTICES.md
package.json
```

`server.json` may remain in the repository while official registry publication is deferred. Do not ship metadata with an unowned or knowingly incorrect registry namespace. Add it to the tarball only when its namespace, package identifier, version, environment declarations, and publication path are valid.

Because npm cannot pack files from outside the workspace package automatically, the package directory must contain synchronized release copies of `LICENSE` and `THIRD_PARTY_NOTICES.md`. A release check compares each package-local file byte-for-byte with its canonical root source and fails on a missing or stale copy. Do not rely on npm traversing to repository-root legal files.

The internal `dist/waterbox-cli.js` artifact is package data used for provider bootstrap. It is not a public npm executable or export.

`@waterbox/client` and `@waterbox/control-plane-local` are private workspace packages. They are bundled into `dist/waterbox.js`, are not separately published, and expose no public package API or source-package contract to npm consumers.

### Entry Point

The npm bin file must begin with:

```text
#!/usr/bin/env node
```

With zero arguments, the bin entry invokes MCP `main()` and must not depend on direct-entry equality between `import.meta.url` and npm's symlinked `process.argv[1]`. Explicit supported arguments dispatch terminal-only onboarding commands (`setup`, `status`, and `logout`) instead; unknown arguments never start MCP.

The executable emits no non-MCP stdout. Startup errors and optional diagnostics use stderr only and never include credentials, provider references, commands, local file content, response bodies, or protected URLs.

## Provider Configuration Contract

### Unconfigured Startup

The MCP process must connect when `WATERBOX_PROVIDER` is absent or unsupported configuration is incomplete.

The unconfigured backend:

- Registers the normal supported tool surface.
- Does not initialize SQLite or any concrete provider unnecessarily.
- Returns stable setup guidance from lifecycle and operation calls.
- Lists both launch-supported provider names and only their settled configuration variable names.
- Never asks the model to provide a secret as a tool argument.
- Does not pretend either configured provider is selected.
- Performs no local file read, SQLite initialization, provider request, artifact load, provider API call, or other operation side effect before returning setup guidance.

The setup guidance for Box identifies:

```text
WATERBOX_PROVIDER=box
BOX_API_KEY=<configured through the MCP client's environment or secret mechanism>
```

The package README provides client-specific examples for supported clients without placing a real key in command history or committed project configuration.

The completed Vercel audit established official external-hosting access-token configuration. The supplementary implementation plan settles `WATERBOX_PROVIDER=vercel`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`; setup guidance may render those names only after its side-effect-free composition phase lands. OIDC remains deferred unless that plan is amended with tested local refresh behavior.

### Configuration Precedence

V0 configuration is either explicit environment configuration or bounded local native-keyring onboarding:

1. When `WATERBOX_PROVIDER` is explicit, resolve that provider entirely from process environment; never mix persisted fields or a keyring secret.
2. When it is absent, resolve the strictly validated persisted provider settings plus that provider's keyring secret.
3. Provider-specific environment variables without `WATERBOX_PROVIDER` are a selection error, not an implicit provider or a mixed configuration.
4. Documented non-secret defaults for provider endpoints and timing only; `WATERBOX_SQLITE_PATH` remains global.

Waterbox does not read provider CLI login state, browser cookies, unrelated dotfiles, or provider-specific credential stores in V0. It reads only its dedicated `waterbox` keyring entries and versioned non-secret configuration file.

Provider selection is parsed before provider-specific fields. Unknown providers receive a stable unsupported-provider message. Missing credentials leave the MCP connected and produce setup guidance. Malformed non-secret configuration may reject provider initialization but must not corrupt MCP stdout.

### add-mcp Limitation

Direct `add-mcp` package installation does not read package-specific `server.json` metadata and does not execute Waterbox during installation. The launch research baseline is `add-mcp@2.3.0`; it writes an MCP command equivalent to:

```json
{
  "command": "npx",
  "args": ["-y", "waterbox@next"]
}
```

The docs must therefore distinguish installation from provider configuration. Do not claim that `npx add-mcp waterbox@next` collects credentials.

CI and release evidence pin an explicit reviewed `add-mcp` version. The user-facing package selector remains `waterbox@next` while the release is an alpha; the stable `latest` channel is not assigned. Advancing the certified installer version requires a reviewed dependency update and rerunning configuration-generation tests rather than silently testing whatever `latest` resolves to.

## Node Runtime Migration

### Local MCP

Required changes:

- Change the MCP source shebang to Node.
- Build a Node-targeted ESM bundle.
- Replace `bun:sqlite` with `DatabaseSync` from `node:sqlite`.
- Replace Bun `Database.query()` with Node `DatabaseSync.prepare()`.
- Map `readonly` to `readOnly`.
- Preserve create-if-missing behavior explicitly where the repository contract requires it.
- Preserve current `PRAGMA foreign_keys = OFF` behavior by setting `enableForeignKeyConstraints: false` and retaining the explicit pragma where useful.
- Keep integer reads as numbers and test `run().changes` behavior.
- Preserve existing SQLite file format and reopen compatibility.
- Verify Web Crypto, Web Streams, X25519, and secure-transfer encryption at the declared minimum Node version.
- Execute configured fake-provider/client/API/SQLite flows through the embedded Fetch architecture under Node 24.15.0 and a current Node 24 patch; syntax checks alone are insufficient.

No native addon, postinstall compilation, or platform-specific SQLite package is allowed.

### In-Sandbox CLI

Required changes:

- Build the one-shot CLI as a Node-targeted ESM bundle.
- Replace hard-coded Bun worker execution with `/usr/local/bin/node`.
- Replace production `Bun.spawn` calls used for secure-transfer expiry scheduling and cancellation with bounded Node child-process helpers.
- Preserve direct detached child-process behavior, process groups, signal handling, output bounds, file permissions, and terminal status semantics.
- Preserve `health`, `version`, canonical `run`, secure transfer, Bash observation, and Bash cleanup modes.
- Preserve the current protocol version unless an actual protocol shape changes.
- Verify that the Node bundle has no `bun:`, `Bun.`, `// @bun`, or Bun shebang references.

Most sandbox runtime production paths already use Node child-process and filesystem APIs. The remaining production Bun calls, including secure-transfer `systemd-run` and `systemctl` spawning, must be migrated explicitly. Test-only `Bun.sleep`, `Bun.file`, and `bun:test` usage may remain until a separate tooling migration, but release verification must execute the built artifacts with Node.

### Supported Node Line

As of August 30, 2026:

- Node 24 is LTS and is the production target.
- Node 26 is Current and is not the primary release target.
- Node 22 remains LTS but is not the selected V0 floor.

Release CI must not silently advance the declared major. A future Node-major change requires its own compatibility decision and release note.

## Provider-Neutral Creation Semantics

### Public Semantics

`create_sandbox` remains one request and one Waterbox resource:

```text
reserve idempotency key
create Waterbox provisioning record
run the existing provider create operation
persist its returned provider reference as preparing
run mandatory provider preparation
verify Waterbox runtime
mark running
complete idempotency record
return sandbox
```

The caller does not see a separate bootstrap resource or action.

### Provider Contract

The existing provider create operation remains the creation reliability boundary. Every supported provider exposes a cohesive preparation operation:

```ts
interface SandboxProvider {
  readonly name: string
  createSandbox(input: ProviderCreateSandboxInput): Promise<ProviderSandboxObservation>
  prepareSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  inspectSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  deleteSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  executeTool<N extends ToolName>(input: ProviderExecuteInput<N>): AsyncIterable<ToolEventByName[N]>
  // stopResume?, snapshots?, secureFileTransfer?, and bashJobs? remain optional capability groups
}
```

Exact names may follow repository conventions, but these semantics are mandatory:

- `createSandbox` retains its current provider-specific behavior and reliability. This phase does not split allocation from readiness or add create replay, list-diff reconciliation, or stronger provider acceptance guarantees.
- When `createSandbox` returns, core persists its opaque provider reference and transitions the Waterbox record to `preparing` before calling preparation.
- Preparation is safe to call again for the same resource and desired artifact version.
- A provider without preparation is not supported; core has no compatibility branch that bypasses `preparing`.
- Core remains independent of Box artifact paths and installation commands.
- Provider live status cannot promote a `preparing` Waterbox record to `running`; only successful preparation and Waterbox health verification can do that.
- `stopResume` and `snapshots` remain optional cohesive capability groups. The approved supplementary implementation targets both groups for Box and Vercel, so each provider must pass the optional gates it advertises; this does not make the groups mandatory for every future launch provider.
- Existing optional secure-transfer and Bash-job groups remain optional with their current status; this plan neither promotes nor removes them.
- Unsupported optional capabilities fail before public-ID allocation or persistence and before provider dispatch, under the existing behavior.

### Core Durability

Core must support these records during creation:

```text
providerRef = null, state = provisioning
providerRef = <opaque>, state = preparing
providerRef = <opaque>, state = running
providerRef = <opaque>, state = failed
```

Rules:

- The provider-create/result-persistence interval remains unchanged. The approved supplementary provider plan may make the provider-neutral correction that an adapter-reported ambiguous dispatched mutation is not discarded by a racing caller abort; it does not add create replay or invent a provider reference.
- A provider reference is never cleared after it has been persisted.
- Cancellation or process loss after the `preparing` checkpoint preserves the record and in-progress idempotency reservation.
- Reusing the same public idempotency key resumes only a `preparing` record with a persisted provider reference; it does not introduce a new provider-create retry path.
- A definite preparation failure stores a failed sandbox with its provider reference and a safe public error.
- A failed or preparing sandbox with a provider reference remains deletable.
- Ordinary post-checkpoint failure must surface the public sandbox record or stable public sandbox ID so the caller can recover or delete it.
- A transport cancellation after the checkpoint can prevent a response; same-key replay is the preparation recovery path.
- Tool execution, secure transfer, and snapshot creation require `running`; lifecycle actions retain their existing state guards, and `preparing` is observable and deletable but not otherwise usable.
- `probe_sandbox` may inspect the provider while the record is `preparing`, but a provider-ready observation leaves the public state `preparing` until preparation succeeds.

The existing behavior that returns `idempotency_in_progress` forever for every in-progress record changes only for `preparing`: same-key replay resumes preparation. A `provisioning` record with no provider reference keeps the existing create semantics and is not automatically replayed by this launch work.

### Concurrency

V0 local MCP is one local process, but correctness must not rely only on a process-local flag:

- Preparation must be intrinsically idempotent for the same artifact digest.
- Compare-and-swap updates preserve one authoritative Waterbox record.
- A process-local single-flight may reduce duplicate preparation but is not the correctness boundary.
- Concurrent preparation must either converge safely or one caller must observe in-progress state without corrupting installation.

Do not add a general job queue, distributed scheduler, or background reconciler for V0.

## Box Bootstrap Design

### Preconditions

Box's public documentation states that every plain Box includes:

- Linux x86_64.
- Node.js 24 linked into `/usr/local/bin` for non-login shells.
- `rg`.
- Bash and normal development utilities.

A separately authorized live capability probe must verify the exact paths and behaviors Waterbox relies on before the system snapshot is removed.

### Allocation

Fresh Box request:

```json
{
  "noEnv": true,
  "env": {
    "WATERBOX_SANDBOX_ID": "<public Waterbox sandbox ID>"
  }
}
```

Snapshot-sourced Box request:

```json
{
  "from": "<provider-owned user snapshot reference>",
  "noEnv": true,
  "env": {
    "WATERBOX_SANDBOX_ID": "<public Waterbox sandbox ID>"
  }
}
```

The request retains the existing Box create behavior. This plan does not depend on provider-side idempotency, automatic create replay, or before/after list correlation. The Box account API key is never injected into the Box.

### Artifact

The MCP package loads the immutable Node CLI bundle relative to the installed package and injects it into local control-plane composition. `@waterbox/control-plane-local` never discovers or builds the artifact, and the shared local package does not read ambient paths.

The provider receives an injected artifact object conceptually equivalent to:

```ts
interface SandboxRuntimeArtifact {
  bytes: Uint8Array
  sha256: string
  cliProtocolVersion: 2
  artifactVersion: string
}
```

The provider does not read arbitrary ambient paths. Artifact bytes and hashes are never logged.

### Installation

After Box readiness:

1. Upload the bundle as Base64 to a deterministic path under `/tmp` containing or associated with the expected digest.
2. Validate the correlated Box `file.written` response and exact byte count.
3. Run an idempotent installation command with a bounded timeout.
4. Copy the upload into a root-owned mode-`0600` staging file and check that exact staged file's SHA-256 with the documented Node runtime.
5. Publish the verified staged bundle atomically as `/usr/local/lib/waterbox-cli.js`.
6. Install the launcher atomically as `/usr/local/bin/waterbox` with mode `0755`.
7. Create `/home/user/workspace` with the intended user ownership.
8. Create `/run/waterbox/bash-jobs` with mode `0700`.
9. Write `/usr/local/lib/waterbox-bootstrap.json` last through atomic replacement.
10. Verify the manifest, `waterbox health`, `waterbox version`, `node --version`, and `rg --version`.

The launcher uses Node:

```sh
#!/bin/sh
set -eu
sudo -n install -d -m 0755 -o "$(id -u)" -g "$(id -g)" /home/user/workspace
sudo -n install -d -m 0700 /run/waterbox/bash-jobs
cd /home/user/workspace
exec sudo -n env WORKSPACE_ROOT=/home/user/workspace /usr/local/bin/node /usr/local/lib/waterbox-cli.js "$@"
```

The exact quoting and privilege boundaries require tests. No secret is embedded in the launcher or manifest.

### Manifest

The bootstrap manifest contains only non-secret compatibility facts:

```json
{
  "schemaVersion": 1,
  "artifactSha256": "<lowercase SHA-256>",
  "artifactVersion": "0.1.0-alpha.1",
  "cliProtocolVersion": 2,
  "nodeMajor": 24,
  "bootstrapVersion": 1
}
```

The manifest is the read-only completion signal after an ambiguous installation response. Reconciliation also hashes `/usr/local/lib/waterbox-cli.js` and requires the installed bytes to match `artifactSha256`; the manifest alone is not an integrity proof. It is not a provider credential or Waterbox repository record.

### Ambiguity

Bootstrap has a distinct retry policy from user commands:

- Provider-create ambiguity retains the current behavior and is not retried or reconciled by bootstrap logic.
- Lost artifact upload may repeat the exact write to the same deterministic temporary path or verify the path before repeating.
- Lost installation response triggers read-only manifest and health verification first.
- If verification proves the desired digest and protocol, preparation succeeds.
- If verification proves an incomplete installation, the explicitly idempotent installer may run again.
- If verification remains uncertain, the sandbox remains `preparing` with its provider reference.
- User tool commands remain one-shot and are never retried by this bootstrap policy.

### Forks, Snapshots, And Resume

- Every new Box created from a Waterbox snapshot receives the current runtime installation.
- User filesystem content from the snapshot remains authoritative outside Waterbox-owned runtime paths.
- Installation may overwrite only Waterbox-owned paths under `/usr/local/lib`, `/usr/local/bin/waterbox`, and `/run/waterbox`.
- `/home/user/workspace` is recreated because Box named snapshots preserve `/home/user` rather than a root-level workspace.
- `/run` jobs and secure-transfer identities are runtime state and are not restored.
- Stop/resume retains installed files and packages according to Box documentation.
- Existing stopped sandboxes are not upgraded merely because a newer npm package starts locally.

## Error, Cancellation, And Cleanup Semantics

### Before Provider Create Returns

- Validation, provider selection, credential, ownership, limit, and definite create rejection errors may fail normally.
- No new create retry or list-reconciliation behavior is introduced.
- Provider-create rejection, ambiguity, cancellation, and result-persistence gaps retain the current semantics.

### After The Preparing Checkpoint

- The provider create operation has returned, and core has persisted its provider reference before uploading or installing files.
- Never convert a preparing resource back to `providerRef: null`.
- Cancellation preserves recoverable `preparing` state.
- Definite bootstrap failure stores failed state and a safe error while preserving deletion capability.
- Unresolved bootstrap ambiguity preserves `preparing` state and in-progress idempotency.
- A failed response must not expose provider IDs, API keys, commands, response bodies, request IDs, or temporary paths.

### Product-Boundary Serialization

- Preparation, recovery, and cancellation semantics cross API serialization and client parsing; they are not direct MCP/core shortcuts.
- The canonical `error.sandboxId` is validated by the client and becomes the caller recovery ID. Invalid or absent values never become recovery handles.
- Create replay remains caller-controlled. The client and MCP renderer do not invent replay keys or retry ambiguous create operations.

### Deletion

Deletion must support preparing and failed sandboxes when a provider reference exists. It uses the existing provider-specific permanent-deletion confirmation and bounded reconciliation behavior.

Waterbox does not silently delete a created Box merely because preparation failed. The public Waterbox resource remains the ownership and recovery handle unless a separately designed cleanup action is explicitly requested.

## Licensing And Notices

### Project License

Add the standard MIT License text as `LICENSE` at the repository root and make it package-visible. Package metadata uses the SPDX expression:

```json
"license": "MIT"
```

Canonical legal files live at the repository root. Package-local copies under `packages/mcp/` are generated or synchronized for npm packaging and are checked byte-for-byte before pack and publish.

### Third-Party Inventory

The final MCP and sandbox CLI bundles, not the full lockfile, determine the shipped notice set.

Known embedded candidates use permissive licenses, including:

- MIT: `@modelcontextprotocol/sdk`, Zod, AJV, Noble packages, Scure packages, and related helpers.
- Hono, OpenAPI, API, and private-client dependencies included by the Fetch-backed bundle: inventory their exact shipped closure and notices.
- BSD-3-Clause: `age-encryption` and `fast-uri`.
- MIT adapted code: OpenCode edit and patch implementations.

No copyleft dependency was identified during launch research. This must be rechecked against the exact generated bundles.

Correct the existing OpenCode notice paths from the compatibility wrappers under `packages/receiver` to the adapted implementations under `packages/sandbox-runtime`.

`THIRD_PARTY_NOTICES.md` must preserve required copyright, permission, conditions, disclaimers, and BSD no-endorsement terms for code actually embedded in either shipped bundle.

### Verification

Release verification must:

- Build both package artifacts.
- Identify embedded third-party packages from build metadata or metafiles.
- Compare that closure with `THIRD_PARTY_NOTICES.md`.
- Fail when a bundled package has no recorded license or required notice text.
- Confirm `LICENSE` and `THIRD_PARTY_NOTICES.md` are present in the packed tarball.
- Confirm package-local legal files exactly match their canonical root files.

This plan records engineering requirements, not legal advice. Any ownership or commercial-policy concern discovered during publication remains a release blocker.

## Documentation Contract

The package README must lead with:

```sh
npx add-mcp waterbox@next
```

It must then explain:

- Installation does not select a provider.
- Waterbox starts connected but unconfigured.
- The supported providers table.
- Each provider's mandatory preparation behavior and optional capability support, based only on completed audit and live evidence.
- Provider-specific environment variable names.
- Safe credential configuration for each documented MCP client.
- Node 24.15 or newer is required locally.
- Bun is not required.
- Box requires no Waterbox system snapshot.
- Fresh and snapshot-sourced Boxes receive the current one-shot CLI during creation.
- Sandboxes persist after the MCP process exits.
- Provider billing and lifecycle remain the user's responsibility.
- `send_file_securely` follows the documented local-file access and sandbox plaintext caveats.

The root README must stop presenting the older AWS/OpenCode plugin as the current entire product. Historical or experimental components may remain documented but must be labeled accurately.

Do not advertise official MCP registry discovery, `npx add-mcp find waterbox`, a `waterbox.sh` website, or a managed provider before those exist.

## Registry Deferral

The official MCP registry requires a globally unique server name with one namespace slash. Domain-backed names reverse the domain labels. For example, control of `waterbox.sh` could support a name such as:

```text
sh.waterbox/mcp
```

GitHub-backed publication could instead use a verified GitHub namespace. This naming convention does not alter npm package resolution.

Until ownership is settled:

- Do not publish the current `dev.waterbox/mcp` metadata unless `waterbox.dev` is controlled and intentionally selected.
- Do not add `mcpName` with an unverified namespace to the npm package.
- Do not publish `server.json` to the official registry.
- Do not submit an add-mcp catalog overlay.

After npm launch, registry publication gets a separate plan or an appended phase with explicit namespace ownership proof.

## Phase Plan

### Phase 0: Baseline And Capability Gate

Status: complete; credential-free baseline plus authorized snapshot restore, stop/resume, runtime overwrite, and exact cleanup gates passed

Scope:

- Record current test, typecheck, MCP build, package dry-run, and Box-template validation results.
- Inspect the complete worktree and ensure every MCP runtime source is tracked.
- Add a credential-free test plan for Node and bootstrap changes.
- Add a separately authorized plain-Box capability probe.

The live probe verifies only launch prerequisites:

- Fresh `noEnv` creation without `from`.
- Node major and `/usr/local/bin/node` availability.
- `rg` availability.
- `sudo -n` installation into Waterbox-owned `/usr/local` paths.
- Upload of a current CLI-sized artifact.
- `systemd-run` and `systemctl` behavior required by secure-transfer expiry.
- Stop/resume persistence of installed Waterbox files.
- Snapshot-sourced creation from a stopped sandbox followed by runtime overwrite.
- Permanent cleanup and exact baseline reconciliation.

Acceptance criteria:

- Credential-free baseline is recorded.
- The live probe cannot run without exact authorization and isolated-account gates.
- Sanitized observations support every Box bootstrap assumption.
- No provider IDs, credentials, raw bodies, commands, or protected URLs are committed.
- A failed probe blocks full Phase 4 acceptance rather than adding apt or Bun fallback installation.

Verification:

```sh
bun test
bun run typecheck
bun run build:mcp
npm pack --dry-run ./packages/mcp
git diff --check
```

The actual live command is defined by the probe implementation and is not authorized by this plan alone.

### Phase 1: Node-Compatible Shared Persistence

Status: implemented and verified on Node 24.15.0; depends on Phase 0 credential-free baseline

Scope:

- Migrate the shared SQLite repository from `bun:sqlite` to `node:sqlite`.
- Preserve repository contracts and on-disk compatibility.
- Update direct repository tests and local API compatibility.

Acceptance criteria:

- `DatabaseSync` and `prepare()` replace Bun SQLite APIs.
- Read-only, create, in-memory, durability, CAS, pagination, malformed-row, and close behavior remain tested.
- Foreign-key behavior remains intentional and unchanged.
- Existing SQLite fixtures reopen successfully where practical.
- Bun-based repository tooling, if retained, can still execute the shared package or is isolated behind an explicit adapter without leaking Bun into the MCP bundle.

Verification:

```sh
bun test packages/sandbox-repository-sqlite/test packages/sandbox-core/test apps/api-local/test
bun run typecheck
git diff --check
```

Also run focused Node 24 repository compatibility checks added by this phase.

### Phase 2: Node MCP And One-Shot CLI

Status: complete; implemented and verified on Node 24.15.0 and current Node 24, including the Fetch-backed live MCP path; CI automation remains Phase 9 work.

Scope:

- Build and run the local MCP with Node.
- Build and run the in-sandbox one-shot CLI with Node.
- Change async worker re-execution paths from Bun to Node.
- Keep repository-only tooling migration minimal.

Acceptance criteria:

- Both generated artifacts are Node-targeted ESM.
- The MCP bin has the Node shebang and invokes `main()` through npm's symlink.
- Neither artifact contains Bun runtime references.
- Secure-transfer expiry scheduling and cancellation execute through Node child-process APIs.
- All seven canonical tools, secure transfer, quick Bash, dispatched Bash, observation, cleanup, health, and version pass focused tests.
- MCP with no provider, an unknown provider, a supported provider with missing credentials, and malformed non-secret provider configuration behaves according to the provider-neutral setup contract without corrupting stdout.
- Every unconfigured lifecycle and operation path, including `send_file_securely`, returns setup guidance before reading local files, opening SQLite, loading the bootstrap artifact, or contacting a provider.
- Under Node 24.15.0 and current Node 24, configured fake-provider flows exercise MCP renderer -> client -> authenticated embedded API -> SQLite/core, including API/client serialization and parsing; `node --check` is not sufficient evidence.
- The current package can be packed and launched in a clean environment with Node and no Bun.

Verification:

```sh
bun test packages/sandbox-runtime/test packages/sandbox-cli/test packages/mcp/test
bun run typecheck
bun run build:mcp
node --check packages/mcp/dist/waterbox.js
node --check packages/mcp/dist/waterbox-cli.js
git diff --check
```

Run the generated artifacts under the declared Node minimum and a current Node 24 patch in CI.

### Phase 3: Durable Preparing Checkpoint

Status: complete; credential-free implementation verified and Phase 0 and Phase 2 prerequisites satisfied

Scope:

- Add `preparing` to the shared sandbox state contract and persisted lifecycle between normal provider creation and `running`.
- Keep the existing provider create operation and its reliability semantics unchanged.
- Persist the provider reference returned by create before invoking mandatory preparation.
- Resume same-key preparation safely without adding provider-create replay.
- Preserve recovery and deletion for failed or ambiguous preparation.

Acceptance criteria:

- Provider creation still runs through the existing `createSandbox` method; no allocation/readiness split, automatic create replay, or list reconciliation is added.
- Core stores the opaque provider identity and commits `preparing` before any file upload or installation command.
- Provider readiness alone cannot transition a sandbox to `running`.
- Tools, secure transfer, lifecycle mutations, and snapshot creation reject `preparing`; probe and deletion remain available.
- Same-key replay resumes only persisted `preparing` work and never repeats provider create from a null-reference `provisioning` record.
- Definite post-checkpoint failure preserves a public failed resource and provider reference.
- Unresolved preparation ambiguity preserves `preparing` and in-progress idempotency.
- Every ordinary post-checkpoint failed or unresolved response gives the caller the public sandbox record or stable public sandbox ID required by `probe_sandbox` and `delete_sandbox`; focused MCP tests prove the recovery handle is usable.
- Preparing and failed resources with provider references are deletable.
- Concurrent preparation converges without corrupt installation.
- Existing no-retry semantics for user operations remain unchanged.
- Provider-neutral tests use simple fakes; Box-specific paths do not leak into core.

Required fault points include:

- Existing provider-create rejection and ambiguity behavior remains unchanged.
- Provider create succeeds but persistence of its result fails, proving no stronger guarantee is claimed.
- After the `preparing` checkpoint but before preparation starts.
- Preparation cancellation and definite failure through injected provider-neutral fakes.
- Process reconstruction from SQLite followed by same-key preparation resume.
- Provider inspection while `preparing`, proving provider live readiness cannot bypass preparation.

Verification:

```sh
bun test packages/sandbox-core/test packages/sandbox-provider-box/test packages/mcp/test
bun run typecheck
git diff --check
```

No live Box call is required for the credential-free completion of this phase.

### Phase 4: Box Bootstrap-On-Create

Status: complete with authorized live acceptance. Fresh and deliberately stale snapshot-sourced runtime preparation, user-data preservation, stop/resume, optional capabilities, and exact cleanup passed through the merged architecture; depends on Phase 3.

Scope:

- Remove Box's system-template source from fresh creation.
- Inject the packaged Node CLI artifact into the Box provider.
- Replace Box's Phase 3 deterministic preparation with artifact upload, install, manifest, verification, and reconciliation.
- Re-bootstrap snapshot-sourced Boxes.

Acceptance criteria:

- Fresh create omits `from`.
- Snapshot create uses only the user snapshot reference.
- Box's existing create operation still waits for provider readiness and returns its reference before preparation starts.
- No `BOX_SYSTEM_TEMPLATE_REF` configuration remains in supported MCP or local API composition.
- No Bun download, apt command, or ripgrep installation occurs.
- Installation is deterministic, bounded, idempotent, and secret-free.
- Manifest and health verification reconcile ambiguous installation responses.
- Artifact upload loss, installation response loss before and after completion, health failure, cancellation, and same-key restart from `preparing` have focused coverage.
- Box provider diagnostics contain no artifact bytes, credentials, provider IDs, commands, or raw response bodies.
- Secure transfer and async Bash work on a plain Box.
- Stop/resume and user-snapshot restore retain user data and restore Waterbox operation.

Verification:

```sh
bun test packages/sandbox-provider-box/test packages/sandbox-cli/test packages/sandbox-runtime/test packages/mcp/test
bun run typecheck
bun run build:mcp
git diff --check
```

Authorized isolated-account evidence verified provider snapshot restore and stop/resume continuity, then verified through the supported Fetch-backed MCP that a snapshot missing the inherited CLI artifact triggers upload, install, final verification, current health/version, and user-data preservation. Bounded cleanup restored the exact Box account baseline.

### Phase 5: Fetch-Backed Product Boundary

Status: complete; merged in PR #5 as `67a984ddf1761844548a4dad1e8e1d5b611c5d6b`, integrated, and re-verified through credential-free tests, current and minimum Node 24, installed-artifact verification, and authorized provider live acceptance

Scope:

- Establish canonical API routes, private `@waterbox/client`, embedded authenticated `ApiBackend`, a thin MCP renderer, and a thin `api-local` listener trigger.
- Preserve embedded/network fake conformance and add parity and dependency guards.

Acceptance criteria:

- No MCP production path calls core, repositories, or providers directly, and the supported MCP has no listener.
- The embedded bearer remains process-private; API authentication, body bounds, serialization, client parsing, cancellation, recovery, and diagnostics redaction apply equally to embedded and network fakes.
- Recovery/cancellation plus Bash and secure-transfer flows retain parity through API and client boundaries.
- All 14 MCP tools under absent, unknown, incomplete, and malformed provider configurations return side-effect-free setup guidance before local files, SQLite, artifacts, or provider APIs are touched.
- Provider diagnostics, including the Box provider diagnostic callback, are preserved.
- Pre-merge review fixes preserve the Box provider diagnostic callback and restore comprehensive unconfigured safety coverage.

The required fresh end-to-end MCP smoke passed against the merged Fetch-backed path.

Verification:

```sh
bun test packages/sandbox-api/test packages/client/test packages/control-plane-local/test packages/mcp/test apps/api-local/test
bun run typecheck
bun run build:mcp
git diff --check
```

Also run the configured embedded fake-provider flow under Node 24.15.0 and current Node 24, the client conformance suite against embedded and real-listener fake backends, and the MCP dependency/no-listener guard.

### Phase 6: Vercel Sandbox Capability Probe And Provider-Port Audit

Status: complete. The direct-REST fake suite and authorized isolated-project live probe passed with exact baseline reconciliation, and the approved provider-neutral implementation was completed in Phase 7.

Scope:

- Do not implement a production adapter, change the provider port, or alter API, client, MCP, or core behavior in this phase.
- Read official Vercel Sandbox SDK/API documentation and inspect the exact installed SDK version.
- Run credential-free static/fake probes and, separately, a minimally scoped authorized live capability probe.
- Map `createSandbox`, `prepareSandbox`, `inspectSandbox`, `deleteSandbox`, and `executeTool`, plus every existing optional group: `stopResume`, `snapshots`, `secureFileTransfer`, and `bashJobs`.
- Audit resource identity/durability; create ambiguity and idempotency; state mapping; command execution/events; filesystem/upload; runtime/base image/preparation; Node, `rg`, and `sudo` availability or alternatives; cancellation/timeouts; deletion; quotas/billing; snapshots; stop/resume; secure transfer; Bash jobs; source-snapshot semantics; credential/configuration; and secret/redaction concerns.

Acceptance criteria:

- Produce `docs/research/vercel-sandbox-provider-port-audit.md` with cited evidence, installed-version facts, static/fake and separately authorized live observations, cleanup reconciliation, and exactly one verdict:
  1. adapter fits current port unchanged;
  2. adapter-local shim needed, port unchanged;
  3. generic port change required before adapter.
- The live probe uses exact authorization, minimal resources, tracked cleanup, and exact baseline reconciliation. It makes no production implementation claim.
- Any proposed port change is minimal, provider-neutral, justified by both providers or general semantics, and explicitly approved in this launch plan before implementation. No provider-name branch is added in core, API, client, or MCP.

### Phase 7: Evaluate Audit, Approve Contract, Then Implement Vercel Provider

Status: complete; the provider-neutral primitive boundary, shared runtime, Box migration, Vercel implementation, configured composition, and authorized two-provider acceptance are complete. Phase 8 package, legal, and release-document closure remains pending.

Scope:

- Follow the approved provider-neutral primitive and shared-runtime architecture recorded in the Phase 6 audit and implementation log.
- Introduce the provider-neutral primitive infrastructure port and shared Waterbox runtime composition described there.
- Migrate Box without behavior or persisted-reference regression and pass the authorized Box gate before production Vercel composition.
- Then add the Vercel primitive adapter, local composition, settled configuration contract, shared parity, and authorized live acceptance.
- Keep Vercel-specific behavior below adapter/composition. Provider selection stays in composition/registry configuration; setup rendering above composition consumes provider-neutral metadata instead of branching on provider names.

Acceptance criteria:

- The approved boundary, evidence, phased Box-preserving migration, and generic contract amendment are recorded in the supplementary plan before implementation starts.
- `name`, `createSandbox`, `prepareSandbox`, `inspectSandbox`, `deleteSandbox`, and `executeTool` remain mandatory. `stopResume`, `snapshots`, `secureFileTransfer`, and `bashJobs` remain optional cohesive groups even if an approved generic extension is added.
- No Box- or Vercel-name branch exists in core, API, client, or MCP.
- Add credential-free conformance tests using shared provider-neutral expectations where valuable, without reviving an oversized conformance framework.
- Add an isolated live Vercel smoke for every mandatory method and each optional capability advertised as supported.
- Launch documentation includes an honest provider capability table and official credential-injection instructions.
- Once its configuration contract is settled, unconfigured setup guidance lists Box and Vercel Sandbox without reading artifacts, SQLite, local files, or provider APIs.
- Vercel reaches implementation-level launch support when its adapter, configured Node path, provider documentation, and isolated live smoke pass. Phase 8 separately owns package/legal/release-document closure before npm launch.

Verification:

```sh
bun test packages/sandbox-core/test packages/sandbox-provider-box/test packages/sandbox-provider-vercel/test packages/control-plane-local/test packages/sandbox-api/test packages/client/test packages/mcp/test
bun run typecheck
bun run build:mcp
git diff --check
```

Also run the shared mandatory provider expectations against both adapters, optional expectations only for groups each adapter exposes, configured fake flows under Node 24.15.0 and current Node 24, and the separately authorized Vercel live smoke.

### Phase 8: Package, Legal, And Documentation

Status: credential-free implementation complete; the exact installed artifact passed Node 24.15.0 and Node 24.20.0 locally, while hosted CI evidence remains pending

Scope:

- Rename the package and executable to `waterbox`, retain its CLI-only contract, and add complete npm metadata.
- Add MIT licensing and exact bundle closure notices, including Hono/OpenAPI/API/client dependencies.
- Rewrite package and root documentation for the Fetch-backed local architecture and both providers.
- Remove supported-path system-template documentation and scripts; the Phase 4 snapshot-sourced reinstall and live prerequisite are complete.
- This phase now includes bounded native-keyring onboarding only: exact-pinned `@napi-rs/keyring@2.0.0` remains external to the bundle and is lazy-loaded; interactive setup never accepts CLI credential arguments; config is atomically persisted without secrets; and status/logout have safe missing-versus-inaccessible-store behavior. This does not complete the remaining package rename, legal, or broad documentation scope.

Acceptance criteria:

- `npx waterbox@next` resolves the sole package bin and starts stdio MCP; `npx add-mcp waterbox@next` writes the expected package command.
- The tarball contains only approved files; private workspace internals are bundled, not public APIs or source packages.
- Package metadata, legal notices, and documentation are factual for Box and Vercel Sandbox, optional capabilities, and no hosted mode.
- `server.json` is either valid for an owned namespace or omitted from the release tarball and explicitly deferred.
- `waterbox` is the sole public executable: zero arguments remain stdio MCP with no non-MCP stdout, and explicit `setup`, `status`, and `logout` use terminal I/O. Missing configuration, native binding, or keyring access keeps MCP connected with provider-neutral setup guidance before local/provider activity.
- Verification includes injected credential-store/config/prompt tests, native package platform and installed-tarball tests, and confirmation that no config/output/error contains a secret. Legal notice closure remains pending with the rest of Phase 8.

Verification:

```sh
bun test
bun run typecheck
bun run build:mcp
npm pack --dry-run ./packages/mcp
npx publint ./packages/mcp
git diff --check
```

The phase must add an installed-tarball test in an external temporary directory and inspect the packed file list, executable mode, shebang, bundle imports, exact post-refactor dependency/legal closure, and license files.

### Phase 9: CI And Release Automation

Status: workflow implementation, hosted CI, and protected `npm` environment complete; first-package bootstrap and npm trusted-publisher validation remain pending

Scope:

- Add pull-request CI.
- Add a protected npm publish workflow using trusted publishing.
- Add version and metadata consistency checks.
- Define release tags and failure handling.

Pull-request CI gates:

- Frozen dependency installation.
- Full tests and typecheck.
- MCP and CLI Node builds.
- Static Bun-reference rejection in release artifacts.
- Node minimum and current-Node-24 artifact tests.
- Package dry-run and installed-tarball test.
- License/notice closure check.
- `publint` and metadata validation.
- `server.json` schema validation only if registry metadata is included.

Publish workflow requirements:

- GitHub-hosted runner.
- `contents: read` and `id-token: write` only, plus any minimal release permission intentionally required.
- npm CLI and Node versions compatible with trusted publishing.
- No long-lived npm publish token. The initial unclaimed-package bootstrap may use only the interactive 2FA procedure below.
- A protected GitHub environment with required approval is preferred.
- Build and test from the exact tag commit.
- Verify tag, package, MCP implementation, artifact manifest, and optional `server.json` versions agree.
- Pack the package twice in isolated clean directories and require identical file lists and content hashes; document any unavoidable archive-metadata difference instead of weakening content reproducibility.
- Select one `.tgz`, record its SHA-256, install and test that exact file, and publish that exact inspected `.tgz`. Do not publish the package directory, because npm would repack it.
- Retain npm provenance.
- Never publish from `pull_request_target` or untrusted checked-out code.

First-package bootstrap procedure:

- Publish the exact retained tarball manually as `lucho-mzmz` with npm's interactive browser/2FA flow because an unclaimed package cannot configure trusted publishing or staged publishing.
- Pass `--access public --tag next`, record that this one bootstrap publication cannot carry GitHub Actions provenance, and verify the registry tarball is byte-for-byte identical to the retained candidate.
- Do not create or store a granular publish token.
- Immediately after successful publication, configure npm trusted publishing for `bros4president/waterbox`, workflow `publish.yml`, environment `npm`, and `npm publish` permission; then require 2FA and disallow traditional tokens in the package publishing settings.
- The protected tag workflow may encounter an already-published bootstrap version. In that case it must download the registry tarball and require byte-for-byte equality with the newly certified tag artifact instead of attempting to overwrite the immutable version.

Acceptance criteria:

- CI catches stale bundles, version drift, missing notices, and runtime Bun dependencies.
- CI records and uses the explicit certified `add-mcp` version for configuration-generation tests.
- Release publication cannot run from an arbitrary branch or fork.
- The first package can establish npm trusted publishing safely; any unavoidable bootstrap publish is documented and immediately followed by trusted-publisher restriction.
- Publication failure does not mutate versions or tags automatically.

### Phase 10: Alpha Release Candidate And npm Launch

Status: pending; depends on Phase 9

Scope:

- Reserve or publish the currently unclaimed `waterbox` npm name.
- Execute final clean-environment and isolated-account release gates.
- Publish `waterbox@0.1.0-alpha.1` under the npm `next` dist-tag without assigning `latest`.
- Verify public installation without changing client secrets automatically.

Release candidate gates:

1. Clean checkout of the intended tag commit.
2. Full CI green.
3. Packed tarball reviewed and checksum recorded in release evidence.
4. No secrets or local state in tarball.
5. Node minimum and current Node 24 launch pass with Bun absent.
6. Unconfigured MCP connects and returns provider-neutral setup guidance.
7. Configured isolated-account Box and Vercel Sandbox smokes each pass the shared mandatory provider surface and return to exact baseline; optional capability smoke runs only where advertised.
8. The pinned certified `add-mcp` version generates correct `waterbox@next` configurations for representative clients in temporary homes; the `next` resolution is checked once as a release observation and its resolved version is recorded.
9. npm account ownership, 2FA, trusted publisher, and package access are verified.
10. Documentation describes actual released behavior only.

Post-publication verification:

```sh
npm view waterbox@0.1.0-alpha.1
npm view waterbox dist-tags --json
npm exec --yes --package=waterbox@0.1.0-alpha.1 -- waterbox
npx add-mcp@2.3.0 waterbox@next --name waterbox -a opencode -y
```

The MCP process command requires a protocol-aware smoke harness; do not treat an indefinitely waiting stdio server as a failed CLI command.

Verify `next` resolves to `0.1.0-alpha.1`, `latest` does not resolve to this prerelease, and npm provenance, package files, README rendering, issue links, and deprecation status are correct. Do not publish a replacement version merely to fix documentation that can be corrected before the initial release.

### Phase 11: Registry Discovery

Status: deferred; not required for npm launch

Prerequisites:

- A selected and controlled project domain or approved GitHub namespace.
- Matching `mcpName` in the published npm package.
- Valid, version-synchronized `server.json`.
- A decision about how provider-dependent environment variables are represented without implying Box is the only architecture.

Possible work:

- Publish to the official MCP registry with `mcp-publisher`.
- Submit to integrations.sh or add-mcp's overlay for default catalog discovery.
- Verify `npx add-mcp find waterbox` separately from direct package installation.

This phase requires a new package version if ownership metadata was not included in `0.1.0-alpha.1`.

## File Impact Map

Expected primary files:

```text
package.json
.env.example
README.md
LICENSE
THIRD_PARTY_NOTICES.md
.github/workflows/*

packages/mcp/package.json
packages/mcp/README.md
packages/mcp/LICENSE
packages/mcp/THIRD_PARTY_NOTICES.md
packages/mcp/src/main.ts
packages/mcp/src/config.ts
packages/mcp/src/server.ts
packages/mcp/test/*

packages/client/src/*
packages/client/test/*
packages/control-plane-local/src/*
packages/control-plane-local/test/*
packages/sandbox-api/src/*
packages/sandbox-api/test/*

packages/sandbox-repository-sqlite/src/index.ts
packages/sandbox-repository-sqlite/test/*

packages/sandbox-core/src/provider.ts
packages/sandbox-core/src/service.ts
packages/sandbox-core/test/*

packages/sandbox-provider-box/src/index.ts
packages/sandbox-provider-box/test/*
packages/sandbox-provider-box/README.md
packages/sandbox-provider-vercel/src/*
packages/sandbox-provider-vercel/test/*

packages/sandbox-cli/package.json
packages/sandbox-cli/src/*
packages/sandbox-cli/test/*

packages/sandbox-runtime/src/async-bash.ts
packages/sandbox-runtime/src/vendor/*
packages/sandbox-runtime/test/*

apps/api-local/src/config.ts
apps/api-local/src/app.ts
apps/api-local/test/*
apps/api-local/README.md

scripts/embedded-mcp-smoke.ts
scripts/vercel-sandbox-capability-probe.ts
scripts/vercel-sandbox-capability-probe.test.ts
docs/research/vercel-sandbox-provider-port-audit.md
```

The embedded-path smoke is `scripts/embedded-mcp-smoke.ts`; the obsolete direct-path name and system-template files were removed in Phase 8.

The Phase 4 live prerequisite is complete. Remove system-template machinery as a Phase 8 cleanup, not as an assumption in earlier phases.

## Verification Matrix

### Credential-Free

| Area | Required proof |
|---|---|
| Configuration | Missing provider connects; malformed provider config is safe; neither Box nor Vercel Sandbox is selected implicitly |
| SQLite | Node API parity, durability, CAS, pagination, malformed rows, close behavior |
| MCP | stdio handshake, tool listing, thin renderer dependency guard, setup guidance, cancellation, diagnostics redaction, and no listener |
| API/client | embedded auth, body bounds, recovery-ID serialization/parsing, cancellation and embedded/network fake parity |
| Unconfigured safety | All 14 MCP tools under absent, unknown, incomplete, and malformed provider configurations return guidance before local file, SQLite, artifact, or provider API I/O |
| CLI | health, version, all tools, secure transfer, quick and dispatched Bash |
| Core | preparing checkpoint, same-key preparation resume, readiness gating, concurrency, failure recovery |
| Box adapter | exact request bodies, deterministic upload, idempotent install, ambiguity reconciliation |
| Vercel adapter | audit verdict first; then mandatory-port mapping and only advertised optional capability conformance |
| Packaging | clean tarball install, npm bin symlink, Node-only runtime, file allowlist |
| Reproducibility | two clean packs have identical content hashes; the selected tested `.tgz` is the published artifact |
| Legal | exact bundle closure has complete license and notice coverage |
| Metadata | package, artifact, implementation, and optional registry versions agree |

### Live And Destructive

Live tests require explicit isolated-account authorization and must prove:

- Baseline visible and active resource sets are captured without logging IDs.
- Only run-owned resources are mutated.
- Fresh plain Box bootstrap succeeds.
- Snapshot-sourced bootstrap succeeds.
- Box and Vercel Sandbox each pass the shared mandatory provider surface required for launch.
- Secure transfer, quick/dispatched/nonzero/timed-out Bash, stop/resume, and snapshots are smoked only for providers that advertise each optional capability.
- Permanent deletion is correlated and bounded.
- Final visible set and active count equal baseline.
- Unknown account differences are blockers, never cleanup targets.

## Release Failure And Recovery

- npm package versions are immutable. Never overwrite or reuse a published version.
- Do not unpublish merely for a correctable defect without checking npm policy and downstream impact.
- For a broken release, stop promotion, deprecate the affected version with a factual message when appropriate, fix forward, and publish a new patch.
- Do not move or recreate signed release tags silently.
- Do not publish official registry metadata pointing at an npm version that is absent, deprecated for a launch-blocking defect, or metadata-incompatible.
- Provider bootstrap version must remain explicit so a patch can install a corrected runtime into newly created and forked sandboxes.
- Existing sandboxes keep their installed runtime until recreated or a separately designed upgrade mechanism exists.

## Launch Checklist

- [x] Phase 0 baseline fully recorded.
- [x] Plain Box stop/resume and snapshot-overwrite capability calibrated live.
- [x] Shared SQLite migrated to Node.
- [x] Local MCP runs on Node 24 without Bun.
- [x] In-Box CLI runs on Node 24 without Bun.
- [x] Provider create result persists as `preparing` before bootstrap.
- [x] Same-key create resumes only durable preparation safely.
- [x] Fresh Box creation no longer uses a system snapshot.
- [x] Snapshot-sourced creation installs the current runtime and preserves user data.
- [x] Legacy system-template machinery removed after the snapshot/live gate.
- [x] PR #5 merged upstream as `67a984ddf1761844548a4dad1e8e1d5b611c5d6b`.
- [x] PR #5 integrated into the current checkout.
- [x] Post-merge embedded MCP Node-minimum, current-Node, live, and installed-artifact re-verification completed.
- [x] Vercel Sandbox provider-port audit has an approved follow-up architecture decision.
- [x] Vercel Sandbox provider implemented only after the approved audit verdict.
- [x] npm package renamed to `waterbox`.
- [x] Package is CLI-only.
- [x] Missing provider is a connected setup state.
- [x] MIT license and complete notices included.
- [x] Package-local legal files match canonical root files exactly.
- [x] npm metadata complete and factual.
- [x] Root and package docs match released behavior.
- [x] Box and Vercel Sandbox setup docs and isolated live gates pass.
- [x] Exact post-refactor bundle and legal closure verified.
- [x] Pull-request CI complete.
- [x] Trusted npm publish workflow protected; npm-side binding remains pending until the package exists.
- [x] Installed-tarball test passes with Bun absent on Node 24.15.0 and Node 24.20.0.
- [x] Exact tested tarball checksum is preserved through npm publication.
- [ ] Isolated-account release smoke passes with exact cleanup reconciliation.
- [x] `waterbox@0.1.0-alpha.1` published under `next` and registry bytes match the retained candidate.
- [ ] Bootstrap exceptions resolved: trusted publishing configured for future provenance and unintended `latest` assignment remediated.
- [ ] `npx add-mcp waterbox@next` verified from a clean environment.
- [ ] Official MCP registry decision remains explicitly deferred or receives a separate approved phase.

## Implementation Log

- 2026-08-31: Plan created from the npm launch review. Settled the unscoped `waterbox` package, CLI-only distribution, provider-neutral explicit configuration, Node 24 local and sandbox runtimes, plain-Box bootstrap, accepted-resource persistence, tarball verification, trusted npm publication, and official registry deferral. No implementation or live provider operation occurred while writing the plan.
- 2026-09-03: Changed the planned project license from Apache-2.0 to MIT after separating the private hosted product from the public Waterbox repository.
- 2026-08-31: Node 24.15.0 verification passed using the official darwin-arm64 binary: Node build and syntax, `node:sqlite` compatibility, clean pack/install, and npm-bin MCP setup smoke. The official SHASUMS checksum matched; signature verification was unavailable because GPG tooling was absent.
- 2026-08-31: Phase 3 credential-free implementation verified the existing create operation followed by a durable `preparing` checkpoint and mandatory provider preparation. No create replay, allocation/readiness split, or list-diff correlation was added.
- 2026-08-31: Phase 4 fresh live flow passed: fresh create, initial incomplete verification, correlated upload, install, final verification, running probe, all tools, secure transfer, async Bash, concurrency, tracked cleanup, and exact baseline comparison. The verifier natural-EOF handling was corrected from this live observation.
- 2026-08-31: Snapshot-sourced reinstall failed during install and remains pending. Stop/resume and snapshot overwrite are also pending, so Phase 0 and Phase 4 full live acceptance are not complete. Legacy template machinery deletion remains deferred until that gate passes.
- 2026-09-01: PR #5 merged as `67a984ddf1761844548a4dad1e8e1d5b611c5d6b` and was integrated into the current checkout. The launch plan was realigned to its Fetch-backed product boundary and adds audit-before-implementation pressure for Vercel Sandbox. Post-merge re-verification, the Vercel probe, and the Vercel adapter remain unclaimed.
- 2026-09-01: Post-merge verification restored workspace links and passed 446 credential-free tests, typecheck, MCP build, focused Fetch-backed coverage, and Node 24.15.0 artifact checks. The authorized Fetch-backed Box smoke passed fresh preparation, all seven tools, secure transfer, Bash, concurrency, bounded exact cleanup, and a deliberately stale snapshot-sourced reinstall with user-data preservation and current runtime verification. The raw capability probe separately passed snapshot restore, stop/resume identity and marker continuity, accepted-pending deletion with visibility/capacity release, snapshot deletion, and zero active run-owned resources. Phase 0 and Phase 4 live gates are complete; no provider identifiers or credentials were retained.
- 2026-09-01: Phase 6 completed without adding the Vercel SDK or changing production behavior. Twelve direct-REST fake tests passed request-contract, ambiguity, lifecycle, transient snapshot, bounded-output, redaction, and cleanup cases. The separately authorized isolated-project probe passed fresh named create, Node 24, `rg`, privilege/workspace preparation, gzip-tar upload, command wait/log/kill, stop/resume persistence with replaced session identity, manual and automatic snapshots, snapshot-source restore, deletion/tombstones, and exact baseline reconciliation with zero cleanup errors. The audit in `docs/research/vercel-sandbox-provider-port-audit.md` records exactly one verdict: adapter-local shim needed, port unchanged. Phase 7 approval, production implementation, and configuration selection remain pending; no credential or provider identifier was retained in the plan or report.
- 2026-09-01: Phase 7 architecture review approved a supplementary provider-neutral implementation plan. The review refined the audit recommendation: Box and Vercel share a direct low-level intersection, while the current provider implementation boundary mixes native sandbox primitives with shared Waterbox preparation, CLI, secure-transfer, and Bash-job logic. Implementation must introduce the primitive port, extract the shared runtime, migrate and live-regress Box, and only then implement and live-accept Vercel. Native `fetch` against the validated REST surface is the settled Vercel transport; no Vercel SDK dependency is planned. No production code or live provider operation occurred while recording this decision.
- 2026-09-02: Phase 7 complete: the supplementary provider plan completed its provider-neutral primitive boundary, shared runtime, Box migration/regression, Vercel adapter/composition, documentation, and authorized two-provider acceptance. Vercel passed fresh/current preparation, all tools, ciphertext transfer, Bash, concurrency, snapshot restore/repair, stop/resume, cancellation/kill recovery, and owned automatic-snapshot tombstone cleanup with zero active resources; Box passed its direct embedded regression with exact baseline restoration. Final verification passed 474 tests and 2433 expectations, typecheck, MCP build, Node SQLite tests, the default Node composition smoke, and diff checking. `$NODE_24_15_BIN` and `$NODE_24_CURRENT_BIN` were absent, so those named commands were not run and no substitute was used. Phase 8+ package, legal, CI, and npm release work remains pending.
- 2026-09-03: Issue #10 baseline confirmed `waterbox` remained unclaimed (`npm view` returned E404). The pre-change `bun run check:release` passed 594 tests, Node SQLite, shared-library verification, and the scoped three-artifact package verifier; it reported `$NODE_24_15_BIN` unavailable in that invocation.
- 2026-09-03: Phase 8 credential-free closure renamed the package to CLI-only `waterbox@0.1.0`, removed stale index and system-template surfaces, restricted persisted endpoints to the exact official Box/Vercel values before keyring reads, synchronized MIT/legal files, mapped the exact esbuild closure, rewrote product docs, and certified one exact isolated tarball. Local release verification passed 588 tests, typecheck, Node SQLite, shared-library gates, publint, two-pack normalized-content equality, isolated install, exact allowlist/legal/corpus/source-path checks, and pinned `add-mcp@2.3.0` OpenCode/Codex configuration. The retained candidate hash for that run was `ad48235cd27651662c5d27adab8ce32ebfd81465444a1e2aa3369d34711ab35d`; protocol initialization, 15-tool listing, unconfigured guidance, adjacent CLI execution, and clean shutdown passed with the official Node v24.15.0 binary. No current Node 24 binary was available, so that gate remains pending rather than using Node v25.2.1 as a substitute.
- 2026-09-03: Phase 9 workflow code added PR/push release checks across Node 24.15.0 and current Node 24 plus a repository/tag/environment-restricted OIDC/provenance publish path that retains and publishes one verified tarball. Hosted workflow execution, GitHub environment protection, npm package bootstrap/ownership, and trusted-publisher configuration remain external pending gates; no publish, tag, release, commit, push, or provider mutation occurred.
- 2026-09-03: Supervisor corrections completed the root install/keyring wording, made interactive setup reject unsafe or malformed persisted records before any prompt or credential-store access, and completed the active Direct-to-Embedded smoke terminology migration. The corrected focused suite passed 68 tests and 279 expectations; typecheck and exact Node v24.15.0 package verification passed, superseding the earlier pre-correction candidate.
- 2026-09-03: Supervisory release hardening made the verifier construct the package twice from independently copied source trees with frozen installs and clean library/MCP builds before packing, executes installed artifacts with a Node-only `PATH`, and validates bundled package manifest licenses plus required notice terms and copyright lines against the reviewed map. The exact candidate passed on Node v24.15.0 and v24.20.0 with SHA-256 `d8f33fbe3c9e1ff23ef334cc4373e65c3b191590f54e24aa2d0c867c2fd6f111`. CI now exports the intended matrix Node binary. The publish workflow pins actions by commit, requires the tagged commit to be reachable from `origin/main`, records release evidence for 90 days, and rechecks the retained tarball SHA-256 immediately before trusted publication. Hosted CI, environment protection, npm bootstrap/trusted-publisher setup, authorized release smokes, and publication remain pending.
- 2026-09-03: PR #14 merged the launch implementation after hosted CI passed on Node v24.15.0 and current Node 24. The first CLI publication policy then changed from stable to `waterbox@0.1.0-alpha.1` under `next`; package, runtime, installer, workflow, evidence, and documentation contracts were aligned without assigning `latest`. Local release verification passed 589 tests and 3021 expectations, typecheck, Node SQLite, shared-library gates, publint, reproducible isolated builds, installed-artifact protocol checks on Node v24.15.0, and pinned `add-mcp@2.3.0` configuration. A package-directory npm dry run also exposed and fixed cwd-dependent bundle-closure verification. The retained alpha candidate SHA-256 is `57fe657ef2fd7e13ada6585e1d2f0790c7a1b742bfa2293fec1001968a553518`; current Node 24 remains a hosted-CI gate for the follow-up PR.
- 2026-09-03: PR #15 passed the Node v24.15.0 and current Node 24 hosted gates and merged the alpha contract as `1f3f371107f660776e3969b193d518f2d558931e`. A full-history and checkout Gitleaks v8.30.1 audit found no leaks before the repository became public. The GitHub `npm` environment now requires review, disables administrator bypass, and permits only deployment tag `v0.1.0-alpha.1`. Because npm cannot bind a trusted publisher before the unclaimed package exists, the publish workflow documents and consumes a protected, short-lived `NPM_BOOTSTRAP_TOKEN` for this first publication only, verifies the npm identity, and requires immediate trusted-publisher setup and token revocation afterward. No package, tag, or provider resource was created.
- 2026-09-03: The token bootstrap was superseded before use because npm's 2026 authentication transition made an interactive browser/2FA bootstrap preferable. After two user-aborted provider smoke attempts, cleanup deleted only the correlated run resources and restored the older Box baseline plus the empty Vercel baseline exactly; the attempts do not satisfy the release-smoke acceptance gate. The exact retained tarball passed 589 tests and 3021 expectations again and was manually published as `waterbox@0.1.0-alpha.1`. A fresh registry download matched SHA-256 `57fe657ef2fd7e13ada6585e1d2f0790c7a1b742bfa2293fec1001968a553518` byte-for-byte. This manual bootstrap has no GitHub provenance. npm assigned both `next` and `latest` on initial package creation despite `--tag next`; an interactive `npm dist-tag rm waterbox latest` attempt returned HTTP 400, so the no-`latest` gate remains unresolved. A local bare-command failure was traced to the developer machine's prelaunch incompatible `~/.waterbox/direct.sqlite`; a clean home starts normally, and the old database was preserved because it may track the older archived Box baseline resource.
