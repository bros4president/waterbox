import { describe, expect, test } from "bun:test"
import { BoundaryError, InvalidHunkError, derive, joinBom, parse } from "./opencode-patch.ts"

describe("opencode patch parser", () => {
  test("parses add, update, delete, and move hunks", () => {
    const hunks = parse(`*** Begin Patch
*** Add File: added.txt
+one
+two
*** Update File: old.txt
*** Move to: moved.txt
@@ heading
-before
+after
*** Delete File: deleted.txt
*** End Patch`)

    expect(hunks).toEqual([
      { type: "add", path: "added.txt", contents: "one\ntwo" },
      {
        type: "update",
        path: "old.txt",
        movePath: "moved.txt",
        chunks: [{ changeContext: "heading", oldLines: ["before"], newLines: ["after"] }],
      },
      { type: "delete", path: "deleted.txt" },
    ])
  })

  test("derives updates with context and an end-of-file anchor", () => {
    const [hunk] = parse(`*** Begin Patch
*** Update File: file.txt
@@ section
-old
+new
 tail
*** End of File
*** End Patch`)
    if (hunk?.type !== "update") throw new Error("expected update hunk")

    expect(derive(hunk.path, hunk.chunks, "intro\nsection\nold\ntail\n")).toEqual({
      content: "intro\nsection\nnew\ntail\n",
      bom: false,
    })
  })

  test("derives using trailing-whitespace and Unicode punctuation fallbacks", () => {
    expect(
      derive("unicode.txt", [{ oldLines: ['  “hello”—world  '], newLines: ["changed"] }], '"hello"-world   \n'),
    ).toEqual({ content: "changed\n", bom: false })
  })

  test("preserves and can introduce a BOM", () => {
    const updated = derive("bom.txt", [{ oldLines: ["old"], newLines: ["new"] }], "\uFEFFold\n")
    expect(updated).toEqual({ content: "new\n", bom: true })
    expect(joinBom(updated.content, updated.bom)).toBe("\uFEFFnew\n")

    expect(derive("bom.txt", [{ oldLines: ["old"], newLines: ["\uFEFFnew"] }], "old\n")).toEqual({
      content: "new\n",
      bom: true,
    })
  })

  test("rejects malformed boundaries and hunks", () => {
    expect(() => parse("*** Add File: x\n+x\n*** End Patch")).toThrow(BoundaryError)
    expect(() => parse("*** Begin Patch\n*** Add File: x\nnot-added\n*** End Patch")).toThrow(InvalidHunkError)
    expect(() => parse("*** Begin Patch\n*** Delete File: x\nbody\n*** End Patch")).toThrow(
      "Delete hunks do not contain body lines",
    )
    expect(() => parse("*** Begin Patch\n*** Update File: x\n@@\n*** End Patch")).toThrow(
      "Update hunk does not contain any lines",
    )
  })
})
