# Agent Tool Contract Research

> Status: research and discussion only. This document records existing tool contracts and design signals; it does not define the sandbox service API.

Date: 2026-08-23

## Revisions Inspected

- Pi: `a69bef789bc95abf0acee16f7b4660b70b650bb9`
- Codex: `c9b19deb09c1841ce7acc33ddb96276030936a29`
- OpenCode `dev`: `fa117558ee13c1ae2aa28aa11a62c218eb592e47`
- OpenCode `v2`: `89451c3e322fe1b7643dbd62d0b74ab45663512a`

OpenCode `v2` means the active `v2` branch, not the stale 2.0 branch.

## Tool Availability

| Capability | Pi | Codex | OpenCode | OpenCode v2 |
|---|---|---|---|---|
| Shell | `bash` | `exec_command` | `bash` | `shell` |
| Read file | `read` | shell | `read` | `read` |
| Write file | `write` | patch or shell | `write` | `write` |
| Edit file | `edit` | patch or shell | `edit` | `edit` |
| Apply patch | absent | `apply_patch` | `apply_patch` | `patch` |
| List directory | `ls` | shell | `read` | `read` |
| Glob | `find` | shell | `glob` | `glob` |
| Grep | `grep` | shell | `grep` | `grep` |

## Result Architecture

### Pi

```ts
{
  content: Array<TextContent | ImageContent>
  details?: ToolSpecificMetadata
}
```

`content` goes to the model. `details` supports the UI and logs. Errors become text content with an error flag in the agent transcript and are adapted per provider.

### Codex

Direct model-facing tool results are usually human-readable text. `exec_command`, for example, reports a chunk ID, wall time, exit code or running session ID, token count, and output. Structured representations exist internally and for some code-mode paths.

### OpenCode

```ts
{
  title: string
  output: string
  metadata: Record<string, unknown>
  attachments?: FilePart[]
}
```

The model primarily receives `output`; metadata supports UI and runtime behavior.

### OpenCode v2

```ts
{
  structured: ToolSpecificOutput
  content: Array<TextContent | FileContent>
  metadata?: Record<string, JSON>
}
```

This separation closely resembles MCP's `structuredContent`, `content`, and protocol/application metadata. It is a strong design signal, not yet a decision for this project.

## Shell

### Inputs

| Project | Input |
|---|---|
| Pi | `{ command, timeout? }`, timeout in seconds |
| Codex | `{ cmd, workdir?, tty?, yield_time_ms?, max_output_tokens?, shell?, login?, environment_id?, ... }` |
| OpenCode | `{ command, timeout?, workdir? }`, timeout in milliseconds |
| OpenCode v2 | `{ command, workdir?, timeout?, background? }`, timeout in milliseconds |

All combine stdout and stderr. Non-zero process exit is generally a completed tool result, not a tool-protocol failure.

Output limits differ:

- Pi keeps the last 2,000 lines or 50 KiB and stores complete output separately.
- Codex collects up to 1 MiB using head/tail retention, then applies a model token limit.
- OpenCode keeps a configurable tail, defaulting to 2,000 lines/50 KiB.
- OpenCode v2 keeps a configurable tail and adds typed process status and first-class background execution.

## Read File

### Inputs

| Project | Input |
|---|---|
| Pi | `{ path, offset?, limit? }` |
| Codex | absent; use `exec_command` |
| OpenCode | `{ filePath, offset?, limit? }` |
| OpenCode v2 | `{ path, offset?, limit? }` |

Offsets are conceptually 1-based. Pi returns unnumbered text. OpenCode and v2 render numbered lines. OpenCode v2 additionally returns typed `file`, `text-page`, or `list-page` output with continuation offsets.

Pi handles common images. OpenCode and v2 handle images and PDFs as native attachments/content. Arbitrary binary files are rejected or unsuitable for the text interface.

## Write File

All projects with a dedicated tool converge on a path plus complete UTF-8 content. They create missing parents and overwrite existing files.

OpenCode v2 changed `filePath` to `path` and returns:

```ts
{
  operation: "write"
  target: string
  resource: string
  existed: boolean
}
```

Pi and the OpenCode implementations serialize same-file mutations. OpenCode variants preserve BOM and may run formatters after writing.

