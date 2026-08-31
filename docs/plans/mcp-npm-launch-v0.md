# Waterbox MCP npm Launch V0

Status: implementation in progress; Phases 1 and 2 implemented and locally verified, with Node 24.15.0 verification pending

This is the durable launch plan for publishing the supported local Waterbox MCP as the unscoped npm package `waterbox`, making `npx add-mcp waterbox` the primary installation path, removing Bun and per-account Box system snapshots from the runtime requirements, and adding a controlled npm release process.

Waterbox is prelaunch. The package and runtime changes in this plan replace the unpublished `@waterbox/mcp` package and `waterbox-system-v6` bootstrap directly. Do not add compatibility aliases, migrations, deprecation packages, or preservation machinery for artifacts that have never been publicly released.

## How To Use This Plan

An implementation agent assigned a phase must:

1. Read this entire plan and every prerequisite phase.
2. Inspect the current worktree and preserve unrelated or concurrent changes.
3. Implement only the assigned phase and its acceptance criteria.
4. Run focused verification, repository-wide tests, typecheck, and diff checking where applicable.
5. Update the phase status and append a short implementation-log entry with verification facts.
6. Stop at the phase boundary.

Do not reinterpret settled requirements inside a phase. If Box behavior, Node behavior, npm behavior, or an external registry contract contradicts this plan, record the exact blocker and stop instead of adding an unsafe fallback.

No live Box mutation is authorized merely by this document. Every live capability probe and smoke run remains separately credentialed, explicitly authorized, isolated-account gated, bounded, and cleanup-reconciled.

## Launch Objective

The package launch is successful when a new user can run:

```sh
npx add-mcp waterbox
```

and receive a valid local stdio MCP configuration whose process:

- Runs on Node.js 24 without Bun installed locally.
- Connects successfully even before a provider is configured.
- Explains provider setup without accepting secrets through model-visible tool arguments.
- Uses an explicitly selected user-owned provider after credentials are supplied through the MCP client's environment or secret mechanism.
- Creates a fresh Box without a Waterbox system snapshot.
- Reinstalls the current Waterbox one-shot CLI when creating from a user snapshot.
- Persists the provider resource identity before bootstrap can fail or the process can exit.
- Publishes from a reviewed Git commit through a reproducible, tested npm tarball.

The launch command installs configuration. It does not silently choose a provider or acquire credentials.

## Settled Decisions

### Product And Package

- The public npm package name is `waterbox`.
- The package has one public executable named `waterbox`.
- The package is CLI-only in V0. It has no public JavaScript `exports` entry and ships no declarations.
- `npx add-mcp waterbox` is the primary advertised installation command.
- The supported server remains a local stdio MCP that composes repositories, core, and the selected user-owned provider directly.
- Waterbox remains provider-neutral. Box is the first supported provider, not an implicit default.
- Missing provider configuration is a connected setup state, not a process startup failure.
- Provider credentials are supplied by the user through environment or client-specific secret facilities.
- Credentials are never accepted through MCP tool arguments, returned in MCP content, or written to ordinary diagnostics.

### Runtime

- The local MCP runtime is Node.js 24.
- The in-sandbox one-shot CLI runtime is Node.js 24.
- The minimum supported Node version is `24.15.0`, where `node:sqlite` is release-candidate quality.
- CI and release builds test the latest available Node 24 LTS patch in addition to the declared minimum where practical.
- Bun may remain repository-only build or test tooling temporarily. Bun is not required by npm consumers or created Boxes.
- The local repository uses `node:sqlite`; no native npm SQLite addon is introduced.
- The Box base image's documented Node 24 and ripgrep installations are used instead of downloading Bun or installing packages with apt.

### Sandbox Provisioning

