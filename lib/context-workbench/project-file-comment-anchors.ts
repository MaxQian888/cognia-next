import diff from "fast-diff"
import { sha256String } from "@/lib/ocr/hash"
import { lineRangeFromOffsets } from "@/lib/canvas/collaboration/relative-anchor"
import type { ContextCommentAnchor } from "@/types/context-comment"
import type { LineRange } from "@/types/canvas/collaboration"

export const QUOTE_LIMIT = 8 * 1024
export const CONTEXT_LIMIT = 128
export const FUZZY_LINE_WINDOW = 200
export const FUZZY_MIN_SIMILARITY = 0.9
export const FUZZY_MIN_LEAD = 0.1

type TextAnchor = Extract<ContextCommentAnchor, { kind: "text-range" }>
export interface ProjectFileAnchorResolution {
  status: "resolved" | "moved" | "orphaned" | "legacy-stale"
  start?: number
  end?: number
  lineRange?: LineRange
  method: "identical" | "diff" | "quote-exact" | "quote-fuzzy" | "none"
  confidence: number
}

export async function createProjectFileAnchor(
  text: string,
  start: number,
  end: number,
  baseContentSha256?: string
): Promise<TextAnchor> {
  if (!validRange(start, end, text.length)) throw new RangeError("Invalid comment range")
  const quote = text.slice(start, end)
  const [baseHash, quoteSha256] = await Promise.all([
    baseContentSha256 ?? sha256String(text),
    sha256String(quote),
  ])
  return {
    kind: "text-range",
    anchorVersion: 1,
    start,
    end,
    revision: baseHash,
    baseContentSha256: baseHash,
    lineRange: lineRangeFromOffsets(text, start, end),
    quotedText: quote.slice(0, QUOTE_LIMIT),
    quoteComplete: quote.length <= QUOTE_LIMIT,
    quoteLength: quote.length,
    quoteSha256,
    prefixContext: text.slice(Math.max(0, start - CONTEXT_LIMIT), start),
    suffixContext: text.slice(end, end + CONTEXT_LIMIT),
  }
}

function validRange(start: number, end: number, length: number) {
  return (
    Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= length
  )
}

/** Encode complete lines for fast-diff, then refine changed blocks at character boundaries. */
function textDiff(before: string, after: string): diff.Diff[] | null {
  const lines = new Map<string, string>()
  const encode = (text: string) =>
    (text.match(/[^\n]*\n|[^\n]+$/g) ?? [])
      .map((line) => {
        if (!lines.has(line)) lines.set(line, String.fromCharCode(lines.size + 1))
        return lines.get(line)!
      })
      .join("")
  const oldLines = encode(before)
  const newLines = encode(after)
  // Keep encoded tokens out of the surrogate range fast-diff treats as pairs.
  if (lines.size >= 0xd800) return null
  const values = ["", ...lines.keys()]
  const decode = (tokens: string) =>
    tokens
      .split("")
      .map((token) => values[token.charCodeAt(0)])
      .join("")
  const result: diff.Diff[] = []
  let removed = ""
  let added = ""
  const flush = () => {
    if (removed || added) result.push(...diff(removed, added))
    removed = ""
    added = ""
  }
  for (const [op, tokens] of diff(oldLines, newLines)) {
    if (op === 0) {
      flush()
      result.push([0, decode(tokens)])
    } else if (op === -1) removed += decode(tokens)
    else added += decode(tokens)
  }
  flush()
  return result
}

