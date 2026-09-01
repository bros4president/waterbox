# Waterbox local control plane

Configure the placeholder variables in the repository `.env.example` and start with
`bun run start:api-local`. The start
command explicitly builds the development sandbox CLI in `packages/sandbox-cli/dist` before
the app loads and injects it into the shared local control plane. This is a
development-only fixed bearer identity; do not expose the listener publicly.

The examples below assume `URL=http://127.0.0.1:8787`, `KEY` is the configured development
key, and `SANDBOX`/`SNAPSHOT` contain Waterbox public IDs. Responses never contain Box IDs,
serialized CLI invocations, provider references, or account IDs.

```sh
curl -H "Authorization: Bearer $KEY" "$URL/health"
curl "$URL/openapi.json"
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'Idempotency-Key: example-1' -d '{}' "$URL/v1/sandboxes"
curl -H "Authorization: Bearer $KEY" "$URL/v1/sandboxes"
curl -H "Authorization: Bearer $KEY" "$URL/v1/sandboxes/$SANDBOX"
curl -X POST -H "Authorization: Bearer $KEY" "$URL/v1/sandboxes/$SANDBOX/stop"
curl -X POST -H "Authorization: Bearer $KEY" "$URL/v1/sandboxes/$SANDBOX/resume"
curl -X DELETE -H "Authorization: Bearer $KEY" "$URL/v1/sandboxes/$SANDBOX"

curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"name":"checkpoint"}' "$URL/v1/sandboxes/$SANDBOX/snapshots"
curl -H "Authorization: Bearer $KEY" "$URL/v1/snapshots"
curl -H "Authorization: Bearer $KEY" "$URL/v1/snapshots/$SNAPSHOT"
curl -X DELETE -H "Authorization: Bearer $KEY" "$URL/v1/snapshots/$SNAPSHOT"

# Secure file transfer is a two-step age/X25519 protocol:
curl -X POST -H "Authorization: Bearer $KEY" "$URL/v1/sandboxes/$SANDBOX/secure-file-transfers"
curl -X PUT -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"targetPath":"/root/.aws/credentials","ciphertext":"<canonical-base64-age-file>"}' "$URL/v1/sandboxes/$SANDBOX/secure-file-transfers/$TRANSFER"

curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"filePath":"/workspace/a.txt"}' "$URL/v1/sandboxes/$SANDBOX/tools/read"
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"filePath":"/workspace/a.txt","content":"hello"}' "$URL/v1/sandboxes/$SANDBOX/tools/write"
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"filePath":"/workspace/a.txt","oldString":"hello","newString":"world"}' "$URL/v1/sandboxes/$SANDBOX/tools/edit"
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"patchText":"*** Begin Patch\\n*** Add File: /workspace/b.txt\\n+hello\\n*** End Patch"}' "$URL/v1/sandboxes/$SANDBOX/tools/patch"
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"pattern":"*.txt","path":"/workspace"}' "$URL/v1/sandboxes/$SANDBOX/tools/glob"
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"pattern":"world","path":"/workspace"}' "$URL/v1/sandboxes/$SANDBOX/tools/grep"
curl -N -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"command":"printf hello; sleep 1; printf world"}' "$URL/v1/sandboxes/$SANDBOX/tools/bash"
curl -N -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"command":"printf hello; sleep 20; printf world","timeout":30000}' "$URL/v1/sandboxes/$SANDBOX/tools/bash"
```

Every one-shot Bash call starts a detached worker. Quick commands return a completed result;
longer-running commands may yield a dispatched receipt. `timeout`, when present, is only an
execution deadline. The receipt means the worker was spawned, not that Bash started or
succeeded. `statusPath` reports execution state and `outputPath` receives output continuously.
The public CLI/API result remains transport-level recovery information. `@waterbox/client`
absorbs receipts through authenticated bounded byte-observation API endpoints, drains the same
job once, and returns one completed result. Provider and core operations only sample; the
reusable client owns polling, progress, truncation, fallback receipts, and cleanup.

The initiation response contains `transferId`, an `age1...` recipient, algorithm `age-x25519`, and a fixed ten-minute `expiresAt`. Encrypt an existing local file with a standard age implementation, Base64-encode the binary age file, and consume the transfer once before expiry. Plaintext is limited to 1 MiB. The API and provider transport handle only ciphertext; the destination is decrypted and readable inside the sandbox. Creating another transfer is the recovery path after expiry or an uncertain consumption outcome.

The real Box smoke flow is destructive and separately gated. It is never run by `bun test`.
Run it only against an otherwise idle, dedicated development account: sandbox DTOs expose
no public ownership marker, so safe recovery of a response-lost create uses exact idempotent
replay and an isolated-account baseline diff. Snapshot recovery uses a unique public `name`.
After starting the local API with Box configuration, set `WATERBOX_BOX_SMOKE_AUTHORIZED=YES`,
`WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT=YES`, `WATERBOX_API_URL`, `WATERBOX_DEV_API_KEY`, and
`BOX_API_KEY`, then run `bun run smoke:control-plane-box`. Cleanup reconciles DELETE responses
with bounded GET polling and verifies no run-owned sandbox remains nonterminal. If exact replay
and isolated-account discovery cannot recover an accepted resource, the script reports cleanup
as incomplete; the public V1 sandbox shape cannot support a stronger ownership guarantee.

For a manual OpenCode session over the temporary local API and experimental MCP, run:

```sh
WATERBOX_MCP_EXPERIMENT_AUTHORIZATION=I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES \
WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT=YES \
bun run chat:control-plane-mcp
```

The command opens the repository-pinned OpenCode TUI. Ask it to create a remote sandbox,
then use the `remote` tools normally. Exiting the TUI stops the temporary API and performs
bounded API and provider-level cleanup. Run it only against an isolated development account.