## Edit File

Pi exposes batched replacements against one file:

```ts
{
  path: string
  edits: Array<{ oldText: string; newText: string }>
}
```

Every replacement is matched against the original file, overlap is rejected, and the file write is all-or-nothing.

OpenCode and v2 expose one replacement per call:

```ts
{
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}
```

OpenCode uses many fuzzy strategies. V2 moved toward exact-first matching with restrained normalization for typography, trailing whitespace, line endings, and BOM. Pi also uses exact-first matching with compatibility normalization.

Pi's nested `edits[]` format has caused models from several providers to mix schemas, stringify arrays, or invent fields. Pi added argument repair and compatibility preprocessing. This illustrates the tradeoff between fewer calls and more difficult structured generation.

## Apply Patch

Pi deliberately has no built-in `apply_patch`. Codex, OpenCode, and v2 converge on the same general language:

```text
*** Begin Patch
*** Add File: path
+content
*** Update File: path
@@
-old
+new
*** Move to: path
*** Delete File: path
*** End Patch
```

Codex exposes it as a freeform custom tool. OpenCode uses `{ patchText }` under `apply_patch`; v2 uses `{ patchText }` under `patch`.

All three upstream implementations apply multi-file operations sequentially and can partially commit. OpenCode v2 explicitly reports operations completed before failure. The current `oc-remote` receiver's transaction/rollback behavior is stronger than these references.

## List Directory

Pi has a dedicated `ls` tool with optional path and limit. OpenCode and v2 overload `read` for files and directories. Codex delegates to shell commands.

OpenCode v2's typed directory page is the richest result:

```ts
{
  type: "list-page"
  entries: Array<{
    path: string
    type: "file" | "directory" | "symlink"
  }>
  truncated: boolean
  next?: number
}
```

## Glob

Pi calls the tool `find`. Pi and OpenCode v2 expose `pattern`, optional `path`, and optional `limit`. OpenCode hard-codes a 100-result limit. None of the inspected implementations provides cursor pagination.

Pi emits paths relative to the search root. OpenCode emits absolute paths. OpenCode v2 has relative typed values but renders absolute paths to the model.

## Grep

Pi exposes the richest input:

```ts
{
  pattern: string
  path?: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  context?: number
  limit?: number
}
```

OpenCode uses `pattern`, optional `path`, and optional `include`. V2 adds `limit` and returns structured path, line, byte offset, text, and submatch ranges.

Pi renders `path:line:text`. OpenCode and v2 group matches by file and render `Line N: text`. All are understandable to models; the main contract concerns are deterministic paths, bounds, ordering, and explicit truncation.

## OpenCode to OpenCode v2 Signals

| OpenCode | OpenCode v2 |
|---|---|
| `bash` | `shell` |
| `apply_patch` | `patch` |
| `filePath` | `path` |
| Primarily text output | Structured output plus model content and metadata |
| Relative paths tolerated but descriptions claim absolute | Relative path behavior documented |
| Hard-coded search limits | Explicit `limit` |
| Aggressive fuzzy edit | Exact-first with restrained normalization |
| Foreground shell | First-class background mode |
| UI/LSP-heavy output | Compact deterministic model output |
| Untyped directory read | Typed paginated entries |

The broad direction is to keep canonical typed results separate from concise model-readable content and to handle provider quirks after the canonical tool boundary.

## Model and Provider Assumptions

### Codex

Codex supports ChatGPT/OpenAI, Azure, Bedrock, Ollama, LM Studio, and custom providers. It is not fully provider-neutral: custom providers primarily emulate the OpenAI Responses API and Codex model/tool conventions.

The shell-and-patch design is partly subsidized by model training:

- An OpenAI collaborator stated that the patch format was specific to OpenAI models because it improved accuracy and model performance.
- Codex source notes that the model is trained on `session_id` for shell continuation.
- A maintainer response characterized dedicated read/write failures as model behavior that future training should improve.

Relevant discussions:

- <https://github.com/openai/codex/issues/26#issuecomment-2810321199>
- <https://github.com/openai/codex/issues/9842#issuecomment-3796074799>
- <https://github.com/openai/codex/discussions/7782>

