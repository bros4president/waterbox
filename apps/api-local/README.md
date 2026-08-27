# Waterbox local control plane

Configure the placeholder variables in the repository `.env.example`, create the parent
directory for `WATERBOX_SQLITE_PATH`, and start with `bun run start:api-local`. This is a
development-only fixed bearer identity; do not expose the listener publicly.

The examples below assume `URL=http://127.0.0.1:8787`, `KEY` is the configured development
key, and `SANDBOX`/`SNAPSHOT` contain Waterbox public IDs. Responses never contain Box IDs,
protected hosting URLs, provider references, or account IDs.

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

curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"filePath":"/workspace/a.txt"}' "$URL/v1/sandboxes/$SANDBOX/tools/read"
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"filePath":"/workspace/a.txt","content":"hello"}' "$URL/v1/sandboxes/$SANDBOX/tools/write"
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"filePath":"/workspace/a.txt","oldString":"hello","newString":"world"}' "$URL/v1/sandboxes/$SANDBOX/tools/edit"
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"patchText":"*** Begin Patch\\n*** Add File: /workspace/b.txt\\n+hello\\n*** End Patch"}' "$URL/v1/sandboxes/$SANDBOX/tools/patch"
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"pattern":"*.txt","path":"/workspace"}' "$URL/v1/sandboxes/$SANDBOX/tools/glob"
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"pattern":"world","path":"/workspace"}' "$URL/v1/sandboxes/$SANDBOX/tools/grep"
curl -N -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"command":"printf hello; sleep 1; printf world"}' "$URL/v1/sandboxes/$SANDBOX/tools/bash"
```

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
