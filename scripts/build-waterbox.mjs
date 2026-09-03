import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { mkdir, rm } from "node:fs/promises"
import { verifyBundleClosure } from "./verify-mcp-bundle-closure.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const mode = process.argv[2]

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
  throw new Error("Usage: node scripts/build-waterbox.mjs <cli|mcp>")
}