- One public `create_sandbox` action covers provider allocation and Waterbox runtime bootstrap.
- The public sandbox remains `provisioning` until allocation, bootstrap, and health verification complete.
- Fresh Box creation omits `from` and does not require a named system snapshot.
- Creation from a Waterbox user snapshot uses that snapshot as the Box source, then installs the current Waterbox runtime over any inherited version.
- Stop and resume preserve the installed runtime according to Box's documented filesystem behavior. Resume does not automatically upgrade an existing sandbox in V0.
- A future provider may use a different bootstrap mechanism, but core must preserve the same accepted-resource durability boundary.

### Safety And Release

- Apache-2.0 is the project license for the public package.
- Release attribution uses `Waterbox contributors`.
- The npm tarball includes the project license, project notice, and notices required by embedded dependencies and adapted code.
- npm publication uses a controlled GitHub Actions workflow with npm trusted publishing, OIDC, and provenance.
- The exact tarball is tested after packing and before publication.
- Official MCP registry publication and add-mcp catalog discovery are separate from direct npm installation and do not block V0.
- The final official MCP registry name is deferred until a project domain is selected and controlled. Reverse-DNS naming has no bearing on `npx add-mcp waterbox`.

## Non-Goals

Do not add in this launch:

- A managed Waterbox Cloud provider.
- A hosted streamable-HTTP or SSE MCP transport.
- Provider-specific browser authentication embedded in the generic MCP.
- A Waterbox credential vault or cross-platform keychain abstraction.
- Secret entry through chat, MCP tools, shell arguments, or committed configuration.
- An npm alias or forwarding package for `@waterbox/mcp`.
- A public library API from the `waterbox` package.
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
    |
    | stdio: npx -y waterbox
    v
waterbox Node 24 bundle
    |
    +-- unconfigured backend -> provider setup guidance
    |
    +-- configured backend
            |
            +-- node:sqlite repositories
            +-- provider-neutral core
            +-- selected provider
                    |
                    +-- allocate provider sandbox
                    +-- persist provider reference
                    +-- install current one-shot CLI
                    +-- verify runtime
                    +-- expose canonical tools
```

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
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "description": "Run coding tools in isolated, stateful sandboxes through MCP.",
  "bin": {
    "waterbox": "./dist/waterbox.js"
  },
  "engines": {
    "node": ">=24.15.0"
  },
  "license": "Apache-2.0",
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
    "access": "public"
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
NOTICE
THIRD_PARTY_NOTICES.md
package.json
```

`server.json` may remain in the repository while official registry publication is deferred. Do not ship metadata with an unowned or knowingly incorrect registry namespace. Add it to the tarball only when its namespace, package identifier, version, environment declarations, and publication path are valid.

Because npm cannot pack files from outside the workspace package automatically, the package directory must contain synchronized release copies of `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md`. A release check compares each package-local file byte-for-byte with its canonical root source and fails on a missing or stale copy. Do not rely on npm traversing to repository-root legal files.

The internal `dist/waterbox-cli.js` artifact is package data used for provider bootstrap. It is not a public npm executable or export.

### Entry Point

The npm bin file must begin with:

```text
#!/usr/bin/env node
```

The bin entry invokes MCP `main()` unconditionally. It must not depend on direct-entry equality between `import.meta.url` and npm's symlinked `process.argv[1]`.

The executable emits no non-MCP stdout. Startup errors and optional diagnostics use stderr only and never include credentials, provider references, commands, local file content, response bodies, or protected URLs.

## Provider Configuration Contract

### Unconfigured Startup

The MCP process must connect when `WATERBOX_PROVIDER` is absent or unsupported configuration is incomplete.

The unconfigured backend:

- Registers the normal supported tool surface.
- Does not initialize SQLite or any concrete provider unnecessarily.
- Returns stable setup guidance from lifecycle and operation calls.
- Lists currently supported provider names and required configuration variable names.
- Never asks the model to provide a secret as a tool argument.
- Does not pretend the configured provider is Box.
- Performs no local file read, SQLite initialization, provider request, artifact load, or other operation side effect before returning setup guidance.

The setup guidance for Box identifies:

