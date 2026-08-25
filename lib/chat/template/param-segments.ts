// Split `{{parameter}}` tokens out of composer text so the chip overlay can
// paint them and the send path can resolve them.
//
// This is the mention model applied to parameters: the textarea stays the
// single source of truth, the token stays literally in the text, and this pass
// derives a pill range from it. Because the text carries the token, a reload
// recovers the parameters for free — there is no side map of offsets to keep in
// step with the user's edits, and deleting part of a token silently demotes it
// back to ordinary characters, which is exactly the escape hatch a textarea
// should never lose.
//
// It lives outside `lib/slash-commands/parse-segments.ts` because recognising a
// parameter requires knowing which spans of the input are code — a Markdown
// concern the command parser has no business learning. Callers compose the two:
//
//   splitParamSegments(
//     parseSegments(text, isKnownCommand, { mentions: true }),
//     computeCodeRanges(text)
//   )

import type { ParamSegment, RichSegment } from "@/lib/slash-commands/parse-segments"
import { isInCodeRange, type CodeRange } from "./code-ranges"

/**
 * Longest accepted parameter id, matching the platform's own `IDENTIFIER` rule
 * in `lib/templates/contracts.ts` so a token that paints as a pill here is a id
 * the template envelope can also declare.
 */
export const PARAM_ID_MAX_LENGTH = 128

/**
 * `{{ id }}` — braces, optional inner space, an id that starts and ends
 * alphanumeric. The inner space is accepted because `{{ topic }}` reads better
 * and because every other `{{}}` dialect allows it; it is trimmed off `paramId`
 * so two spellings of the same parameter are the same parameter.
 *
 * Constructed per call rather than shared: a `g` regex carries `lastIndex`
 * between uses, and this module is called on every keystroke.
 */
function paramTokenPattern(): RegExp {
  return /\{\{\s*([A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?)\s*\}\}/g
}

/**
 * Every parameter token in `input`, in source order, skipping anything inside
 * `codeRanges`. Absolute indices, so the result is usable against the raw
 * composer value without a second pass.
 */
export function listParamTokens(
  input: string,
  codeRanges: readonly CodeRange[] = []
): ParamSegment[] {
  const out: ParamSegment[] = []
  const pattern = paramTokenPattern()
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    const paramId = match[1]
    const start = match.index
    const end = start + match[0].length
    if (paramId.length > PARAM_ID_MAX_LENGTH) continue
    if (isInCodeRange(codeRanges, start, end)) continue
    out.push({ kind: "param", paramId, raw: match[0], start, end })
  }
  return out
}

/** The distinct parameter ids referenced by `input`, in first-appearance order. */
export function listParamIds(input: string, codeRanges: readonly CodeRange[] = []): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const token of listParamTokens(input, codeRanges)) {
    if (seen.has(token.paramId)) continue
    seen.add(token.paramId)
    ids.push(token.paramId)
  }
  return ids
}

/**
 * Split `{{parameter}}` tokens out of the text segments of an already-parsed
 * list, preserving absolute indices and overall contiguity.
 *
 * Non-text segments pass through untouched, so a parameter inside a
 * `/command`'s arguments is left alone: a command's args are handed to
 * `applyTemplate`, which has its own `$1` / `$ARGUMENTS` substitution, and two
 * substitution passes over one string is how a value that happens to contain
 * `$1` gets mangled.
 */
export function splitParamSegments(
  segments: readonly RichSegment[],
  codeRanges: readonly CodeRange[] = []
): RichSegment[] {
  return segments.flatMap((seg) => splitParams(seg, codeRanges))
}

function splitParams(seg: RichSegment, codeRanges: readonly CodeRange[]): RichSegment[] {
  if (seg.kind !== "text") return [seg]
  const tokens = listParamTokens(seg.value, shiftRanges(codeRanges, -seg.start))
  if (tokens.length === 0) return [seg]

  const out: RichSegment[] = []
  let cursor = 0
  for (const token of tokens) {
    if (token.start > cursor) {
      out.push({
        kind: "text",
        value: seg.value.slice(cursor, token.start),
        start: seg.start + cursor,
        end: seg.start + token.start,
      })
    }
    out.push({
      ...token,
      start: seg.start + token.start,
      end: seg.start + token.end,
    })
    cursor = token.end
  }
  if (cursor < seg.value.length) {
    out.push({
      kind: "text",
      value: seg.value.slice(cursor),
      start: seg.start + cursor,
      end: seg.start + seg.value.length,
    })
  }
  return out
}

/** Re-base absolute code ranges onto a segment's local coordinates. */
function shiftRanges(ranges: readonly CodeRange[], delta: number): CodeRange[] {
  if (delta === 0 || ranges.length === 0) return ranges as CodeRange[]
  return ranges.map((range) => ({ start: range.start + delta, end: range.end + delta }))
}
