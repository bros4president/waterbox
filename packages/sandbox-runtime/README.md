# `@waterbox/runtime`

Provider-neutral Linux implementations of Waterbox's seven canonical workspace tools.

The runtime requires `bash` and `rg` (ripgrep) on `PATH`. It does not require `fd`.
Reads and searches are bounded, writes are atomic, workspace file paths reject traversal
and symbolic-link components, and bash cancellation terminates the spawned process group,
escalating from SIGTERM to SIGKILL when needed.

File mutations (`write`, `edit`, and `patch`) are serialized in arrival order. Bash is
intentionally not part of that queue, retaining the v0 receiver behavior: a bash command
may overlap a file mutation and callers must coordinate such operations themselves.
