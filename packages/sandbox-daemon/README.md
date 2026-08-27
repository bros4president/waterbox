# `@waterbox/daemon`

Thin HTTP host for `@waterbox/runtime`, intended to run as a systemd service in a
full Linux sandbox. `WORKSPACE_ROOT` is mandatory; `PORT` defaults to `8080`.

Routes are `GET /health`, `GET /v1/tools`, and `POST /v1/tools/{name}` for each
canonical tool. Tool calls return JSON except bash, which returns ordered incremental
NDJSON `stdout`, `stderr`, and final `result` events.

Build a standalone Linux executable with:

```sh
bun run --cwd packages/sandbox-daemon build
```

The target host must provide `bash` and `rg` (ripgrep). The daemon handles SIGTERM
and SIGINT, aborts active runtime work, and drains its HTTP listener before forcing
remaining connections closed.