Codex therefore places substantial complexity in trained shell composition and exact tool conventions rather than in a large typed tool surface.

### Pi

Pi intentionally did not special-case `apply_patch` merely because Codex-trained models call it. Its normal editing path is batched exact replacement, whole-file write, or ordinary shell tooling such as `git apply`, codemods, and scripts. Extensions can add a patch tool.

Relevant discussion:

- <https://github.com/earendil-works/pi/issues/143#issuecomment-3628224105>
- <https://github.com/earendil-works/pi/issues/2639>
- <https://github.com/earendil-works/pi/issues/6278>

Pi serves more provider families directly and contains more schema coercion, naming adaptation, strict-sampling capability checks, and repair for common malformed tool arguments.

## Standalone Tool MCP Smoke Observation

On 2026-08-23, `@earendil-works/pi-coding-agent@0.84.2` was run directly inside AWS MicroVM image `oc-remote-receiver:5.0`. A local stdio MCP facade discovered and proxied its seven standalone contracts. OpenCode `v0.0.0-beta-17963` connected to the MCP server and logged discovery of all seven tools.

The preliminary run was contaminated and is not evidence for harness-neutral behavior. Its MCP namespace was `pi_remote`, and the prompt explicitly called the tools remote Pi tools. It did demonstrate that the transport and all seven tool executions worked when OpenCode exposed them, but it advertised both their implementation source and execution target.

The corrected run used neutral MCP server metadata and the `workspace` namespace. Model-visible descriptions remained the unchanged standalone descriptions, and neutral paths and marker values removed indirect Pi references. The prompt disclosed only that `workspace_*` accessed a remote environment. The OpenCode process used an empty temporary working directory so project permissions and plugins could not affect either variant.

In both corrected variants, including the variant with native filesystem and shell tools denied, OpenCode logged a successful MCP connection and discovery of seven tools but presented no `workspace_*` tools to the model. The model made no tool calls, the expected remote file did not exist, and the temporary local workspace remained unchanged. An explicit `workspace_*` allow rule did not change this result. The valid smoke therefore failed after MCP discovery, in or before construction of the model-facing tool snapshot. The cause was not resolved and may be selection policy, location-scoped registration behavior, or a beta defect.

The same OpenCode build ignored `OPENCODE_CONFIG_CONTENT` for standalone CLI/API invocations during this smoke. An explicit temporary file supplied through `OPENCODE_CONFIG` loaded the MCP server correctly.

## Control-Plane MCP Smoke Observation

On 2026-08-27, the experimental local control-plane MCP was tested with `@opencode-ai/cli` beta `0.0.0-beta-18414` and dev `0.0.0-dev-18434`. Both builds connected the `remote` stdio MCP server and discovered its two tools, but a one-shot `opencode2 run --standalone` session took its model-facing tool snapshot before the later MCP registration was reconciled. Neither direct tools with `codemode: false` nor the default Code Mode `execute` tool reached that first session.

A private `opencode2 serve` process removed that race. The harness waits for `/api/mcp` to report the `remote` server as connected before attaching `opencode2 run --server`. Code Mode then exposed the `remote` namespace, and the model called `tools.remote.create_sandbox({})` and `tools.remote.bash(...)` through `execute`. The MCP's idempotent selection prevented more than one provider sandbox creation.

The live smoke stopped at an inherited provider/core boundary. Sandbox creation succeeded, but every bash request mapped to `ambiguous_execution`; the API stream ended without a terminal result, and the MCP reported `Waterbox bash returned an incomplete stream`. The experiment did not repair that deferred defect. Emergency cleanup returned the Box account to zero active and zero visible sandboxes.

The MCP facade was then expanded to the complete implemented control-plane surface: `read`, `write`, `edit`, `patch`, `glob`, `grep`, and `bash`, in addition to MCP-only `create_sandbox`. A span smoke isolated each tool call so one failure could not prevent later calls. Sandbox creation succeeded, all seven sandbox tools were attempted exactly once, and none completed. Every tool reached the same provider/core `ambiguous_execution` boundary and surfaced as an incomplete NDJSON stream. The defect therefore affects the entire sandbox tool surface, not only bash streaming.