```text
WATERBOX_PROVIDER=box
BOX_API_KEY=<configured through the MCP client's environment or secret mechanism>
```

The package README provides client-specific examples for supported clients without placing a real key in command history or committed project configuration.

### Configuration Precedence

V0 configuration is environment-based:

1. Explicit process environment supplied by the MCP client.
2. Documented non-secret defaults for provider endpoints and timing only.
3. No provider selection default.

Waterbox does not read the Box CLI's login state, browser cookies, unrelated dotfiles, or provider-specific credential stores in V0.

Provider selection is parsed before provider-specific fields. Unknown providers receive a stable unsupported-provider message. Missing credentials leave the MCP connected and produce setup guidance. Malformed non-secret configuration may reject provider initialization but must not corrupt MCP stdout.

### add-mcp Limitation

Direct `add-mcp` package installation does not read package-specific `server.json` metadata and does not execute Waterbox during installation. The launch research baseline is `add-mcp@2.3.0`; it writes an MCP command equivalent to:

```json
{
  "command": "npx",
  "args": ["-y", "waterbox"]
}
```

The docs must therefore distinguish installation from provider configuration. Do not claim that bare `npx add-mcp waterbox` collects credentials.

CI and release evidence pin an explicit reviewed `add-mcp` version. The user-facing command remains unversioned. Advancing the certified installer version requires a reviewed dependency update and rerunning configuration-generation tests rather than silently testing whatever `latest` resolves to.

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
allocate provider resource
persist provider reference
prepare provider resource
verify Waterbox runtime
mark running
complete idempotency record
return sandbox
```

The caller does not see a separate bootstrap resource or action.

### Provider Contract

The provider contract must expose the allocation persistence boundary explicitly. The intended shape is conceptually:

```ts
interface SandboxProvider {
  allocateSandbox(input: ProviderCreateSandboxInput): Promise<ProviderSandboxObservation>
  prepareSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  inspectSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  deleteSandbox(input: ProviderOperationInput): Promise<ProviderSandboxObservation>
  // existing execution and optional capability groups
}
```

Exact names may follow repository conventions, but these semantics are mandatory:

- Allocation returns a valid opaque provider reference as soon as the provider accepts ownership of a resource.
- Core persists that reference before provider preparation begins.
- Preparation is safe to call again for the same resource and desired artifact version.
- A provider that needs no preparation implements a no-op or immediately verified preparation step.
- Core remains independent of Box artifact paths and installation commands.

Do not hide allocation and bootstrap inside one provider promise that returns the provider reference only after installation. That reintroduces untracked-resource failure.

### Core Durability

Core must support these records during creation:

```text
providerRef = null, state = provisioning
providerRef = <opaque>, state = provisioning
providerRef = <opaque>, state = running
providerRef = <opaque>, state = failed
```

Rules:

- A provider reference is never cleared after it has been persisted.
- Cancellation before provider acceptance may fail the operation normally.
- Cancellation after provider acceptance preserves the provisioning record and in-progress idempotency reservation.
- Reusing the same public idempotency key resumes allocation or preparation against the same Waterbox sandbox ID.
- If `providerRef` is null, allocation may use the same deterministic provider idempotency key and exact request to reconcile acceptance.
- If `providerRef` is present, allocation is not repeated; preparation resumes from that resource.
- A definite preparation failure stores a failed sandbox with its provider reference and a safe public error.
- A failed or provisioning sandbox with a provider reference remains deletable.
- Ordinary post-acceptance failure must surface the public sandbox record or a stable public sandbox ID so the caller can recover or delete it.
- A transport cancellation can prevent a response; same-key replay is the recovery path.

The existing behavior that returns `idempotency_in_progress` forever for every provisioning record must change. Same-key replay must actively resume recoverable creation while preventing duplicate concurrent work.

### Concurrency

V0 Direct MCP is one local process, but correctness must not rely only on a process-local flag:

- Exact provider allocation replay must preserve one provider resource.
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

Both requests use the existing deterministic provider idempotency key. The Box account API key is never injected into the Box.

### Artifact

The npm package ships an immutable Node bundle plus build metadata. Provider composition loads it relative to the installed package, not the current working directory.

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
4. Check the uploaded SHA-256 before installation.
5. Install the bundle atomically as `/usr/local/lib/waterbox-cli.js`.
6. Install the launcher atomically as `/usr/local/bin/waterbox` with mode `0755`.
7. Create `/workspace` with the intended user ownership.
8. Create `/run/waterbox/bash-jobs` with mode `0700`.
9. Write `/usr/local/lib/waterbox-bootstrap.json` last through atomic replacement.
10. Verify the manifest, `waterbox health`, `waterbox version`, `node --version`, and `rg --version`.

The launcher uses Node:

```sh
#!/bin/sh
set -eu
sudo -n install -d -m 0755 -o "$(id -u)" -g "$(id -g)" /workspace
sudo -n install -d -m 0700 /run/waterbox/bash-jobs
cd /workspace
exec sudo -n env WORKSPACE_ROOT=/workspace /usr/local/bin/node /usr/local/lib/waterbox-cli.js "$@"
```

The exact quoting and privilege boundaries require tests. No secret is embedded in the launcher or manifest.

### Manifest

The bootstrap manifest contains only non-secret compatibility facts:

```json
{
  "schemaVersion": 1,
  "artifactSha256": "<lowercase SHA-256>",
  "artifactVersion": "0.1.0",
  "cliProtocolVersion": 2,
  "nodeMajor": 24,
  "bootstrapVersion": 1
}
```

The manifest is the read-only reconciliation signal after an ambiguous installation response. It is not a provider credential or Waterbox repository record.

### Ambiguity

Bootstrap has a distinct retry policy from user commands:

- Lost keyed Box allocation is reconciled by exact same-key, same-body replay.
- Lost artifact upload may repeat the exact write to the same deterministic temporary path or verify the path before repeating.
- Lost installation response triggers read-only manifest and health verification first.
- If verification proves the desired digest and protocol, preparation succeeds.
- If verification proves an incomplete installation, the explicitly idempotent installer may run again.
- If verification remains uncertain, the sandbox remains provisioning with its provider reference.
- User tool commands remain one-shot and are never retried by this bootstrap policy.

### Forks, Snapshots, And Resume

- Every new Box created from a Waterbox snapshot receives the current runtime installation.
- User filesystem content from the snapshot remains authoritative outside Waterbox-owned runtime paths.
- Installation may overwrite only Waterbox-owned paths under `/usr/local/lib`, `/usr/local/bin/waterbox`, and `/run/waterbox`.
- `/workspace` is recreated because Box does not preserve it in named snapshots.
- `/run` jobs and secure-transfer identities are runtime state and are not restored.
- Stop/resume retains installed files and packages according to Box documentation.
- Existing stopped sandboxes are not upgraded merely because a newer npm package starts locally.

## Error, Cancellation, And Cleanup Semantics

### Before Provider Acceptance

- Validation, provider selection, credential, ownership, limit, and definite create rejection errors may fail normally.
- No provider reference is persisted unless a provider resource identity was positively correlated.
- Exact keyed create replay remains allowed only for documented ambiguous acceptance cases.

### After Provider Acceptance

- Persist the provider reference before waiting for readiness or installing files.
- Never convert an accepted resource back to `providerRef: null`.
- Cancellation preserves recoverable provisioning state.
- Definite bootstrap failure stores failed state and a safe error while preserving deletion capability.
- Unresolved bootstrap ambiguity preserves provisioning state and in-progress idempotency.
- A failed response must not expose Box IDs, API keys, commands, response bodies, request IDs, or temporary paths.

### Deletion

Deletion must support provisioning and failed sandboxes when a provider reference exists. It uses the existing provider-specific permanent-deletion confirmation and bounded reconciliation behavior.

Waterbox does not silently delete an accepted Box merely because bootstrap failed. The public Waterbox resource remains the ownership and recovery handle unless a separately designed cleanup action is explicitly requested.

## Licensing And Notices

### Project License

Add the standard Apache License 2.0 text as `LICENSE` at the repository root and make it package-visible. Package metadata uses the SPDX expression:

```json
"license": "Apache-2.0"
```

Add `NOTICE` containing factual project attribution to `Waterbox contributors`. Do not add endorsement language or claim ownership of third-party code.

Canonical legal files live at the repository root. Package-local copies under `packages/mcp/` are generated or synchronized for npm packaging and are checked byte-for-byte before pack and publish.

### Third-Party Inventory

The final MCP and sandbox CLI bundles, not the full lockfile, determine the shipped notice set.

Known embedded candidates use permissive licenses, including:

- MIT: `@modelcontextprotocol/sdk`, Zod, AJV, Noble packages, Scure packages, and related helpers.
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
- Confirm `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md` are present in the packed tarball.
- Confirm package-local legal files exactly match their canonical root files.

This plan records engineering requirements, not legal advice. Any ownership or commercial-policy concern discovered during publication remains a release blocker.

## Documentation Contract

The package README must lead with:

```sh
npx add-mcp waterbox
```

It must then explain:

- Installation does not select a provider.
- Waterbox starts connected but unconfigured.
- The supported providers table.
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

Status: pending

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
- Snapshot-sourced creation followed by runtime overwrite.
- Permanent cleanup and exact baseline reconciliation.

Acceptance criteria:

- Credential-free baseline is recorded.
- The live probe cannot run without exact authorization and isolated-account gates.
- Sanitized observations support every Box bootstrap assumption.
- No provider IDs, credentials, raw bodies, commands, or protected URLs are committed.
- A failed probe blocks Phase 3 rather than adding apt or Bun fallback installation.

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

Status: implemented locally; Node 24.15.0 verification pending; depends on Phase 0 credential-free baseline

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

Status: implemented locally; Node 24.15.0 and latest Node 24 CI verification pending; depends on Phase 1

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

Run the generated artifacts under the declared Node minimum and latest Node 24 LTS patch in CI.

### Phase 3: Durable Provider Preparation

Status: pending; depends on Phases 0 and 2

Scope:

- Split provider allocation from preparation.
- Persist accepted provider references before bootstrap.
- Resume same-key provisioning safely.
- Preserve recovery and deletion for failed or ambiguous preparation.

Acceptance criteria:

- Core stores the Box identity before any file upload or installation command.
- Same-key replay resumes null-reference allocation or referenced preparation correctly.
- Definite post-acceptance failure preserves a public failed resource and provider reference.
- Unresolved ambiguity preserves provisioning and in-progress idempotency.
- Every ordinary post-acceptance failed or unresolved create response gives the caller the public sandbox record or stable public sandbox ID required by `probe_sandbox` and `delete_sandbox`; focused MCP tests prove the recovery handle is usable.
- Provisioning and failed resources with provider references are deletable.
- Concurrent preparation converges without duplicate provider resources or corrupt installation.
- Existing no-retry semantics for user operations remain unchanged.
- Provider-neutral tests use simple fakes; Box-specific paths do not leak into core.

Required fault points include:

- Before provider acceptance.
- Accepted response lost.
- After provider reference persistence.
- During readiness wait.
- Artifact upload response lost.
- Installation response lost before and after completion.
- Health verification failure.
- Cancellation at every boundary.
- Process reconstruction from SQLite followed by same-key replay.

Verification:

```sh
bun test packages/sandbox-core/test packages/sandbox-provider-box/test packages/mcp/test
bun run typecheck
git diff --check
```

No live Box call is required for the credential-free completion of this phase.

### Phase 4: Box Bootstrap-On-Create

Status: pending; depends on successful live Phase 0 calibration and Phase 3

Scope:

- Remove Box's system-template source from fresh creation.
- Inject the packaged Node CLI artifact into the Box provider.
- Upload, install, manifest, verify, and reconcile the artifact.
- Re-bootstrap snapshot-sourced Boxes.

Acceptance criteria:

- Fresh create omits `from`.
- Snapshot create uses only the user snapshot reference.
- No `BOX_SYSTEM_TEMPLATE_REF` configuration remains in supported MCP or local API composition.
- No Bun download, apt command, or ripgrep installation occurs.
- Installation is deterministic, bounded, idempotent, and secret-free.
- Manifest and health verification reconcile ambiguous installation responses.
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

Then run one separately authorized isolated-account live Direct MCP smoke covering fresh creation, all tools, secure transfer, quick and dispatched Bash, stop/resume behavior where exposed, snapshot creation, snapshot-sourced creation, current-runtime overwrite, deletion, and exact baseline reconciliation.

### Phase 5: Package, License, And Documentation

Status: pending; depends on Phase 4

Scope:

- Rename the package and executable to `waterbox`.
- Remove the public library export.
- Add complete npm metadata.
- Add Apache-2.0 licensing and exact bundled-code notices.
- Rewrite package and root documentation for the launch architecture.
- Remove supported-path system-template documentation and scripts after successful bootstrap verification.

Acceptance criteria:

- `npx waterbox` resolves the sole package bin and starts stdio MCP.
- `npx add-mcp waterbox` writes the expected package command and inferred server name.
- The tarball contains only approved files.
- Package metadata points at the actual repository and issue tracker.
- License and notices cover both generated bundles.
- OpenCode adapted-code paths are correct.
- README examples contain placeholders only.
- Root docs distinguish supported, experimental, and historical components.
- `server.json` is either valid for an owned namespace or omitted from the release tarball and explicitly deferred.

Verification:

```sh
bun test
bun run typecheck
bun run build:mcp
npm pack --dry-run ./packages/mcp
npx publint ./packages/mcp
git diff --check
```

The phase must add an installed-tarball test in an external temporary directory and inspect the actual packed file list, executable mode, shebang, bundle imports, and license files.

### Phase 6: CI And Release Automation

Status: pending; depends on Phase 5

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
- Node minimum and latest-LTS artifact tests.
- Package dry-run and installed-tarball test.
- License/notice closure check.
- `publint` and metadata validation.
- `server.json` schema validation only if registry metadata is included.

Publish workflow requirements:

- GitHub-hosted runner.
- `contents: read` and `id-token: write` only, plus any minimal release permission intentionally required.
- npm CLI and Node versions compatible with trusted publishing.
- No long-lived npm publish token.
- A protected GitHub environment with required approval is preferred.
- Build and test from the exact tag commit.
- Verify tag, package, MCP implementation, artifact manifest, and optional `server.json` versions agree.
- Pack the package twice in isolated clean directories and require identical file lists and content hashes; document any unavoidable archive-metadata difference instead of weakening content reproducibility.
- Select one `.tgz`, record its SHA-256, install and test that exact file, and publish that exact inspected `.tgz`. Do not publish the package directory, because npm would repack it.
- Retain npm provenance.
- Never publish from `pull_request_target` or untrusted checked-out code.

Acceptance criteria:

- CI catches stale bundles, version drift, missing notices, and runtime Bun dependencies.
- CI records and uses the explicit certified `add-mcp` version for configuration-generation tests.
- Release publication cannot run from an arbitrary branch or fork.
- The first package can establish npm trusted publishing safely; any unavoidable bootstrap publish is documented and immediately followed by trusted-publisher restriction.
- Publication failure does not mutate versions or tags automatically.

### Phase 7: Release Candidate And npm Launch

Status: pending; depends on Phase 6

Scope:

- Reserve or publish the currently unclaimed `waterbox` npm name.
- Execute final clean-environment and isolated-account release gates.
- Publish `waterbox@0.1.0`.
- Verify public installation without changing client secrets automatically.

Release candidate gates:

1. Clean checkout of the intended tag commit.
2. Full CI green.
3. Packed tarball reviewed and checksum recorded in release evidence.
4. No secrets or local state in tarball.
5. Node minimum and latest Node 24 launch pass with Bun absent.
6. Unconfigured MCP connects and returns provider-neutral setup guidance.
7. Configured isolated-account Box smoke passes and returns to exact baseline.
8. The pinned certified `add-mcp` version generates correct `waterbox` configurations for representative clients in temporary homes; the unversioned user command is checked once as a release observation and its resolved version is recorded.
9. npm account ownership, 2FA, trusted publisher, and package access are verified.
10. Documentation describes actual released behavior only.

Post-publication verification:

```sh
npm view waterbox@0.1.0
npm exec --yes --package=waterbox@0.1.0 -- waterbox
npx add-mcp@2.3.0 waterbox@0.1.0 --name waterbox -a opencode -y
```

The MCP process command requires a protocol-aware smoke harness; do not treat an indefinitely waiting stdio server as a failed CLI command.

Verify npm provenance, package files, README rendering, issue links, and deprecation status. Do not publish a replacement version merely to fix documentation that can be corrected before the initial release.

### Phase 8: Registry Discovery

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

This phase requires a new package version if ownership metadata was not included in `0.1.0`.

## File Impact Map

Expected primary files:

```text
package.json
.env.example
README.md
LICENSE
NOTICE
THIRD_PARTY_NOTICES.md
.github/workflows/*

packages/mcp/package.json
packages/mcp/README.md
packages/mcp/server.json
packages/mcp/LICENSE
packages/mcp/NOTICE
packages/mcp/THIRD_PARTY_NOTICES.md
packages/mcp/src/main.ts
packages/mcp/src/config.ts
packages/mcp/src/direct.ts
packages/mcp/src/server.ts
packages/mcp/test/*

packages/sandbox-repository-sqlite/src/index.ts
packages/sandbox-repository-sqlite/test/*

packages/sandbox-core/src/provider.ts
packages/sandbox-core/src/service.ts
packages/sandbox-core/test/*

packages/sandbox-provider-box/src/index.ts
packages/sandbox-provider-box/test/*
packages/sandbox-provider-box/README.md

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

scripts/direct-mcp-smoke.ts
scripts/build-box-system-template.ts
scripts/build-box-system-template.test.ts
docs/box-system-template.md
```

Do not delete system-template machinery until the plain-Box bootstrap live gate passes. Removal is a late cleanup in Phase 5, not an assumption in earlier phases.

## Verification Matrix

### Credential-Free

| Area | Required proof |
|---|---|
| Configuration | Missing provider connects; malformed provider config is safe; Box is never selected implicitly |
| SQLite | Node API parity, durability, CAS, pagination, malformed rows, close behavior |
| MCP | stdio handshake, tool listing, setup guidance, cancellation, diagnostics redaction |
| Unconfigured safety | Absent/unknown/incomplete provider returns guidance before local file, SQLite, artifact, or provider I/O |
| CLI | health, version, all tools, secure transfer, quick and dispatched Bash |
| Core | accepted-reference persistence, same-key resume, concurrency, failure recovery |
| Box adapter | exact request bodies, deterministic upload, idempotent install, ambiguity reconciliation |
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
- All canonical tools and secure transfer work.
- Quick, dispatched, nonzero, and timed-out Bash behavior remains correct.
- Stop/resume behavior preserves installed runtime where tested.
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

- [ ] Phase 0 baseline recorded.
- [ ] Plain Box Node/rg/bootstrap capability calibrated live.
- [x] Shared SQLite migrated to Node.
- [x] Local MCP runs on Node 24 without Bun.
- [x] In-Box CLI runs on Node 24 without Bun.
- [ ] Provider allocation reference persists before bootstrap.
- [ ] Same-key create resumes provisioning safely.
- [ ] Fresh Box creation no longer uses a system snapshot.
- [ ] Snapshot-sourced creation installs the current runtime.
- [ ] System-template configuration and supported-path docs removed.
- [ ] npm package renamed to `waterbox`.
- [ ] Package is CLI-only.
- [ ] Missing provider is a connected setup state.
- [ ] Apache-2.0 license and complete notices included.
- [ ] Package-local legal files match canonical root files exactly.
- [ ] npm metadata complete and factual.
- [ ] Root and package docs match released behavior.
- [ ] Pull-request CI complete.
- [ ] Trusted npm publish workflow protected.
- [ ] Installed-tarball test passes with no Bun.
- [ ] Exact tested tarball checksum is preserved through npm publication.
- [ ] Isolated-account release smoke passes with exact cleanup reconciliation.
- [ ] `waterbox@0.1.0` published with provenance.
- [ ] `npx add-mcp waterbox` verified from a clean environment.
- [ ] Official MCP registry decision remains explicitly deferred or receives a separate approved phase.

## Implementation Log

- 2026-08-31: Plan created from the npm launch review. Settled the unscoped `waterbox` package, CLI-only distribution, provider-neutral explicit configuration, Node 24 local and sandbox runtimes, plain-Box bootstrap, accepted-resource persistence, Apache-2.0 licensing, tarball verification, trusted npm publication, and official registry deferral. No implementation or live provider operation occurred while writing the plan.
- 2026-08-31: Phase 1 implementation migrated repository statements to `prepare()` and made `node:sqlite` `DatabaseSync` the default runtime, preserving explicit no-create behavior, read-only access, disabled foreign-key enforcement, numeric change counts, durability, CAS, pagination, malformed-row handling, and idempotent close. A package-local conditional adapter keeps Bun 1.3.2 test and local API tooling operational without including `bun:sqlite` in Node-targeted bundles. Verification passed 74 focused Bun tests, typecheck, `git diff --check`, a Node-targeted bundle inspection, and the focused repository compatibility test on Node 25.2.1 and installed Node 24.6.0. The declared minimum Node 24.15.0 is not installed locally, so that exact runtime check remains pending.
- 2026-08-31: Phase 2 implementation moved the MCP bin and one-shot CLI to Node-targeted ESM with Node shebangs, bundled the CLI into the npm package, changed detached Bash worker execution to `/usr/local/bin/node`, and replaced secure-transfer `Bun.spawn` calls with bounded Node child-process handling. Unconfigured, unknown, unsupported, incomplete, and malformed provider setups now remain connected and preflight every tool before SQLite, provider, bootstrap-artifact, or local-file I/O. Box template installation now uses the existing `/usr/local/bin/node` and rejects Bun artifacts. Verification passed all 315 repository tests, typecheck, both Node syntax checks, template validation, exact artifact scans with no Bun runtime references, Node stdio and CLI execution on Node 25.2.1 and installed Node 24.6.0, and a clean packed-package npm-bin symlink launch. No live Box operation occurred. The declared Node 24.15.0 floor and latest Node 24 CI runs remain pending because those runtimes are not installed locally.
- 2026-08-31: The Node-only product follow-up replaced Bun artifact generation and `prepack` with an esbuild script executed by Node. MCP and CLI source bundles now build, pack, install, and launch with Bun absent from `PATH`; the npm allowlist and exact artifact scan exclude the repository's test-only Bun SQLite adapter. Active template documentation and the ignored local `user-probe` configuration now point at Node and `dist/waterbox.js`. The complete 315-test repository suite, typecheck, Node 25.2.1 clean pack/install/stdio launch, installed Node 24.6.0 build and CLI execution, artifact scans, and `git diff --check` pass. Exact Node 24.15.0 and latest Node 24 CI verification remain pending.
