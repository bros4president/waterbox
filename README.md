# oc-remote

OpenCode 2 tools backed by an isolated, stateful AWS Lambda MicroVM.

The project-local OpenCode 2 plugin provides remote shell, read, write, glob, grep, edit, and patch tools. Project-local permissions deny the corresponding built-in workspace tools so execution cannot silently fall back to the local machine. The plugin lazily launches one MicroVM when a tool is first called, sends tool requests directly to its authenticated HTTPS receiver, and reuses its `/workspace` until AWS terminates the MicroVM.

## Structure

```text
packages/plugin    OpenCode 2 tool registrations and MicroVM lifecycle client
packages/protocol  Shared endpoint paths, request types, and response types
packages/receiver  Stateful HTTP tool receiver included in the MicroVM image
scripts/deploy.ts  Idempotent image deployment
scripts/smoke.ts   End-to-end AWS smoke test
```

The receiver's edit and patch implementations include code adapted from OpenCode. See `THIRD_PARTY_NOTICES.md` for source attribution and license details.

## Configuration

The project-local tools use:

- AWS profile: `playground`
- Region: `us-east-1`
- Image: `arn:aws:lambda:us-east-1:570435243986:microvm-image:oc-remote-receiver`

The AWS profile is resolved with the standard AWS SDK credential chain. No access keys are stored by this project.

The plugin options are configured in the project-local `opencode.json`.

OpenCode 2 loads the local plugin from `packages/plugin/src/index.ts`. The plugin is pinned to the same beta version as the `opencode2` CLI because the V2 API is still changing.

## Commands

```bash
bun install
bun test
bun run typecheck
bun run deploy --profile playground --region us-east-1
bun run smoke
```

The deploy script creates or reuses:

- `s3://oc-remote-artifacts-570435243986-us-east-1`
- IAM role `oc-remote-microvm-image-builder`
- MicroVM image `oc-remote-receiver`

Deployment state is written to `.oc-remote/deployment.json`.

## Demo

Start OpenCode from this directory, then ask it to:

```text
Clone https://github.com/octocat/Hello-World.git into /workspace/hello-world,
find Markdown files under /workspace/hello-world, search them for "Hello World",
read the README, and add /workspace/hello-world/oc-remote-demo.txt with a patch.
```

The first tool call creates the sandbox. Later calls reuse its memory and disk. AWS suspends it after five idle minutes, resumes it on endpoint traffic, and terminates it after 60 suspended minutes or eight total hours.

The receiver image requires at least 8 GiB of memory. AWS selects the actual vCPU, memory, and disk allocation that satisfies this image requirement.

## Current Limits

- The sandbox starts empty; local project files are not synchronized.
- A plugin process does not rediscover a MicroVM after OpenCode restarts, so a restart creates another sandbox.
- Workspace state is ephemeral and disappears when the MicroVM terminates.
- Workspace access is provided by `remote_shell`, `remote_read`, `remote_write`, `remote_glob`, `remote_grep`, `remote_edit`, and `remote_patch`.
- Read returns at most 2,000 lines or directory entries and 50 KiB per call; individual text lines are previewed up to 2,000 characters. Use `offset` and `limit` to continue a truncated read.
- Glob and grep return at most 2,000 results per call and time out after 10 seconds. Grep line previews are capped at 2,000 characters.
- Tool request bodies are capped at 1 MiB.
- Bash output retained in the final result is capped at 1 MiB.
