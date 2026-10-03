/**
 * VS Code text edits applied to plain text, for documents no editor holds
 * (a file `workspace.applyEdit` changes on disk, a detached document).
 *
 * Positions are VS Code's: zero-based lines and UTF-16 characters, with
 * `\r\n`, `\r` and `\n` all ending a line, and out-of-range positions
 * clamped as `TextDocument.validatePosition` does. Every edit is relative
 * to the original text; overlapping edits are refused, as VS Code refuses
 * them.
 */

export interface TextPosition {
  line: number
  character: number
}

export interface PlainTextEdit {
  range: { start: TextPosition; end: TextPosition }
  newText: string
}

/** Offsets where each line starts, and each line's length without its break. */
function lineTable(text: string): { starts: number[]; lengths: number[] } {
  const starts = [0]
  const lengths: number[] = []
  const breaks = /\r\n|\r|\n/g
  let previous = 0
  for (const match of text.matchAll(breaks)) {
    const index = match.index ?? 0
    lengths.push(index - previous)
    previous = index + match[0].length
    starts.push(previous)
  }
  lengths.push(text.length - previous)
  return { starts, lengths }
}

function offsetOf(table: { starts: number[]; lengths: number[] }, position: TextPosition): number {
  if (position.line < 0) return 0
  if (position.line >= table.starts.length) {
    const last = table.starts.length - 1
    return table.starts[last] + table.lengths[last]
  }
  const character = Math.max(0, Math.min(position.character, table.lengths[position.line]))
  return table.starts[position.line] + character
}

/**
 * `text` with `edits` applied. `eol` (VS Code's `EndOfLine`: 1 LF, 2 CRLF)
 * rewrites every line break afterwards.
 */
export function applyTextEdits(
  text: string,
  edits: readonly PlainTextEdit[],
  eol?: number
): string {
  const table = lineTable(text)
  const spans = edits
    .map((edit, order) => {
      const start = offsetOf(table, edit.range.start)
      const end = offsetOf(table, edit.range.end)
      return { start: Math.min(start, end), end: Math.max(start, end), text: edit.newText, order }
    })
    // Inserts at one offset keep the order they were given in.
    .sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order)
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index].start < spans[index - 1].end) {
      throw new Error("Overlapping ranges are not allowed!")
    }
  }
  let result = ""
  let cursor = 0
  for (const span of spans) {
    result += text.slice(cursor, span.start) + span.text
    cursor = span.end
  }
  result += text.slice(cursor)
  if (eol === 1) return result.replace(/\r\n|\r/g, "\n")
  if (eol === 2) return result.replace(/\r\n|\r|\n/g, "\r\n")
  return result
}
