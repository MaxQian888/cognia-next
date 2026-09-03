/**
 * Split a composer line into segments so the `Input` component can color the
 * mention tokens it contains (`@skill:…`, `@agent:…`, `@file:…`) without
 * changing the underlying plain-text buffer. Pure + cosmetic.
 */
import type { MentionKind } from "./types"

export interface LineSegment {
  text: string
  /** The mention kind when this segment is a token, else `undefined` (plain). */
  kind?: MentionKind
}

// `@skill:`/`@agent:`/`@file:` followed by a run of non-space chars.
const TOKEN = /@(skill|agent|file):\S+/g

/**
 * Tokenize a single line into plain + mention segments, in order. A line with
 * no mention tokens returns a single plain segment (the whole line).
 */
export function highlightMentions(line: string): LineSegment[] {
  const segments: LineSegment[] = []
  let last = 0
  for (const m of line.matchAll(TOKEN)) {
    // `matchAll` always populates `index` for a global regex.
    const start = m.index
    if (start > last) segments.push({ text: line.slice(last, start) })
    const prefix = m[1] as "skill" | "agent" | "file"
    segments.push({ text: m[0], kind: prefix as MentionKind })
    last = start + m[0].length
  }
  if (last < line.length) segments.push({ text: line.slice(last) })
  if (segments.length === 0) segments.push({ text: line })
  return segments
}

/** A {@link LineSegment} plus a flag for the single run the caret occupies. */
export interface CursorLineSegment extends LineSegment {
  cursor?: boolean
}

/**
 * The block glyph the caret uses when it sits past the last character.
 *
 * Ink trims styling from a trailing blank cell, so an inverse space at the end
 * of a line renders as nothing at all. A block glyph survives that pass while
 * showing the same single-cell caret.
 */
export const END_OF_LINE_CARET = "█"

/**
 * Tokenize a line and split out the cell the caret occupies, so the row the
 * cursor is on can be drawn with both the caret and its mention colours.
 *
 * The composer used to fall back to unhighlighted text on whichever row held
 * the cursor, so an `@agent:` token changed colour as the cursor moved onto
 * and off its line. `cursorEnd` is the next grapheme boundary, so a caret over
 * a wide or combined character covers the whole cluster.
 */
export function highlightMentionsWithCursor(
  line: string,
  cursorCol: number,
  cursorEnd: number
): CursorLineSegment[] {
  const out: CursorLineSegment[] = []
  let offset = 0
  for (const segment of highlightMentions(line)) {
    const end = offset + segment.text.length
    if (cursorCol >= offset && cursorCol < end) {
      const kind = segment.kind ? { kind: segment.kind } : {}
      const from = cursorCol - offset
      const to = Math.min(Math.max(cursorEnd - offset, from + 1), segment.text.length)
      const before = segment.text.slice(0, from)
      const after = segment.text.slice(to)
      if (before) out.push({ text: before, ...kind })
      out.push({ text: segment.text.slice(from, to), ...kind, cursor: true })
      if (after) out.push({ text: after, ...kind })
    } else if (segment.text) {
      out.push(segment)
    }
    offset = end
  }
  // Past the last character: an empty line, or the cursor parked at the end.
  if (cursorCol >= offset) out.push({ text: END_OF_LINE_CARET, cursor: true })
  return out
}