The OpenCode startup race also remained observable. Even after MCP status reported connected and the harness explicitly disconnected and reconnected the server, the first Code Mode execution could hold a stale empty runtime catalog and report every `remote` tool as unknown. A catalog update within the same session allowed the model to retry with all eight entries. API deletion timed out after the failed tool sweep, but emergency provider cleanup removed the Box and again confirmed zero active and zero visible sandboxes.

A subsequent gated smoke separated creation from tool execution. OpenCode created a sandbox that core reported as `running`; before allowing any sandbox tool call, the host process obtained the Box protected hosting route and requested its `/health` endpoint directly. That external health probe failed, so the harness correctly withheld the seven-tool phase. This confirms the immediate readiness gap: Box lifecycle readiness plus successful hosting registration does not prove that the restored daemon is reachable. API cleanup again timed out, while emergency provider cleanup returned the account to zero active and zero visible sandboxes.

Timed readiness polling then distinguished startup from hosting. Over 30.186 seconds, 36 protected `/health` requests all returned HTTP `403`. Read-only in-VM diagnostics reported the daemon unit enabled and active, its main process running with exit status zero, port `8788` listening, and both localhost `/health` and `/v1/tools` returning HTTP `200`. The seven-tool phase remained gated. This rules out daemon bootstrap latency for that run and localizes the immediate failure to protected-host access or authentication rather than the template service or canonical daemon routes.

The official Box platform guide resolves the recommended daemon contract: use an enabled systemd service, bind HTTP on `0.0.0.0`, execute `host <port> --private` through `POST /boxes/{boxId}/commands`, and store the `_token` URL printed to stdout as the backend credential. The full hosting reference also documents `POST /boxes/{boxId}/host`, so the adapter's earlier endpoint was supported but was not the platform guide's in-box daemon sequence. The provider and gated smoke now use the command sequence and reject command failures or stdout without a valid protected HTTPS URL.

Further live probes identified the actual GET authentication behavior. A token-bearing request returns a same-origin `302` and an authentication cookie; ordinary server-side `fetch` follows the redirect without retaining that cookie and ends at `403`. A bounded manual same-origin redirect with the issued cookie makes `/health` and `/v1/tools` succeed immediately. Protected tool `POST`s still receive the initial `302`, but replaying the same method and body to the same redirected path with that cookie returns a hosting-layer JSON `404`, not the daemon's canonical 404 envelope. All seven POSTs are therefore rejected before a daemon result is observed. The official documentation specifies no additional header, CSRF token, or non-browser authentication flow, so completing the daemon tool smoke now requires clarification or a fix from Box for authenticated non-GET requests. Every probe cleaned up to zero visible and active Boxes; inherited API deletion polling still timed out and emergency cleanup completed.

## Candidate Root Shape Discussed

The benchmark suggests, but does not decide, a root result shaped approximately as:

```ts
type ToolResult<T> = {
  structured: T
  content: Content[]
  metadata?: Record<string, JSON>
}
```

Possible transport mappings would be mechanical:

```text
MCP structuredContent <- structured
MCP content           <- content
REST JSON             <- canonical result
CLI default           <- rendered content
CLI --json            <- canonical result
```

Potential root inputs discussed were:

```text
bash:           command, workdir?, timeout_ms?
read_file:      path, offset?, limit?
write_file:     path, content
edit_file:      path, old_string, new_string, replace_all?
apply_patch:    patch_text
list_directory:path?, offset?, limit?
glob:           pattern, path?, limit?
grep:           pattern, path?, include?, limit?
```

These names and fields remain open for discussion.

## Open Questions

- Should shell be named `bash`, `shell`, or `exec_command`?
- Should timeout fields encode the unit in their name?
- Should read and directory listing remain separate?
- Should edit support one replacement or a batch?
- How much fuzzy edit matching is safe?
- Should patch use a JSON string field or a freeform tool when available?
- Should paths returned to the model be workspace-relative or sandbox-absolute?
- Should search expose cursors, offsets, or only bounded limits?
- Which structured fields belong in canonical results versus metadata?
- Should full truncated output be retained inside the sandbox, in control-plane storage, or not at all?
