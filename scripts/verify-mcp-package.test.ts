import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertCompleteFriendlyWords, assertSameBytes, assertTarballIdentity, captureTarballIdentity, resolveOnlyPackedTarball } from "./verify-mcp-package.ts"

const roots: string[] = []
async function fixture(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "waterbox-package-verifier-test-")); roots.push(path); return path }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe("MCP installed-artifact verifier", () => {
  test("selects only npm's single reported tarball and rejects decoys", async () => {
    const directory = await fixture()
    await writeFile(join(directory, "waterbox-mcp-0.1.0.tgz"), "exact")
    expect(await resolveOnlyPackedTarball(directory, "waterbox-mcp-0.1.0.tgz")).toBe(join(directory, "waterbox-mcp-0.1.0.tgz"))
    await writeFile(join(directory, "decoy.tgz"), "decoy")
    await expect(resolveOnlyPackedTarball(directory, "waterbox-mcp-0.1.0.tgz")).rejects.toThrow("exactly one")
    await expect(resolveOnlyPackedTarball(directory, "../waterbox-mcp-0.1.0.tgz")).rejects.toThrow("invalid tarball")
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
})
