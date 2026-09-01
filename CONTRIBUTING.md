# Contributing

Run `bun run check:premerge` before merging. It is the canonical local gate for type checking, the full Bun test suite, Node's SQLite compatibility test, and whitespace validation against `HEAD`.

Run `bun run check:release` before an MCP package release. It inherits the pre-merge gate and adds the production MCP build and `npm pack --dry-run` package validation.

There is no repository CI workflow in this checkout, so these local gates are not currently enforced by CI. Neither gate requires live credentials or deployment.
