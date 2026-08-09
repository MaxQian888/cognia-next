/**
 * Pure mapping from a terminal mouse-click position to a composer buffer
 * cursor. Kept separate from `Input.tsx` so the column/row math is unit-tested
 * without rendering Ink or faking a terminal.
 */
import { stringWidth } from "../markdown/width"
import { graphemeSegments } from "../text/graphemes"

/**
 * Translate a screen column (counting display cells, where a CJK / fullwidth
 * glyph is 2 cells) into a buffer column (a UTF-16 index, matching how the
 * buffer slices lines). Snaps to the nearer edge of the clicked cell so clicking
 * the right half of a wide glyph lands the cursor after it.
 */
export function screenColToBufferCol(line: string, screenCol: number): number {
  if (screenCol <= 0) return 0
  let width = 0
  for (const grapheme of graphemeSegments(line)) {
    const w = stringWidth(grapheme.segment) || 1
    if (width + w > screenCol) {
      // Click landed inside this cell — snap to the nearer boundary.
      return (screenCol - width) * 2 >= w ? grapheme.end : grapheme.index
    }
    width += w
  }
  return line.length
}

/** A composer cursor position (logical line + UTF-16 column). */
export interface CursorTarget {
  row: number
  col: number
}

/**
 * Map an absolute terminal click (0-based row/col) to a composer cursor, given
 * the absolute top-left of the composer's lines container and the per-line
 * prompt-gutter width (`"› "` = 2). Returns null when the click is above/below
 * the text rows, so the caller leaves the cursor untouched.
 */
export function clickToCursor(args: {
  /** 0-based terminal row of the click. */
  clickRow: number
  /** 0-based terminal column of the click. */
  clickCol: number
  /** 0-based terminal row of the first composer text line. */
  boxTop: number
  /** 0-based terminal column where each text line's gutter starts. */
  boxLeft: number
  /** The composer's logical lines. */
  lines: string[]
  /** Width of the per-line prompt gutter before the text begins. */
  promptWidth: number
}): CursorTarget | null {
  const { clickRow, clickCol, boxTop, boxLeft, lines, promptWidth } = args
  const row = clickRow - boxTop
  if (row < 0 || row >= lines.length) return null
  const screenColInText = clickCol - boxLeft - promptWidth
  const col = screenColToBufferCol(lines[row], screenColInText)
  return { row, col }
}
