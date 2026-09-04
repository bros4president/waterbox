import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertCliOnlyManifest, assertCompleteFriendlyWords, assertNodeOnlyBundles, assertPackedFileAllowlist, assertSameBytes, assertTarballIdentity, captureTarballIdentity, inspectInstalledArtifacts, resolveOnlyPackedTarball } from "./verify-mcp-package.ts"

const roots: string[] = []
async function fixture(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "waterbox-package-verifier-test-")); roots.push(path); return path }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe("MCP installed-artifact verifier", () => {
  test("selects only npm's single reported tarball and rejects decoys", async () => {
    const directory = await fixture()
    await writeFile(join(directory, "waterbox-mcp-0.1.0-alpha.2.tgz"), "exact")
    expect(await resolveOnlyPackedTarball(directory, "waterbox-mcp-0.1.0-alpha.2.tgz")).toBe(join(directory, "waterbox-mcp-0.1.0-alpha.2.tgz"))
    await writeFile(join(directory, "decoy.tgz"), "decoy")
    await expect(resolveOnlyPackedTarball(directory, "waterbox-mcp-0.1.0-alpha.2.tgz")).rejects.toThrow("exactly one")
    await expect(resolveOnlyPackedTarball(directory, "../waterbox-mcp-0.1.0-alpha.2.tgz")).rejects.toThrow("invalid tarball")
  })

  test("retains one tarball identity across inspection and installation", async () => {
    const directory = await fixture(), tarball = join(directory, "artifact.tgz")
    await writeFile(tarball, "original artifact")
    const identity = await captureTarballIdentity(tarball)
    await expect(assertTarballIdentity(identity)).resolves.toBeUndefined()
    await writeFile(tarball, "mutated artifact")
    await expect(assertTarballIdentity(identity)).rejects.toThrow("changed during verification")
  })

  test("requires complete ordered corpus bytes and exact artifact bytes", () => {
    const predicates = "aback\ntranquil\nzesty\n", objects = "aardvark\nwallaby\nzydeco\n"
    const bundle = `const predicates = ${JSON.stringify(predicates)}; const objects = ${JSON.stringify(objects)};`
    expect(() => assertCompleteFriendlyWords(bundle, predicates, objects)).not.toThrow()
    expect(() => assertCompleteFriendlyWords(bundle.replace("tranquil\\n", ""), predicates, objects)).toThrow("complete pinned")
    expect(() => assertSameBytes(Buffer.from("notice"), Buffer.from("notice"), "notice")).not.toThrow()
    expect(() => assertSameBytes(Buffer.from("notice"), Buffer.from("decoy"), "notice")).toThrow("exact packed artifact")
  })

  test("enforces exact CLI-only package surface and Node-only bundles", () => {
    const files = ["dist/waterbox.js", "dist/waterbox-cli.js", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "package.json"]
    expect(() => assertPackedFileAllowlist(files)).not.toThrow()
    expect(() => assertPackedFileAllowlist([...files, "dist/index.js"])).toThrow("allowlist")
    expect(() => assertPackedFileAllowlist(files.filter(path => path !== "LICENSE"))).toThrow("allowlist")
    const manifest = { name: "waterbox", version: "0.1.0-alpha.2", engines: { node: ">=24.15.0" }, license: "MIT", bin: { waterbox: "./dist/waterbox.js" }, publishConfig: { access: "public", tag: "latest" } }
    expect(() => assertCliOnlyManifest(manifest)).not.toThrow()
    expect(() => assertCliOnlyManifest({ ...manifest, publishConfig: { access: "public", tag: "next" } })).toThrow("channel")
    expect(() => assertCliOnlyManifest({ ...manifest, publishConfig: { tag: "latest" } })).toThrow("channel")
    expect(() => assertCliOnlyManifest({ ...manifest, exports: "./dist/index.js" })).toThrow("only the waterbox executable")
    expect(() => assertNodeOnlyBundles([["waterbox.js", "#!/usr/bin/env node\n"]])).not.toThrow()
    expect(() => assertNodeOnlyBundles([["waterbox.js", "Bun.spawn()"]])).toThrow("Bun runtime")
  })

  test("accepts an installed executable through an aliased temporary parent", async () => {
    const { installDirectory, installedPackage, executableTarget } = await installedFixture()
    const artifacts = await inspectInstalledArtifacts(installDirectory, installedPackage)
    expect(artifacts.executableTarget).toBe(await realpath(executableTarget))
    expect(artifacts.canonicalInstallDirectory).toBe(await realpath(installDirectory))
    expect(artifacts.canonicalInstalledPackage).toBe(await realpath(installedPackage))
  })

  test("rejects an installed executable without executable mode", async () => {
    const { installDirectory, installedPackage, executableTarget } = await installedFixture()
    await chmod(executableTarget, 0o644)
    await expect(inspectInstalledArtifacts(installDirectory, installedPackage)).rejects.toThrow("executable mode")
  })

  test("rejects an installed executable without the expected Node shebang", async () => {
    const { installDirectory, installedPackage, executableTarget } = await installedFixture()
    await writeFile(executableTarget, "#!/bin/sh\nexit 2\n", { mode: 0o755 })
    await expect(inspectInstalledArtifacts(installDirectory, installedPackage)).rejects.toThrow("expected Node shebang")
  })
})

async function installedFixture(): Promise<{ installDirectory: string; installedPackage: string; executableTarget: string }> {
  const directory = await fixture()
  const realRoot = join(directory, "real")
  const aliasRoot = join(directory, "alias")
  const realInstall = join(realRoot, "install")
  const realPackage = join(realInstall, "node_modules/waterbox")
  const executableTarget = join(realPackage, "dist/waterbox.js")
  await mkdir(join(realInstall, "node_modules/.bin"), { recursive: true })
  await mkdir(join(realPackage, "dist"), { recursive: true })
  await writeFile(executableTarget, "#!/usr/bin/env node\nconsole.error('Usage: waterbox')\nprocess.exit(2)\n", { mode: 0o755 })
  await writeFile(join(realPackage, "dist/waterbox-cli.js"), "console.log(JSON.stringify({ protocolVersion: 2 }))\n")
  await symlink("../waterbox/dist/waterbox.js", join(realInstall, "node_modules/.bin/waterbox"))
  await symlink(realRoot, aliasRoot, "dir")
  return {
    installDirectory: join(aliasRoot, "install"),
    installedPackage: join(aliasRoot, "install/node_modules/waterbox"),
    executableTarget,
  }
}
