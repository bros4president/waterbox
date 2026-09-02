import type { ReadableIdGenerator } from "@waterbox/core"
import objectsSource from "./vendor/friendly-words/objects.txt"
import predicatesSource from "./vendor/friendly-words/predicates.txt"

/** Exact upstream source revision; the corpus is vendored below, not fetched at runtime. */
export const FRIENDLY_WORDS_REVISION = "f94b4639c71c26875f7684fa86a214c7f30deaad"
export const FRIENDLY_WORDS_SHA256 = {
  predicates: "1bc3e7adde5eb212f355a49e5e4482cfc278dbad1614ac28cca9494cd86c59d8",
  objects: "072978f359e3a1687da8a8c208fbe8abf9d4218e6f6414e35c8fa677fc425c9b",
} as const

export const FRIENDLY_PREDICATES = words(predicatesSource)
export const FRIENDLY_OBJECTS = words(objectsSource)
export const FRIENDLY_WORDS_SOURCE = { predicates: predicatesSource, objects: objectsSource } as const

/**
 * Samples [0, length) with rejection rather than accepting a modulo-biased
 * remainder of the uint32 space. Exported for deterministic integrity tests.
 */
export function uniformWordIndex(length: number, nextUint32: () => number): number {
  if (!Number.isSafeInteger(length) || length < 1 || length > 0x1_0000_0000) throw new RangeError("Word list length is invalid")
  const limit = Math.floor(0x1_0000_0000 / length) * length
  while (true) {
    const value = nextUint32()
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError("Random source returned an invalid uint32")
    if (value < limit) return value % length
  }
}

export class FriendlyReadableIds implements ReadableIdGenerator {
  readonly #nextUint32: () => number

  constructor(nextUint32: () => number = secureUint32) { this.#nextUint32 = nextUint32 }

  sandboxId(): string { return `sbx_${this.#words()}` }
  snapshotId(): string { return `snap_${this.#words()}` }

  #words(): string {
    const predicateOne = FRIENDLY_PREDICATES[uniformWordIndex(FRIENDLY_PREDICATES.length, this.#nextUint32)]!
    const predicateTwo = FRIENDLY_PREDICATES[uniformWordIndex(FRIENDLY_PREDICATES.length, this.#nextUint32)]!
    const object = FRIENDLY_OBJECTS[uniformWordIndex(FRIENDLY_OBJECTS.length, this.#nextUint32)]!
    return `${predicateOne}-${predicateTwo}-${object}`
  }
}

function words(source: string): readonly string[] {
  const result = source.trimEnd().split("\n")
  if (result.length === 0 || result.some(word => !/^[a-z]+$/.test(word))) throw new Error("Vendored Friendly Words corpus is invalid")
  return result
}

function secureUint32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!
}
