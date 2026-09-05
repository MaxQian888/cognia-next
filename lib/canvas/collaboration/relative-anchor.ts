/**
 * Anchoring a comment to text that keeps moving.
 *
 * # What an absolute offset costs
 *
 * A Canvas comment is pinned with `{ start, end }` plus a `revision`, and
 * `isContextCommentAnchorStale` marks it stale the moment the revision
 * changes. That is the honest thing to do with an offset, because an offset is
 * wrong as soon as anybody types above it: adding one line at the top of a
 * file moves every comment in it, and there is no way to tell a moved comment
 * from a correct one. So the whole thread gets greyed out, and the person who
 * wrote it has to go and find the line again.
 *
 * A Yjs relative position is not an index. It names the character itself,
 * inside the CRDT's own structure, so it survives insertions, deletions and
 * concurrent edits by other people. The comment moves with the text it was
 * about, and only becomes unresolvable when the text it named is actually
 * deleted.
 *
 * # Which way the ends stick
 *
 * A range has to decide what happens when somebody types exactly at its edge.
 * The start associates rightward and the end leftward, so text typed at either
 * boundary lands OUTSIDE the comment. That matches what the comment meant: it
 * was written about the characters that were there, not about whatever gets
 * appended to them later.
 */

import * as Y from "yjs"
import { fromBase64, toBase64 } from "lib0/buffer"

import type { CanvasCrdtAnchor, LineRange } from "@/types/canvas/collaboration"
import { loggers } from "@cognia/logging"

export type { CanvasCrdtAnchor }

/** Sticks to the character on its right, so an insertion at the start pushes it along. */
const START_ASSOCIATION = 0
/** Sticks to the character on its left, so an insertion at the end stays outside. */
const END_ASSOCIATION = -1

function encodeOne(text: Y.Text, index: number, association: number): string {
  const relative = Y.createRelativePositionFromTypeIndex(text, index, association)
  return toBase64(Y.encodeRelativePosition(relative))
}

/**
 * Name a range of the shared text.
 *
 * `null` when the offsets do not describe a range inside the document, rather
 * than clamping: a comment anchored to a position that was never there is a
 * comment pointing at the wrong text, which is worse than one that admits it
 * has no anchor and falls back to the stored offsets.
 */
export function encodeCrdtAnchor(
  text: Y.Text,
  start: number,
  end: number
): CanvasCrdtAnchor | null {
  const length = text.length
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || end < start || end > length) return null
  try {
    return {
      anchor: encodeOne(text, start, START_ASSOCIATION),
      head: encodeOne(text, end, END_ASSOCIATION),
    }
  } catch (error) {
    loggers.canvas.warn("canvas anchor could not be encoded", { error: String(error) })
    return null
  }
}

/**
 * Where the range is now.
 *
 * `null` when either end no longer resolves, which is what happens when the
 * text the comment named was deleted. That is a real answer: the comment is
 * orphaned, and pretending it still points somewhere would attach it to
 * whatever moved into that offset.
 */
export function resolveCrdtAnchor(
  doc: Y.Doc,
  anchor: CanvasCrdtAnchor
): { start: number; end: number } | null {
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(fromBase64(anchor.anchor)),
      doc
    )
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(fromBase64(anchor.head)),
      doc
    )
    if (!start || !end) return null
    // A range whose ends crossed is not a range. It can happen when the middle
    // was deleted from both sides at once.
    if (end.index < start.index) return null
    return { start: start.index, end: end.index }
  } catch (error) {
    loggers.canvas.warn("canvas anchor could not be resolved", { error: String(error) })
    return null
  }
}

/**
 * Offsets to a one-based line range, which is what the comment UI shows.
 *
 * Kept here rather than in the UI because the anchor is the thing that knows
 * offsets, and two implementations of "which line is offset 412 on" would
 * disagree about a trailing newline sooner or later.
 */
export function lineRangeFromOffsets(content: string, start: number, end: number): LineRange {
  const position = (offset: number) => {
    const clamped = Math.max(0, Math.min(offset, content.length))
    const before = content.slice(0, clamped)
    const line = before.split("\n").length
    const column = clamped - (before.lastIndexOf("\n") + 1) + 1
    return { line, column }
  }
  const from = position(start)
  const to = position(end)
  return {
    startLine: from.line,
    startColumn: from.column,
    endLine: to.line,
    endColumn: to.column,
  }
}
