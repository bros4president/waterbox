# `@waterbox/runtime`

Provider-neutral Linux implementations of Waterbox's seven canonical workspace tools.

The runtime requires `bash` and `rg` (ripgrep) on `PATH`. It does not require `fd`.
Reads and searches are bounded, writes are atomic, and relative paths default to the
workspace without treating it as a security boundary. Absolute paths, traversal, and
symbolic links retain the authority of the provider sandbox. Bash cancellation terminates
the spawned process group, escalating from SIGTERM to SIGKILL when needed.

Every invocation executes independently. The runtime does not promise cross-command
ordering; concurrent filesystem mutations follow their operation preconditions and the
underlying filesystem. Patch operations preflight all hunks and report operations completed
before a commit failure rather than attempting a concurrency-unsafe rollback. Waterbox does
not claim a cross-command filesystem transaction.

`createRuntime` always executes Bash synchronously. The one-shot CLI always starts one
detached worker. Quick commands produce the usual bounded completed result; longer-running
commands may yield a file-backed output/status receipt and remain detached. `timeout` is
only an execution deadline and may be omitted. There are no readiness handshakes, pollers,
retries, or job management.
