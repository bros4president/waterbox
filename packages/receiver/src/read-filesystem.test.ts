import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BinaryFileError, MAX_READ_BYTES, OffsetOutOfRangeError, readFilesystem } from "./read-filesystem.ts"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "read-filesystem-"))
  roots.push(root)
  return root
}

describe("readFilesystem", () => {
  test("reads one-based pages and reports continuation", async () => {
    const root = await workspace()
    const path = join(root, "file.txt")
    await writeFile(path, "one\r\ntwo\nthree\n")
    expect(await readFilesystem(path, { offset: 2, limit: 1 })).toEqual({
      type: "text", path, name: "file.txt", content: "two", offset: 2, lines: 1, totalLines: 3, truncated: true, next: 3,
    })
    await expect(readFilesystem(path, { offset: 4 })).rejects.toBeInstanceOf(OffsetOutOfRangeError)
  })

  test("sorts directories first and paginates entries", async () => {
    const root = await workspace()
    await writeFile(join(root, "a.txt"), "a")
    await mkdir(join(root, "z-dir"))
    await symlink(join(root, "a.txt"), join(root, "link"))
    const result = await readFilesystem(root, { limit: 2 })
    expect(result.type).toBe("directory")
    if (result.type !== "directory") throw new Error("expected directory")
    expect(result.entries).toEqual([{ path: `z-dir${process.platform === "win32" ? "\\" : "/"}`, type: "directory" }, { path: "a.txt", type: "file" }])
    expect(result).toMatchObject({ truncated: true, next: 3 })
  })

  test("caps long lines and the output byte budget", async () => {
    const root = await workspace()
    const path = join(root, "large.txt")
    await writeFile(path, `${"x".repeat(3_000)}\n${Array.from({ length: 100 }, () => "y".repeat(1_000)).join("\n")}`)
    const result = await readFilesystem(path)
    expect(result.type).toBe("text")
    if (result.type !== "text") throw new Error("expected text")
    expect(result.content.split("\n")[0]!.length).toBeGreaterThan(2_000)
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(MAX_READ_BYTES)
    expect(result.truncated).toBe(true)
    expect(result.next).toBeGreaterThan(1)
  })

  test("rejects NUL-containing files", async () => {
    const root = await workspace()
    const path = join(root, "binary")
    await writeFile(path, Buffer.from([65, 0, 66]))
    await expect(readFilesystem(path)).rejects.toBeInstanceOf(BinaryFileError)
  })

  test("scans large files across chunks without retaining skipped ranges", async () => {
    const root = await workspace()
    const path = join(root, "large-ranges.txt")
    const lines = Array.from({ length: 70_000 }, (_, index) => `line-${index + 1}`)
    lines[0] = "x".repeat(70_000)
    await writeFile(path, `${lines.join("\r\n")}\r\n`)

    const middle = await readFilesystem(path, { offset: 65_535, limit: 2 })
    expect(middle).toMatchObject({
      type: "text",
      content: "line-65535\nline-65536",
      offset: 65_535,
      lines: 2,
      totalLines: 70_000,
      truncated: true,
      next: 65_537,
    })
    const first = await readFilesystem(path, { limit: 1 })
    expect(first.type).toBe("text")
    if (first.type !== "text") throw new Error("expected text")
    expect(first.content).toContain("line truncated")
    expect(first.next).toBe(2)
  })

  test("detects binary NUL bytes in lines skipped before the requested offset", async () => {
    const root = await workspace()
    const path = join(root, "skipped-binary")
    await writeFile(path, Buffer.concat([Buffer.from("skip"), Buffer.from([0]), Buffer.from("ped\nvisible\n")]))
    await expect(readFilesystem(path, { offset: 2 })).rejects.toBeInstanceOf(BinaryFileError)
  })
})
