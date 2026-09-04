import { build } from "esbuild"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { mkdir, rename, rm } from "node:fs/promises"
import { promisify } from "node:util"
import { verifyBundleClosure } from "./verify-mcp-bundle-closure.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const mode = process.argv[2]
const run = promisify(execFile)

const common = {
  absWorkingDir: root,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24.15",
  logLevel: "info",
  loader: { ".txt": "text" },
  external: ["@napi-rs/keyring", "@inquirer/prompts"],
}

if (mode === "cli") {
  await build({
    ...common,
    entryPoints: [resolve(root, "packages/sandbox-cli/src/main.ts")],
    outfile: resolve(root, "packages/sandbox-cli/dist/waterbox-cli.js"),
  })
} else if (mode === "provider-box") {
  const packageRoot = resolve(root, "packages/sandbox-provider-box")
  const dist = resolve(packageRoot, "dist")
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  await build({
    ...common,
    entryPoints: [resolve(packageRoot, "src/public.ts")],
    outfile: resolve(dist, "index.js"),
    alias: {
      // provider-runtime uses a contracts export newer than the published alpha dependency.
      "@waterbox/contracts": resolve(root, "packages/sandbox-contracts/src/index.ts"),
      "@waterbox/provider-runtime": resolve(root, "packages/sandbox-provider-runtime/src/index.ts"),
    },
    external: ["@waterbox/contracts", "@waterbox/contracts/*", "@waterbox/core", "@waterbox/core/*"],
  })
  await build({
    ...common,
    entryPoints: [resolve(root, "packages/sandbox-cli/src/main.ts")],
    outfile: resolve(dist, "waterbox-cli.js"),
  })
  await run(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", resolve(packageRoot, "tsconfig.build.json")])
  // The package exposes only the ergonomic public surface, not its workspace internals.
  await rm(resolve(dist, "index.d.ts"), { force: true })
  await rename(resolve(dist, "public.d.ts"), resolve(dist, "index.d.ts"))
  await rm(resolve(dist, "index.d.ts.map"), { force: true })
} else if (mode === "mcp") {
  const dist = resolve(root, "packages/mcp/dist")
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  const results = await Promise.all([
    build({
      ...common,
      metafile: true,
      entryPoints: [resolve(root, "packages/mcp/src/bin.ts")],
      outfile: resolve(dist, "waterbox.js"),
    }),
    build({
      ...common,
      metafile: true,
      entryPoints: [resolve(root, "packages/sandbox-cli/src/main.ts")],
      outfile: resolve(dist, "waterbox-cli.js"),
    }),
  ])
  await verifyBundleClosure(root, results.map(result => result.metafile))
} else {
  throw new Error("Usage: node scripts/build-waterbox.mjs <cli|provider-box|mcp>")
}