function mapRange(parts: diff.Diff[], start: number, end: number) {
  let oldOffset = 0
  let newOffset = 0
  let from: number | undefined
  let to: number | undefined
  let retained = 0
  for (const [op, value] of parts) {
    const length = value.length
    if (op === 1) {
      newOffset += length
      continue
    }
    if (op === 0) {
      // Start sticks right, end sticks left; insertions at the edges stay outside.
      if (start >= oldOffset && start < oldOffset + length) from = newOffset + start - oldOffset
      if (end > oldOffset && end <= oldOffset + length) to = newOffset + end - oldOffset
      retained += Math.max(0, Math.min(end, oldOffset + length) - Math.max(start, oldOffset))
      if (start === end && start >= oldOffset && start < oldOffset + length) to = from
      newOffset += length
    } else {
      if (start >= oldOffset && start < oldOffset + length) from = newOffset
      if (end > oldOffset && end <= oldOffset + length) to = newOffset
    }
    oldOffset += length
  }
  if (start === oldOffset) from = newOffset
  if (end === oldOffset && to === undefined) to = newOffset
  if (start === end) to = from
  return from !== undefined && to !== undefined && to >= from && (retained > 0 || start === end)
    ? { start: from, end: to }
    : null
}

function contextScore(anchor: TextAnchor, text: string, start: number, end: number) {
  const prefix = anchor.prefixContext ?? ""
  const suffix = anchor.suffixContext ?? ""
  let matched = 0
  for (let i = 1; i <= prefix.length && start >= i; i++) {
    if (prefix[prefix.length - i] !== text[start - i]) break
    matched++
  }
  for (let i = 0; i < suffix.length && end + i < text.length; i++) {
    if (suffix[i] !== text[end + i]) break
    matched++
  }
  return matched / Math.max(1, prefix.length + suffix.length)
}

function isCodePointBoundary(text: string, offset: number) {
  const left = text.charCodeAt(offset - 1)
  const right = text.charCodeAt(offset)
  return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff)
}

type Candidate = { start: number; end: number; score: number }
/** Semi-global Levenshtein: match the quote against substrings of the bounded window. */
function fuzzyCandidates(quote: string, text: string, offset: number): Candidate[] {
  if (!quote.length) return []
  let previous = new Uint32Array(text.length + 1)
  let starts = Uint32Array.from({ length: text.length + 1 }, (_, i) => i)
  for (let i = 1; i <= quote.length; i++) {
    const row = new Uint32Array(text.length + 1)
    const rowStarts = new Uint32Array(text.length + 1)
    row[0] = i
    for (let j = 1; j <= text.length; j++) {
      const diagonal = previous[j - 1] + (quote[i - 1] === text[j - 1] ? 0 : 1)
      const deletion = previous[j] + 1
      const insertion = row[j - 1] + 1
      row[j] = Math.min(diagonal, deletion, insertion)
      rowStarts[j] =
        row[j] === diagonal ? starts[j - 1] : row[j] === deletion ? starts[j] : rowStarts[j - 1]
    }
    previous = row
    starts = rowStarts
  }
  const candidates: Candidate[] = []
  for (let end = 1; end <= text.length; end++) {
    const start = starts[end]
    const score = 1 - previous[end] / Math.max(quote.length, end - start)
    if (
      score >= FUZZY_MIN_SIMILARITY - FUZZY_MIN_LEAD &&
      isCodePointBoundary(text, start) &&
      isCodePointBoundary(text, end)
    )
      candidates.push({ start: offset + start, end: offset + end, score })
  }
  return candidates.sort(
    (a, b) =>
      b.score - a.score ||
      Math.abs(a.end - a.start - quote.length) - Math.abs(b.end - b.start - quote.length)
  )
}

