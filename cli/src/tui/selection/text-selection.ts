/**
 * The pure model behind in-app text selection ("划词"): an anchor/head pair over
 * screen coordinates, the granularity a click count implies, and the projection
 * of that range onto the captured frame — both as the text to copy and as the
 * per-row column spans to paint in reverse video.
 *
 * Coordinates are 0-based screen cells (row = frame line index, col = display
 * column), so a terminal mouse report converts with a plain `-1`. Everything
 * here is a value transform: no Ink, no terminal, no clipboard.
 */
import { sliceColumns } from "./ansi-columns"
import { stringWidth } from "../markdown/width"

/** A point on screen: frame row + display column, both 0-based. */
export interface Point {
  row: number
  col: number
}

/**
 * How much a drag takes at a time. A single press selects by character; a
 * double-click snaps to whole words; a triple-click takes whole rows.
 */
export type SelectionGranularity = "char" | "word" | "line"

/** A live selection: where the gesture started, where the pointer is now, and
 * the granularity the initiating click chose. */
export interface Selection {
  anchor: Point
  head: Point
  granularity: SelectionGranularity
}

/** One row's highlighted span — `[startCol, endCol)` in display columns. */
export interface RowSpan {
  row: number
  startCol: number
  endCol: number
}

/** Max gap between presses that still counts as a double / triple click. */
export const MULTI_CLICK_MS = 400

/** Characters that belong to a "word" for double-click snapping. Deliberately
 * wider than `\w`: paths, flags and identifiers should snap whole. */
const WORD_CHAR = /[\p{L}\p{N}_\-./@:+~]/u

/**
 * Resolve the granularity of a press from the click that preceded it. Presses
 * cycle char → word → line and back, but only while they land on the same cell
 * within {@link MULTI_CLICK_MS}; anything else restarts at `char`.
 */
export function nextGranularity(
  previous: { at: number; point: Point; granularity: SelectionGranularity } | null,
  at: number,
  point: Point
): SelectionGranularity {
  if (
    !previous ||
    at - previous.at > MULTI_CLICK_MS ||
    previous.point.row !== point.row ||
    previous.point.col !== point.col
  ) {
    return "char"
  }
  if (previous.granularity === "char") return "word"
  if (previous.granularity === "word") return "line"
  return "char"
}

/** Order two points top-to-bottom, left-to-right. */
function ordered(a: Point, b: Point): [Point, Point] {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) return [a, b]
  return [b, a]
}

/** Display width of a plain (already ANSI-stripped) frame row. */
function rowWidth(lines: readonly string[], row: number): number {
  const line = lines[row]
  return line === undefined ? 0 : stringWidth(line)
}

/**
 * Expand a column into the word around it on `line`. Returns the half-open
 * `[start, end)` column range; a click on whitespace (or past the end of the
 * line) selects just that cell so the gesture still gives feedback.
 */
export function wordSpanAt(line: string, col: number): { start: number; end: number } {
  // Walk the line once, recording each glyph's starting column so the scan below
  // works in display columns even with wide characters in play.
  const cells: { char: string; col: number; width: number }[] = []
  let cursor = 0
  for (const ch of line) {
    const w = stringWidth(ch)
    cells.push({ char: ch, col: cursor, width: w })
    cursor += w
  }
  const index = cells.findIndex((c) => col >= c.col && col < c.col + c.width)
  if (index === -1 || !WORD_CHAR.test(cells[index].char)) return { start: col, end: col + 1 }
  let first = index
  while (first > 0 && WORD_CHAR.test(cells[first - 1].char)) first--
  let last = index
  while (last + 1 < cells.length && WORD_CHAR.test(cells[last + 1].char)) last++
  return { start: cells[first].col, end: cells[last].col + cells[last].width }
}

/**
 * Project a selection onto the frame: one column range per covered row, in
 * frame order, INCLUDING rows whose range is empty.
 *
 * `char` takes the literal drag range (end-inclusive of the cell under the
 * pointer, hence the `+1`). `word` widens both ends to word boundaries, so
 * dragging through the middle of two identifiers still takes both whole.
 * `line` takes every covered row end to end. Rows outside the frame are
 * dropped; empty ranges are kept because a blank row inside a multi-row drag is
 * a real blank line in the copied text.
 */
function rowRanges(selection: Selection, lines: readonly string[]): readonly RowSpan[] {
  const [from, to] = ordered(selection.anchor, selection.head)
  const firstRow = Math.max(0, from.row)
  const lastRow = Math.min(lines.length - 1, to.row)
  if (lines.length === 0 || lastRow < firstRow) return []

  const ranges: RowSpan[] = []
  for (let row = firstRow; row <= lastRow; row++) {
    const width = rowWidth(lines, row)
    let startCol = row === from.row ? from.col : 0
    let endCol = row === to.row ? to.col + 1 : width
    if (selection.granularity === "line") {
      startCol = 0
      endCol = width
    } else if (selection.granularity === "word") {
      const line = lines[row] ?? ""
      if (row === from.row) startCol = wordSpanAt(line, startCol).start
      if (row === to.row) endCol = wordSpanAt(line, to.col).end
    }
    startCol = Math.max(0, startCol)
    ranges.push({ row, startCol, endCol: Math.max(endCol, startCol) })
  }
  return ranges
}

/** The rows to paint in reverse video — {@link rowRanges} minus the empty ones,
 * so a blank row inside a drag isn't given a phantom highlight. */
export function selectionSpans(selection: Selection, lines: readonly string[]): readonly RowSpan[] {
  return rowRanges(selection, lines).filter((span) => span.endCol > span.startCol)
}

/**
 * The text a selection copies: every covered row sliced to its range and joined
 * with newlines. Trailing whitespace is trimmed per row — the highlight pads
 * short rows to a straight edge, but those pad cells are not content.
 */
export function selectionText(selection: Selection, lines: readonly string[]): string {
  const ranges = rowRanges(selection, lines)
  if (ranges.length === 0) return ""
  const rows = ranges.map((span) =>
    sliceColumns(lines[span.row] ?? "", span.startCol, span.endCol).replace(/\s+$/, "")
  )
  // A drag that only ever covered blank cells copied nothing at all.
  return rows.every((row) => row.length === 0) ? "" : rows.join("\n")
}

/** Total characters a selection would copy — the count shown after a copy. */
export function selectionLength(selection: Selection, lines: readonly string[]): number {
  return selectionText(selection, lines).length
}
