import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const mode = process.argv[2]

const common = {
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
  await Promise.all([
    build({
      ...common,
      entryPoints: [resolve(root, "packages/mcp/src/bin.ts")],
      outfile: resolve(root, "packages/mcp/dist/waterbox.js"),
    }),
    build({
      ...common,
      entryPoints: [resolve(root, "packages/sandbox-cli/src/main.ts")],
      outfile: resolve(root, "packages/mcp/dist/waterbox-cli.js"),
    }),
    build({
      ...common,
      entryPoints: [resolve(root, "packages/mcp/src/index.ts")],
      outfile: resolve(root, "packages/mcp/dist/index.js"),
    }),
  ])
} else {
  throw new Error("Usage: node scripts/build-waterbox.mjs <cli|mcp>")
}
