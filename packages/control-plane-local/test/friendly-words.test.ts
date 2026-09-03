import { describe, expect, test } from "bun:test"
import { SandboxIdSchema, SnapshotIdSchema } from "@waterbox/contracts"
import { createHash } from "node:crypto"
import {
  FRIENDLY_OBJECTS,
  FRIENDLY_PREDICATES,
  FRIENDLY_WORDS_REVISION,
  FRIENDLY_WORDS_SHA256,
  FRIENDLY_WORDS_SOURCE,
  FriendlyReadableIds,
  uniformWordIndex,
} from "../src/friendly-words.ts"

describe("vendored Friendly Words IDs", () => {
  test("preserves the exact pinned upstream corpus", () => {
    expect(FRIENDLY_WORDS_REVISION).toBe("f94b4639c71c26875f7684fa86a214c7f30deaad")
    expect(FRIENDLY_PREDICATES).toHaveLength(1_450)
    expect(FRIENDLY_OBJECTS).toHaveLength(3_062)
    for (const words of [FRIENDLY_PREDICATES, FRIENDLY_OBJECTS]) {
      expect(new Set(words).size).toBe(words.length)
      expect(words.every(word => /^[a-z]+$/.test(word))).toBeTrue()
    }
    expect(createHash("sha256").update(FRIENDLY_WORDS_SOURCE.predicates).digest("hex")).toBe(FRIENDLY_WORDS_SHA256.predicates)
    expect(createHash("sha256").update(FRIENDLY_WORDS_SOURCE.objects).digest("hex")).toBe(FRIENDLY_WORDS_SHA256.objects)
  })

  test("uses exactly two predicates and one object after each resource prefix", () => {
    const draws = [0, 1, 2, 3, 4, 5]
    const ids = new FriendlyReadableIds(() => draws.shift()!)
    expect(ids.sandboxId()).toBe(`sbx_${FRIENDLY_PREDICATES[0]}-${FRIENDLY_PREDICATES[1]}-${FRIENDLY_OBJECTS[2]}`)
    expect(ids.snapshotId()).toBe(`snap_${FRIENDLY_PREDICATES[3]}-${FRIENDLY_PREDICATES[4]}-${FRIENDLY_OBJECTS[5]}`)
  })

  test("rejects the biased remainder of uint32 sampling before taking an index", () => {
    const draws = [0xffff_ffff, 4]
    expect(uniformWordIndex(3, () => draws.shift()!)).toBe(1)
    expect(draws).toEqual([])
  })

  test("longest friendly names satisfy Waterbox public ID schemas", () => {
    const suffix = "quintessential-quintessential-gigantspinosaurus"
    expect(SandboxIdSchema.parse(`sbx_${suffix}`)).toBe(`sbx_${suffix}`)
    expect(SnapshotIdSchema.parse(`snap_${suffix}`)).toBe(`snap_${suffix}`)
  })
})
