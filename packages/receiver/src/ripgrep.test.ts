import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RipgrepError, ripgrepGlob, ripgrepSearch } from "./ripgrep.ts"

const roots: string[] = []
const hasRipgrep = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ripgrep-"))
  roots.push(root)
  return root
}

describe("ripgrep adapters", () => {
  test.skipIf(!hasRipgrep)("globs deterministically exclude git metadata and preserve ignores", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    await writeFile(join(root, ".git/secret"), "secret")
    await writeFile(join(root, ".gitignore"), "ignored.txt\n")
    await writeFile(join(root, "ignored.txt"), "ignored")
    await writeFile(join(root, "visible.ts"), "visible")
    expect(await ripgrepGlob(root, "*.ts")).toEqual({ paths: ["visible.ts"], truncated: false })
  })

  test.skipIf(!hasRipgrep)("parses matches and submatches and limits results", async () => {
    const root = await workspace()
    await writeFile(join(root, "match.txt"), "alpha beta alpha\nalpha\n")
    const result = await ripgrepSearch(root, "alpha", { limit: 1 })
    expect(result.truncated).toBe(true)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ path: "match.txt", lineNumber: 1, line: "alpha beta alpha" })
    expect(result.matches[0]!.submatches).toEqual([{ text: "alpha", start: 0, end: 5 }, { text: "alpha", start: 11, end: 16 }])
  })

  test.skipIf(!hasRipgrep)("returns no matches and reports invalid regexes", async () => {
    const root = await workspace()
    await writeFile(join(root, "file"), "content")
    expect(await ripgrepSearch(root, "absent")).toEqual({ matches: [], truncated: false })
    await expect(ripgrepSearch(root, "[")).rejects.toBeInstanceOf(RipgrepError)
  })

  test.skipIf(!hasRipgrep)("searches an explicit regular-file target", async () => {
    const root = await workspace()
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src/target.ts"), "needle here\n")
    await writeFile(join(root, "src/other.ts"), "needle elsewhere\n")
    const result = await ripgrepSearch(root, "needle", { target: "src/target.ts" })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ path: "src/target.ts", lineNumber: 1, line: "needle here" })
  })

  test.skipIf(!hasRipgrep)("honors an already-aborted signal", async () => {
    const root = await workspace()
    const controller = new AbortController()
    controller.abort()
    await expect(ripgrepGlob(root, undefined, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
  })
})
