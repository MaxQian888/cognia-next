// Atomic deletion for the composer's `/command`, `@mention`, `{{parameter}}`
// and folded-link pills. The textarea stays the source of truth, but a single
// Backspace/Delete next to an already-inserted pill should remove the WHOLE
// token (what the user sees as one chip) instead of nibbling one character and
// leaving a broken half-token like `/rese`. This is a pure range computation
// so it can be unit-tested without a textarea; the composer applies the range.
//
// Note what this does NOT do: it never prevents the user from editing inside a
// token. A caret placed in the middle of `{{module}}` still deletes one
// character, which demotes the pill to ordinary text. That escape hatch is the
// point of keeping the token in a plain textarea — convenience at the edges,
// never a cage.

import { LINK_MARKER } from "@/lib/chat/link-fold"
import type { RichSegment } from "@/lib/slash-commands/parse-segments"

export type DeleteDirection = "backward" | "forward"

/** The segment kinds that render as a chip, and therefore delete as one. */
const PILL_KINDS = new Set(["command", "mention", "param", "link"])

type PillSegment = Extract<RichSegment, { kind: "command" | "mention" | "param" | "link" }>

/**
 * Only a FOLDED link deletes as one object.
 *
 * `splitLinkSegments` emits a `link` segment for every raw `https://…` run it
 * finds, not just for folded labels — and `foldLinks` deliberately never folds
 * the URL the caret is inside or at the end of, so a URL being typed is always
 * one of those raw segments. Treating it as a pill made the first Backspace
 * after `https://github.com/svenstro` wipe the whole address instead of the
 * typo, and with the `full` link style (where nothing ever folds) that was
 * every URL in the box, forever.
 *
 * The marker prefix is the same test the chip overlay paints by, so the two
 * layers agree on which spans are labels standing in for something else.
 */
function isFoldedLinkSegment(seg: PillSegment): boolean {
  return seg.kind === "link" && seg.raw.startsWith(LINK_MARKER)
}

/** Exclusive end index of a segment's VISIBLE pill (the part the chip covers). */
function pillEndOf(seg: PillSegment): number {
  // Command pills cover only the `/name` head (args render as plain text);
  // mention, parameter and link pills cover their whole token. A folded link is
  // one object to the reader — `svenstaro/genact` is not five words — so one
  // Backspace takes all of it rather than leaving `svenstaro/gena`.
  return seg.kind === "command" ? seg.start + 1 + seg.name.length : seg.end
}

/**
 * Range to remove when Backspace/Delete lands on a `/command`, `@mention` or
 * `{{parameter}}` pill, so it deletes as one unit. Returns null when the caret
 * isn't hugging a pill (the caller then lets the textarea delete a single
 * character normally).
 *
 * - `backward` (Backspace): fires when the caret sits at the pill's right edge,
 *   or just past a single trailing space that follows it (so deleting a
 *   just-picked `/reset ` takes one keystroke, space included).
 * - `forward` (Delete): fires when the caret sits at the pill's left edge, and
 *   also eats one trailing space so the gap doesn't linger.
 * - A caret INSIDE a FOLDED link deletes the whole link either way. That is the
 *   one kind whose middle cannot be edited into anything meaningful: the text
 *   is a folded label standing in for a URL, so half of it is not "a shorter
 *   link", it is prose that used to be one. Commands, mentions and parameters
 *   keep the escape hatch — and so does a raw URL, which is just text (see
 *   {@link isFoldedLinkSegment}).
 */
export function pillDeleteRange(
  value: string,
  caret: number,
  segments: readonly RichSegment[],
  direction: DeleteDirection
): { start: number; end: number } | null {
  for (const seg of segments) {
    if (!PILL_KINDS.has(seg.kind)) continue
    const pill = seg as PillSegment
    // A raw, still-unfolded URL is ordinary text that happens to be matched by
    // the link scanner — it edits character by character like anything else.
    if (pill.kind === "link" && !isFoldedLinkSegment(pill)) continue
    const pillStart = seg.start
    const pillEnd = pillEndOf(pill)
    if (pillEnd <= pillStart) continue

    if (pill.kind === "link" && caret > pillStart && caret < pillEnd) {
      return { start: pillStart, end: pillEnd }
    }

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
