import { describe, expect, test } from "bun:test"
import { EditTextError, editText, joinBom } from "./opencode-edit.ts"

describe("opencode editText", () => {
  test("replaces one exact match", () => {
    expect(editText("one two three", "two", "2")).toEqual({
      content: "one 2 three",
      bom: false,
      replacements: 1,
    })
  })

  test("rejects ambiguous matches unless replaceAll is true", () => {
    expect(() => editText("x x x", "x", "y")).toThrow(EditTextError)
    try {
      editText("x x x", "x", "y")
    } catch (error) {
      expect(error).toMatchObject({ code: "ambiguous", matches: 3 })
    }
    expect(editText("x x x", "x", "y", true)).toEqual({ content: "y y y", bom: false, replacements: 3 })
  })

  test("falls back to Unicode normalization and then trailing-whitespace matching", () => {
    expect(editText("“first”   \n", '"first"', "matched")).toEqual({
      content: "matched   \n",
      bom: false,
      replacements: 1,
    })
    expect(editText("alpha   \nbeta\t\n", "alpha\nbeta", "done")).toEqual({
      content: "done\n",
      bom: false,
      replacements: 1,
    })
  })

  test("normalizes requested newlines to CRLF", () => {
    expect(editText("one\r\ntwo\r\n", "one\ntwo\n", "three\nfour\n")).toEqual({
      content: "three\r\nfour\r\n",
      bom: false,
      replacements: 1,
    })
  })

  test("preserves an existing BOM and canonicalizes a replacement BOM", () => {
    const preserved = editText("\uFEFFold\n", "old", "new")
    expect(preserved).toEqual({ content: "new\n", bom: true, replacements: 1 })
    expect(joinBom(preserved.content, preserved.bom)).toBe("\uFEFFnew\n")
    expect(editText("old\n", "old", "\uFEFFnew")).toEqual({ content: "new\n", bom: true, replacements: 1 })
  })

  test("rejects empty, identical, and missing searches", () => {
    expect(() => editText("text", "", "new")).toThrow("oldString must not be empty")
    expect(() => editText("text", "text", "text")).toThrow("identical")
    expect(() => editText("text", "missing", "new")).toThrow("Could not find oldString")
  })
})