/** Pure, display-only resolution. Hashes are UTF-8 SHA-256; offsets remain UTF-16. */
export async function resolveProjectFileAnchor(
  anchor: TextAnchor,
  currentText: string,
  opts: { baseText?: string; currentContentSha256?: string; currentRevision?: string } = {}
): Promise<ProjectFileAnchorResolution> {
  const none: ProjectFileAnchorResolution = { status: "orphaned", method: "none", confidence: 0 }
  // A CRDT host owns these positions; never replace its answer with quote heuristics.
  if (anchor.crdt || !validRange(anchor.start, anchor.end, Number.MAX_SAFE_INTEGER)) return none
  const result = (
    start: number,
    end: number,
    method: ProjectFileAnchorResolution["method"],
    confidence = 1
  ): ProjectFileAnchorResolution => ({
    status: start === anchor.start && end === anchor.end ? "resolved" : "moved",
    start,
    end,
    lineRange: lineRangeFromOffsets(currentText, start, end),
    method,
    confidence,
  })
  if (!anchor.baseContentSha256 && anchor.quotedText === undefined) {
    return anchor.revision && anchor.revision !== opts.currentRevision
      ? { ...none, status: "legacy-stale" }
      : validRange(anchor.start, anchor.end, currentText.length)
        ? result(anchor.start, anchor.end, "identical")
        : none
  }
  const hash = opts.currentContentSha256 ?? (await sha256String(currentText))
  if (
    hash === anchor.baseContentSha256 &&
    validRange(anchor.start, anchor.end, currentText.length)
  ) {
    return result(anchor.start, anchor.end, "identical")
  }
  const verify = async (start: number, end: number) =>
    anchor.quoteComplete !== false ||
    (anchor.quoteLength === end - start &&
      !!anchor.quoteSha256 &&
      (await sha256String(currentText.slice(start, end))) === anchor.quoteSha256)
  if (
    opts.baseText !== undefined &&
    anchor.baseContentSha256 &&
    (await sha256String(opts.baseText)) === anchor.baseContentSha256 &&
    validRange(anchor.start, anchor.end, opts.baseText.length)
  ) {
    const parts = textDiff(opts.baseText, currentText)
    const mapped = parts && mapRange(parts, anchor.start, anchor.end)
    if (mapped && (await verify(mapped.start, mapped.end)))
      return result(mapped.start, mapped.end, "diff")
  }
  const quote = anchor.quotedText
  if (quote === undefined || (quote === "" && !anchor.prefixContext && !anchor.suffixContext))
    return none
  const length = anchor.quoteComplete === false ? anchor.quoteLength : quote.length
  if (length === undefined || length < quote.length || !Number.isInteger(length)) return none
  const exact: Candidate[] = []
  for (let from = 0; from <= currentText.length;) {
    const start = currentText.indexOf(quote, from)
    if (start < 0) break
    const end = start + length
    if (end <= currentText.length && (await verify(start, end))) {
      const score = contextScore(anchor, currentText, start, end)
      if (quote.length || score > 0) exact.push({ start, end, score })
    }
    from = start + 1
  }
  exact.sort(
    (a, b) =>
      b.score - a.score || Math.abs(a.start - anchor.start) - Math.abs(b.start - anchor.start)
  )
  if (exact.length) {
    const [best, second] = exact
    if (
      second &&
      best.score === second.score &&
      Math.abs(best.start - anchor.start) === Math.abs(second.start - anchor.start)
    )
      return none
    return result(best.start, best.end, "quote-exact")
  }
  if (anchor.quoteComplete === false) return none
  const lines = currentText.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const oldLine = Math.max(
    0,
    (anchor.lineRange?.startLine ??
      lineRangeFromOffsets(currentText, anchor.start, anchor.start).startLine) - 1
  )
  const firstLine = Math.max(0, oldLine - FUZZY_LINE_WINDOW)
  const offset = lines.slice(0, firstLine).join("").length
  const window = lines.slice(firstLine, oldLine + FUZZY_LINE_WINDOW + 1).join("")
  const candidates = fuzzyCandidates(quote, window, offset)
  const best = candidates[0]
  if (!best || best.score < FUZZY_MIN_SIMILARITY) return none
  // Different endpoints at one start are variants of the same occurrence.
  // Equally strong overlapping occurrences with different starts are ambiguous too.
  if (
    candidates.some(
      (candidate) =>
        candidate.start !== best.start &&
        candidate.score === best.score &&
        candidate.end - candidate.start === best.end - best.start
    )
  )
    return none
  const second = candidates.find(
    (candidate) => candidate.end <= best.start || candidate.start >= best.end
  )
  if (second && best.score - second.score < FUZZY_MIN_LEAD - Number.EPSILON) return none
  return result(best.start, best.end, "quote-fuzzy", best.score)
}
