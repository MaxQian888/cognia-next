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
