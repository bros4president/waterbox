import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReceiver } from "./server.ts"

const roots: string[] = []
const hasRipgrep = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oc-remote-"))
  roots.push(root)
  return root
}

function post(path: string, body: unknown, signal?: AbortSignal): Request {
  return new Request(`http://receiver${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    signal,
  })
}

describe("receiver handler", () => {
  test("reports health and accepts MicroVM lifecycle hooks", async () => {
    const receiver = createReceiver({ workspaceRoot: await workspace() })
    expect(await (await receiver.handleRequest(new Request("http://receiver/health"))).json()).toEqual({ status: "ok" })
    expect((await receiver.handleRequest(post("/aws/lambda-microvms/runtime/v1/run", { session: "test" }))).status).toBe(204)
    expect((await receiver.handleRequest(post("/aws/lambda-microvms/runtime/v1/validate", {}))).status).toBe(204)
  })

  test.skipIf(!hasRipgrep)("serves Pi's standalone tool catalog and executes all seven tools", async () => {
    const root = await workspace()
    const receiver = createReceiver({ workspaceRoot: root })
    const catalog = await (await receiver.handleRequest(new Request("http://receiver/v1/pi/tools"))).json()
    expect(catalog.map((tool: { name: string }) => tool.name)).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"])
    expect(catalog.every((tool: { description?: string; inputSchema?: unknown }) => tool.description && tool.inputSchema)).toBe(true)

    const call = async (name: string, args: unknown) => {
      const response = await receiver.handleRequest(post(`/v1/pi/tools/${name}`, args))
      expect(response.status).toBe(200)
      return response.json()
    }
    expect(await call("write", { path: "src/example.ts", content: "const alpha = 1\n" })).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Successfully wrote") }],
    })
    expect(await call("read", { path: "src/example.ts" })).toMatchObject({ content: [{ text: "const alpha = 1\n" }] })
    expect(await call("edit", { path: "src/example.ts", edits: [{ oldText: "alpha = 1", newText: "alpha = 2" }] })).toMatchObject({
      content: [{ type: "text", text: expect.any(String) }],
    })
    expect(await call("grep", { pattern: "alpha", path: "src" })).toMatchObject({ content: [{ text: "example.ts:1: const alpha = 2" }] })
    expect(await call("find", { pattern: "*.ts", path: "src" })).toMatchObject({ content: [{ text: "example.ts" }] })
    expect(await call("ls", { path: "." })).toMatchObject({ content: [{ text: "src/" }] })
    expect(await call("bash", { command: "pwd" })).toMatchObject({ content: [{ text: expect.stringContaining(root) }] })
    expect((await receiver.handleRequest(post("/v1/pi/tools/unknown", {}))).status).toBe(404)
  })

  test("writes atomically and reads a line range", async () => {
    const root = await workspace()
    const receiver = createReceiver({ workspaceRoot: root })
    const write = await receiver.handleRequest(post("/v1/tools/write", { filePath: "nested/file.txt", content: "one\ntwo\nthree\n" }))
    expect(write.status).toBe(200)
    expect(await readFile(join(root, "nested/file.txt"), "utf8")).toBe("one\ntwo\nthree\n")

    const read = await receiver.handleRequest(post("/v1/tools/read", { filePath: "nested/file.txt", offset: 2, limit: 1 }))
    expect(await read.json()).toMatchObject({ output: "two", metadata: { offset: 2, lines: 1, totalLines: 3 } })
  })

  test("reads directories and reports text truncation and binary input", async () => {
    const root = await workspace()
    await mkdir(join(root, "dir"))
    await mkdir(join(root, "dir/sub"))
    await writeFile(join(root, "dir/file.txt"), `${"x".repeat(3_000)}\nsecond\nthird`)
    await writeFile(join(root, "binary"), Buffer.from([1, 0, 2]))
    const receiver = createReceiver({ workspaceRoot: root })

    const directory = await (await receiver.handleRequest(post("/v1/tools/read", { filePath: "dir", limit: 1 }))).json()
    expect(directory).toMatchObject({ output: `sub${process.platform === "win32" ? "\\" : "/"}`, metadata: { type: "directory", entries: 1, truncated: true, next: 2 } })
    const text = await (await receiver.handleRequest(post("/v1/tools/read", { filePath: "dir/file.txt", limit: 1 }))).json()
    expect(text.output).toContain("line truncated")
    expect(text.metadata).toMatchObject({ type: "text", lines: 1, totalLines: 3, truncated: true, next: 2 })
    expect((await receiver.handleRequest(post("/v1/tools/read", { filePath: "binary" }))).status).toBe(400)
  })

  test.skipIf(!hasRipgrep)("globs and greps within contained paths with useful no-match and invalid-regex responses", async () => {
    const root = await workspace()
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src/a.ts"), "const alpha = 1\n")
    await writeFile(join(root, "src/b.js"), "const alpha = 2\n")
    const receiver = createReceiver({ workspaceRoot: root })

    const glob = await (await receiver.handleRequest(post("/v1/tools/glob", { pattern: "*.ts", path: "src" }))).json()
    expect(glob).toMatchObject({ output: "src/a.ts", metadata: { path: "src", count: 1, truncated: false } })
    const grep = await (await receiver.handleRequest(post("/v1/tools/grep", { pattern: "alpha", path: "src", include: "*.ts" }))).json()
    expect(grep.output).toBe("src/a.ts:1: const alpha = 1")
    expect(grep.metadata).toMatchObject({ include: "*.ts", matches: 1 })
    const fileGrep = await (await receiver.handleRequest(post("/v1/tools/grep", { pattern: "alpha", path: "src/b.js" }))).json()
    expect(fileGrep).toMatchObject({ output: "src/b.js:1: const alpha = 2", metadata: { path: "src/b.js", matches: 1 } })
    expect(await (await receiver.handleRequest(post("/v1/tools/grep", { pattern: "absent" }))).json()).toMatchObject({ output: "No matches found", metadata: { matches: 0 } })
    expect((await receiver.handleRequest(post("/v1/tools/grep", { pattern: "[" }))).status).toBe(400)
    expect((await receiver.handleRequest(post("/v1/tools/glob", { pattern: "*", path: "../" }))).status).toBe(400)
  })

  test("edits exact and fuzzy text, reports ambiguity, replaces all, and preserves BOM and mode", async () => {
    const root = await workspace()
    const path = join(root, "edit.txt")
    await writeFile(path, "\uFEFF“item”\nitem item\n")
    await chmod(path, 0o640)
    const receiver = createReceiver({ workspaceRoot: root })

    const fuzzy = await receiver.handleRequest(post("/v1/tools/edit", { filePath: "edit.txt", oldString: "\"item\"", newString: "heading" }))
    expect(fuzzy.status).toBe(200)
    expect((await readFile(path, "utf8")).startsWith("\uFEFFheading")).toBe(true)
    expect((await stat(path)).mode & 0o777).toBe(0o640)
    expect((await receiver.handleRequest(post("/v1/tools/edit", { filePath: "edit.txt", oldString: "item", newString: "value" }))).status).toBe(409)
    const replaced = await (await receiver.handleRequest(post("/v1/tools/edit", { filePath: "edit.txt", oldString: "item", newString: "value", replaceAll: true }))).json()
    expect(replaced.metadata).toMatchObject({ replacements: 2 })
    expect(await readFile(path, "utf8")).toBe("\uFEFFheading\nvalue value\n")
    expect((await receiver.handleRequest(post("/v1/tools/edit", { filePath: "missing", oldString: "x", newString: "y" }))).status).toBe(404)
  })

  test("applies patch add, update, delete, and move operations", async () => {
    const root = await workspace()
    await writeFile(join(root, "update.txt"), "old\n")
    await writeFile(join(root, "delete.txt"), "remove\n")
    await writeFile(join(root, "move.txt"), "before\n")
    const receiver = createReceiver({ workspaceRoot: root })
    const patchText = `*** Begin Patch
*** Add File: added.txt
+added
*** Update File: update.txt
@@
-old
+new
*** Delete File: delete.txt
*** Update File: move.txt
*** Move to: nested/moved.txt
@@
-before
+after
*** End Patch`
    const response = await receiver.handleRequest(post("/v1/tools/patch", { patchText }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      output: "A added.txt\nM update.txt\nD delete.txt\nR move.txt -> nested/moved.txt",
      metadata: {
        added: ["added.txt"], updated: ["update.txt"], deleted: ["delete.txt"],
        moved: [{ from: "move.txt", to: "nested/moved.txt" }],
      },
    })
    expect(await readFile(join(root, "added.txt"), "utf8")).toBe("added")
    expect(await readFile(join(root, "update.txt"), "utf8")).toBe("new\n")
    expect(await readFile(join(root, "nested/moved.txt"), "utf8")).toBe("after\n")
    await expect(readFile(join(root, "delete.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(root, "move.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("patch preflight rejects invalid, conflicting, traversal, and symlink operations without mutation", async () => {
    const root = await workspace()
    const outside = await workspace()
    await writeFile(join(root, "source.txt"), "original\n")
    await writeFile(join(outside, "outside.txt"), "outside\n")
    await symlink(outside, join(root, "link"))
    const receiver = createReceiver({ workspaceRoot: root })
    const mismatch = `*** Begin Patch
*** Add File: should-not-exist.txt
+created
*** Update File: source.txt
@@
-missing
+changed
*** End Patch`
    expect((await receiver.handleRequest(post("/v1/tools/patch", { patchText: mismatch }))).status).toBe(409)
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("original\n")
    await expect(readFile(join(root, "should-not-exist.txt"))).rejects.toMatchObject({ code: "ENOENT" })

    const traversal = "*** Begin Patch\n*** Add File: ../escape\n+bad\n*** End Patch"
    const symlinkPatch = "*** Begin Patch\n*** Update File: link/outside.txt\n@@\n-outside\n+bad\n*** End Patch"
    const conflict = "*** Begin Patch\n*** Delete File: source.txt\n*** Delete File: source.txt\n*** End Patch"
    const ancestorConflict = "*** Begin Patch\n*** Add File: parent\n+file\n*** Add File: parent/child\n+child\n*** End Patch"
    expect((await receiver.handleRequest(post("/v1/tools/patch", { patchText: traversal }))).status).toBe(400)
    expect((await receiver.handleRequest(post("/v1/tools/patch", { patchText: symlinkPatch }))).status).toBe(400)
    expect((await receiver.handleRequest(post("/v1/tools/patch", { patchText: conflict }))).status).toBe(409)
    expect((await receiver.handleRequest(post("/v1/tools/patch", { patchText: ancestorConflict }))).status).toBe(409)
    await expect(readFile(join(root, "parent"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(outside, "outside.txt"), "utf8")).toBe("outside\n")
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("original\n")
    expect((await receiver.handleRequest(post("/v1/tools/patch", { patchText: "not a patch" }))).status).toBe(400)
  })

  test("rolls back prior patch operations when a later commit unexpectedly fails", async () => {
    const root = await workspace()
    const receiver = createReceiver({ workspaceRoot: root })
    const middle = Array.from({ length: 40 }, (_, index) => `*** Add File: middle-${index}.txt\n+${"x".repeat(5_000)}`).join("\n")
    const patchText = `*** Begin Patch
*** Add File: marker.txt
+marker
${middle}
*** Add File: forced-failure.txt
+must not commit
*** End Patch`

    const racer = (async () => {
      for (let attempt = 0; attempt < 5_000; attempt++) {
        try {
          await lstat(join(root, "marker.txt"))
          await mkdir(join(root, "forced-failure.txt"))
          return
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          await Bun.sleep(1)
        }
      }
      throw new Error("patch commit race was not induced")
    })()
    const response = await receiver.handleRequest(post("/v1/tools/patch", { patchText }))
    await racer
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ output: expect.stringContaining("Applied operations were rolled back") })
    await expect(readFile(join(root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(root, "middle-0.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await lstat(join(root, "forced-failure.txt"))).isDirectory()).toBe(true)
  })

  test("rejects traversal and symlink escapes for every filesystem tool", async () => {
    const root = await workspace()
    const outside = await workspace()
    await writeFile(join(outside, "secret"), "secret")
    await symlink(outside, join(root, "link"))
    const receiver = createReceiver({ workspaceRoot: root })

    expect((await receiver.handleRequest(post("/v1/tools/read", { filePath: "../secret" }))).status).toBe(400)
    expect((await receiver.handleRequest(post("/v1/tools/read", { filePath: "link/secret" }))).status).toBe(400)
    expect((await receiver.handleRequest(post("/v1/tools/write", { filePath: "link/new", content: "bad" }))).status).toBe(400)
    expect((await receiver.handleRequest(post("/v1/tools/bash", { command: "pwd", workdir: "link" }))).status).toBe(400)
  })

  test("streams stdout, stderr, and a final bash result as NDJSON", async () => {
    const receiver = createReceiver({ workspaceRoot: await workspace() })
    const response = await receiver.handleRequest(post("/v1/tools/bash", { command: "printf out; printf err >&2", description: "stream test" }))
    expect(response.headers.get("content-type")).toContain("application/x-ndjson")
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
    expect(events).toContainEqual({ type: "stdout", data: "out" })
    expect(events).toContainEqual({ type: "stderr", data: "err" })
    expect(events.at(-1)).toMatchObject({ type: "result", title: "stream test", metadata: { exitCode: 0, timedOut: false } })
    expect(events.at(-1).output).toContain("out")
    expect(events.at(-1).output).toContain("err")
  })

  test("kills a command after its timeout", async () => {
    const receiver = createReceiver({ workspaceRoot: await workspace() })
    const response = await receiver.handleRequest(post("/v1/tools/bash", { command: "sleep 5", timeout: 20 }))
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
    expect(events.at(-1)).toMatchObject({ type: "result", metadata: { timedOut: true } })
  })

  test("kills a command when its request is aborted", async () => {
    const receiver = createReceiver({ workspaceRoot: await workspace() })
    const controller = new AbortController()
    const response = await receiver.handleRequest(post("/v1/tools/bash", { command: "sleep 5" }, controller.signal))
    setTimeout(() => controller.abort(), 20)
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
    expect(events.at(-1)).toMatchObject({ type: "result", metadata: { aborted: true, timedOut: false } })
  })

  test("does not follow a symlink created where a file will be replaced", async () => {
    const root = await workspace()
    const outside = await workspace()
    await mkdir(join(root, "safe"))
    await writeFile(join(outside, "target"), "outside")
    await symlink(join(outside, "target"), join(root, "safe/file"))
    const receiver = createReceiver({ workspaceRoot: root })
    expect((await receiver.handleRequest(post("/v1/tools/write", { filePath: "safe/file", content: "inside" }))).status).toBe(400)
    expect(await readFile(join(outside, "target"), "utf8")).toBe("outside")
  })
})
