# Contributing

Use Bun only as repository tooling. The published `waterbox` executable and
its packaged sandbox CLI must run with Node.js 24.15.0 or newer without Bun.

Run `bun run check:premerge` before merging. It performs type checking, the
full Bun test suite, Node SQLite compatibility, and whitespace checks. Pull
requests and pushes run the same gate in GitHub Actions.

Run `bun run check:release` for package changes. It additionally builds shared
libraries and both Waterbox artifacts, validates exact esbuild/legal closure,
runs publint, constructs two isolated packs, compares normalized content,
installs one retained tarball, verifies its allowlist/shebang/mode/legal files,
executes protocol-aware stdio checks on configured Node 24 binaries, and tests
`add-mcp@2.3.0` in temporary config/home directories.

Set `NODE_24_15_BIN` to exactly Node v24.15.0 and `NODE_24_CURRENT_BIN` to a
current Node 24 binary when running artifact certification locally. Missing
binaries are reported and do not count as evidence. CI supplies both versions.

Publishing is restricted to the protected `npm` GitHub environment and a
controlled `v0.1.0-alpha.1` tag. The workflow uses npm trusted publishing/OIDC
and provenance, checks tag/package versions, verifies one exact tarball, and
publishes that file under the `next` dist-tag. It has no `NPM_TOKEN`. Do not
publish from a dirty checkout or run provider smokes without separate
isolated-account authorization.
