// Atomic deletion for the composer's `/command` and `@mention` pills. The
// textarea stays the source of truth, but a single Backspace/Delete next to an
// already-inserted pill should remove the WHOLE token (what the user sees as one
// chip) instead of nibbling one character and leaving a broken half-token like
// `/rese`. This is a pure range computation so it can be unit-tested without a
// textarea; the composer applies the returned range.

import type { RichSegment } from "@/lib/slash-commands/parse-segments"

export type DeleteDirection = "backward" | "forward"

/** Exclusive end index of a segment's VISIBLE pill (the part the chip covers). */
function pillEndOf(seg: Extract<RichSegment, { kind: "command" | "mention" }>): number {
  // Command pills cover only the `/name` head (args render as plain text);
  // mention pills cover the whole `@token`.
  return seg.kind === "command" ? seg.start + 1 + seg.name.length : seg.end
}

/**
 * Range to remove when Backspace/Delete lands on a `/command` or `@mention`
 * pill, so it deletes as one unit. Returns null when the caret isn't hugging a
 * pill (the caller then lets the textarea delete a single character normally).
 *
 * - `backward` (Backspace): fires when the caret sits at the pill's right edge,
 *   or just past a single trailing space that follows it (so deleting a
 *   just-picked `/reset ` takes one keystroke, space included).
 * - `forward` (Delete): fires when the caret sits at the pill's left edge, and
 *   also eats one trailing space so the gap doesn't linger.
 */
export function pillDeleteRange(
  value: string,
  caret: number,
  segments: readonly RichSegment[],
  direction: DeleteDirection
): { start: number; end: number } | null {
  for (const seg of segments) {
    if (seg.kind !== "command" && seg.kind !== "mention") continue
    const pillStart = seg.start
    const pillEnd = pillEndOf(seg)
    if (pillEnd <= pillStart) continue

    if (direction === "backward") {
      if (caret === pillEnd) return { start: pillStart, end: pillEnd }
      if (caret === pillEnd + 1 && value[pillEnd] === " ") {
        return { start: pillStart, end: pillEnd + 1 }
      }
    } else if (caret === pillStart) {
      const end = value[pillEnd] === " " ? pillEnd + 1 : pillEnd
      return { start: pillStart, end }
    }
  }
  return null
}
