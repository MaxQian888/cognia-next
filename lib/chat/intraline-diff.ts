// Intraline (word/character-level) diff shared by the chat diff renderers
// (`components/chat/message-parts/mcp-renderers/diff-preview.tsx` and
// `components/chat/renderers/diff-block.tsx`). Wraps `fast-diff` (a tiny
// char-level Myers implementation) and splits the result into per-side
// segments so each line can highlight exactly the changed runs instead of
// painting the whole line one color.

import diff from "fast-diff"

export type IntralineSegmentKind = "equal" | "removed" | "added"

export interface IntralineSegment {
  value: string
  kind: IntralineSegmentKind
}

export interface IntralineDiff {
  /** Segments for the OLD line — `equal` runs plus `removed` runs. */
  removed: IntralineSegment[]
  /** Segments for the NEW line — `equal` runs plus `added` runs. */
  added: IntralineSegment[]
}

/**
 * Above this combined length we skip the intraline pass — char-level diffing
 * two very long lines is not worth the cost (and the visual gain is nil), so
 * callers fall back to whole-line coloring. Returns null in that case and when
 * the two lines are identical (nothing to emphasize).
 */
export const MAX_INTRALINE_LENGTH = 2000

export function computeIntralineDiff(oldLine: string, newLine: string): IntralineDiff | null {
  if (oldLine === newLine) return null
  if (oldLine.length + newLine.length > MAX_INTRALINE_LENGTH) return null

  const parts = diff(oldLine, newLine)
  const removed: IntralineSegment[] = []
  const added: IntralineSegment[] = []
  for (const [op, text] of parts) {
    if (text.length === 0) continue
    if (op === diff.EQUAL) {
      removed.push({ value: text, kind: "equal" })
      added.push({ value: text, kind: "equal" })
    } else if (op === diff.DELETE) {
      removed.push({ value: text, kind: "removed" })
    } else {
      added.push({ value: text, kind: "added" })
    }
  }
  return { removed, added }
}
