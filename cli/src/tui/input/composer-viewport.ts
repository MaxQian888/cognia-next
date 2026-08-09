import { stringWidth } from "../markdown/width"
import type { InputBuffer } from "../state/types"
import { graphemeSegments } from "../text/graphemes"

export interface ComposerVisualRow {
  logicalRow: number
  start: number
  end: number
  text: string
  /** UTF-16 offset inside `text`, or null when the caret is on another row. */
  cursorCol: number | null
  continuation: boolean
}

export interface ComposerViewport {
  rows: ComposerVisualRow[]
  start: number
  totalRows: number
  cursorVisualRow: number
}

function visualRowsForLine(line: string, logicalRow: number, columns: number): ComposerVisualRow[] {
  const width = Math.max(1, Math.floor(columns))
  const rows: ComposerVisualRow[] = []
  let start = 0
  let used = 0
  let text = ""

  const push = (end: number) => {
    rows.push({
      logicalRow,
      start,
      end,
      text,
      cursorCol: null,
      continuation: rows.length > 0,
    })
    start = end
    used = 0
    text = ""
  }

  for (const grapheme of graphemeSegments(line)) {
    const graphemeWidth = Math.max(1, stringWidth(grapheme.segment))
    if (text.length > 0 && used + graphemeWidth > width) push(grapheme.index)
    text += grapheme.segment
    used += graphemeWidth
  }
  push(line.length)
  return rows
}

export function composerViewport(
  buffer: InputBuffer,
  textColumns: number,
  maxRows: number
): ComposerViewport {
  const limit = Math.max(0, Math.floor(maxRows))
  const allRows = buffer.lines.flatMap((line, logicalRow) =>
    visualRowsForLine(line, logicalRow, textColumns)
  )

  let cursorVisualRow = allRows.findIndex(
    (row) =>
      row.logicalRow === buffer.cursorRow &&
      buffer.cursorCol >= row.start &&
      (buffer.cursorCol < row.end ||
        (buffer.cursorCol === row.end && row.end === buffer.lines[buffer.cursorRow].length))
  )
  if (cursorVisualRow < 0) cursorVisualRow = Math.max(0, allRows.length - 1)

  const cursorRow = allRows[cursorVisualRow]
  if (
    cursorRow &&
    buffer.cursorCol === cursorRow.end &&
    stringWidth(cursorRow.text) >= Math.max(1, textColumns)
  ) {
    const continuation: ComposerVisualRow = {
      logicalRow: buffer.cursorRow,
      start: buffer.cursorCol,
      end: buffer.cursorCol,
      text: "",
      cursorCol: 0,
      continuation: true,
    }
    allRows.splice(cursorVisualRow + 1, 0, continuation)
    cursorRow.cursorCol = null
    cursorVisualRow += 1
  } else if (cursorRow) {
    cursorRow.cursorCol = buffer.cursorCol - cursorRow.start
  }

  if (limit === 0)
    return { rows: [], start: cursorVisualRow, totalRows: allRows.length, cursorVisualRow }
  const maxStart = Math.max(0, allRows.length - limit)
  const start = Math.min(maxStart, Math.max(0, cursorVisualRow - Math.floor((limit - 1) / 2)))
  return {
    rows: allRows.slice(start, start + limit),
    start,
    totalRows: allRows.length,
    cursorVisualRow,
  }
}
