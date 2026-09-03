# @waterbox/provider-box

Box Public API v1 provider for Waterbox. It includes the sandbox CLI artifact,
so application code installs no private Waterbox runtime packages.

```sh
npm install @waterbox/provider-box@next
```

```ts
import { BoxSandboxProvider } from "@waterbox/provider-box"

const provider = new BoxSandboxProvider({
  apiBaseUrl: "https://api.box.example/v1",
  apiKey: process.env.BOX_API_KEY!,
  polling: { intervalMs: 1_000, timeoutMs: 60_000 },
  automaticStopMs: 3_600_000,
})
```

`createBoxSandboxProvider(config)` is an equivalent factory. Both compose the
embedded CLI artifact and the system clock automatically. Tests and advanced
integrations may pass `clock`, `fetch`, `diagnostic`, or a replacement
`artifact` as the optional second argument.

The host entry requires Node.js 22 or later. The embedded CLI is built for
Node.js 24.15 and runs inside the Box sandbox; Box images must provide a
compatible Node 24 runtime and `rg`.

## Public API

- `BoxSandboxProvider` and `createBoxSandboxProvider`
- `SystemBoxProviderClock`
- `deriveBoxProviderConfigurationId(config)` for the conservative Box
  provider binding identity used by Waterbox core
- `loadSandboxRuntimeArtifact(location, artifactVersion)` for explicit
  artifact loading
- `BoxProviderConfig`, `BoxProviderDependencies`, `BoxProviderClock`,
  `BoxProviderFetch`, `BoxProviderDiagnostic`, and `SandboxRuntimeArtifact`

The provider uses native Box lifecycle and named-snapshot endpoints. Each tool
execution is one Box command request and is never retried after an uncertain
outcome.
