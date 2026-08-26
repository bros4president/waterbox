// Adapted from anomalyco/opencode at c29a7c152da09e2828e9529a21d979d6f4d6a120.

const BOM = "\uFEFF"
const CRLF = "\r\n"

interface Match {
  readonly start: number
  readonly end: number
}

export type EditTextErrorCode = "identical" | "empty-search" | "not-found" | "ambiguous"

export class EditTextError extends Error {
  constructor(
    readonly code: EditTextErrorCode,
    message: string,
    readonly matches: number = 0,
  ) {
    super(message)
    this.name = "EditTextError"
  }
}

export interface EditTextResult {
  readonly content: string
  readonly bom: boolean
  readonly replacements: number
}

const normalizeForMatch = (value: string) =>
  value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")

const findOccurrences = (content: string, search: string): Match[] => {
  const result: Match[] = []
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    result.push({ start: offset, end: offset + search.length })
    offset += search.length
  }
  return result
}

const findLineOccurrences = (content: string, search: string): Match[] => {
  const trailingNewline = search.endsWith("\n")
  const expected = search.split("\n")
  if (trailingNewline) expected.pop()
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => {
      const newline = match[0].endsWith("\n")
      const text = newline ? match[0].slice(0, -1) : match[0]
      return {
        start: match.index,
        end: match.index + match[0].length,
        text,
        contentEnd: match.index + text.length - (text.endsWith("\r") ? 1 : 0),
        newline,
      }
    })
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length)
    if (actual.length !== expected.length) return []
    if (
      !actual.every(
        (item, lineIndex) =>
          normalizeForMatch(item.text.trimEnd()) === normalizeForMatch(expected[lineIndex]!.trimEnd()),
      )
    ) {
      return []
    }
    const last = actual.at(-1)!
    if (trailingNewline && !last.newline) return []
    return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }]
  })
  return candidates.reduce<Match[]>((result, candidate) => {
    if (result.some((match) => match.end > candidate.start && match.start < candidate.end)) return result
    result.push(candidate)
    return result
  }, [])
}

export function editText(
  original: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): EditTextResult {
  if (oldString === newString) {
    throw new EditTextError("identical", "No changes to apply: oldString and newString are identical.")
  }
  if (oldString === "") {
    throw new EditTextError("empty-search", "oldString must not be empty. Use write to create or overwrite a file.")
  }

  const source = splitBom(original)
  const ending = source.text.includes(CRLF) ? CRLF : "\n"
  const search = oldString.replaceAll(CRLF, "\n").replaceAll("\n", ending)
  const replacement = newString.replaceAll(CRLF, "\n").replaceAll("\n", ending)
  const exact = findOccurrences(source.text, search)
  const unicode = exact.length > 0 ? [] : findOccurrences(normalizeForMatch(source.text), normalizeForMatch(search))
  const trailing = exact.length > 0 || unicode.length > 0 ? [] : findLineOccurrences(source.text, search)
  const matches = exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing

  if (matches.length === 0) {
    throw new EditTextError(
      "not-found",
      "Could not find oldString. It must match exactly, including whitespace and indentation.",
    )
  }
  if (matches.length > 1 && !replaceAll) {
    throw new EditTextError(
      "ambiguous",
      `Found ${matches.length} matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.`,
      matches.length,
    )
  }

  const selected = replaceAll ? matches : matches.slice(0, 1)
  const replaced = [...selected]
    .reverse()
    .reduce(
      (content, match) => `${content.slice(0, match.start)}${replacement}${content.slice(match.end)}`,
      source.text,
    )
  const result = splitBom(replaced)
  return { content: result.text, bom: source.bom || result.bom, replacements: matches.length }
}

export function joinBom(text: string, bom: boolean): string {
  const stripped = splitBom(text).text
  return bom ? BOM + stripped : stripped
}

function splitBom(text: string): { bom: boolean; text: string } {
  const stripped = text.replace(/^\uFEFF+/, "")
  return { bom: stripped.length !== text.length, text: stripped }
}
