/**
 * Pure multiline text-buffer operations for the composer. A buffer is logical
 * lines plus a (row, col) cursor; every op returns a new buffer. No terminal,
 * no React — all the editing logic the `Input` component needs lives here so it
 * is exhaustively unit-tested.
 */
import type { InputBuffer } from "../state/types"

export function emptyBuffer(): InputBuffer {
  return { lines: [""], cursorRow: 0, cursorCol: 0 }
}

export function bufferText(b: InputBuffer): string {
  return b.lines.join("\n")
}

export function bufferFromText(text: string): InputBuffer {
  const lines = text.split("\n")
  return { lines, cursorRow: lines.length - 1, cursorCol: lines[lines.length - 1].length }
}

export function isEmpty(b: InputBuffer): boolean {
  return b.lines.length === 1 && b.lines[0].length === 0
}

/** Insert text (which may contain newlines, e.g. a paste) at the cursor. */
export function insertText(b: InputBuffer, text: string): InputBuffer {
  if (text.length === 0) return b
  const line = b.lines[b.cursorRow]
  const before = line.slice(0, b.cursorCol)
  const after = line.slice(b.cursorCol)
  const segments = text.split("\n")
  if (segments.length === 1) {
    const lines = [...b.lines]
    lines[b.cursorRow] = before + text + after
    return { lines, cursorRow: b.cursorRow, cursorCol: b.cursorCol + text.length }
  }
  const first = before + segments[0]
  const middle = segments.slice(1, -1)
  const last = segments[segments.length - 1]
  const lines = [
    ...b.lines.slice(0, b.cursorRow),
    first,
    ...middle,
    last + after,
    ...b.lines.slice(b.cursorRow + 1),
  ]
  const cursorRow = b.cursorRow + segments.length - 1
  return { lines, cursorRow, cursorCol: last.length }
}

export function insertNewline(b: InputBuffer): InputBuffer {
  return insertText(b, "\n")
}

export function backspace(b: InputBuffer): InputBuffer {
  if (b.cursorCol > 0) {
    const line = b.lines[b.cursorRow]
    const lines = [...b.lines]
    lines[b.cursorRow] = line.slice(0, b.cursorCol - 1) + line.slice(b.cursorCol)
    return { lines, cursorRow: b.cursorRow, cursorCol: b.cursorCol - 1 }
  }
  if (b.cursorRow > 0) {
    // Merge with the previous line.
    const prev = b.lines[b.cursorRow - 1]
    const cur = b.lines[b.cursorRow]
    const lines = [
      ...b.lines.slice(0, b.cursorRow - 1),
      prev + cur,
      ...b.lines.slice(b.cursorRow + 1),
    ]
    return { lines, cursorRow: b.cursorRow - 1, cursorCol: prev.length }
  }
  return b
}

export function deleteWordLeft(b: InputBuffer): InputBuffer {
  if (b.cursorCol === 0) return backspace(b)
  const line = b.lines[b.cursorRow]
  const upto = line.slice(0, b.cursorCol)
  // Drop trailing spaces then the word.
  const trimmed = upto.replace(/\s+$/, "")
  const lastBreak = trimmed.search(/[^\s]+$/)
  const newCol = lastBreak < 0 ? 0 : lastBreak
  const lines = [...b.lines]
  lines[b.cursorRow] = line.slice(0, newCol) + line.slice(b.cursorCol)
  return { lines, cursorRow: b.cursorRow, cursorCol: newCol }
}

/**
 * Jump the cursor left by one word (Ctrl+←). Mirrors {@link deleteWordLeft}'s
 * word boundary: skip any trailing spaces, then land at the start of the word.
 * At column 0 it steps to the end of the previous line, like {@link moveLeft}.
 */
export function moveWordLeft(b: InputBuffer): InputBuffer {
  if (b.cursorCol === 0) {
    if (b.cursorRow > 0) {
      const row = b.cursorRow - 1
      return { ...b, cursorRow: row, cursorCol: b.lines[row].length }
    }
    return b
  }
  const upto = b.lines[b.cursorRow].slice(0, b.cursorCol)
  const trimmed = upto.replace(/\s+$/, "")
  const lastBreak = trimmed.search(/\S+$/)
  return { ...b, cursorCol: lastBreak < 0 ? 0 : lastBreak }
}

/**
 * Jump the cursor right by one word (Ctrl+→): skip leading spaces then the next
 * word. At end-of-line it steps to the start of the next line, like
 * {@link moveRight}.
 */
export function moveWordRight(b: InputBuffer): InputBuffer {
  const line = b.lines[b.cursorRow]
  if (b.cursorCol >= line.length) {
    if (b.cursorRow < b.lines.length - 1) return { ...b, cursorRow: b.cursorRow + 1, cursorCol: 0 }
    return b
  }
  const after = line.slice(b.cursorCol)
  const m = after.match(/^\s*\S+/)
  const advance = m ? m[0].length : after.length
  return { ...b, cursorCol: b.cursorCol + advance }
}

/** Kill from the cursor to the start of the line (Ctrl+U). No-op at column 0. */
export function deleteToLineStart(b: InputBuffer): InputBuffer {
  if (b.cursorCol === 0) return b
  const line = b.lines[b.cursorRow]
  const lines = [...b.lines]
  lines[b.cursorRow] = line.slice(b.cursorCol)
  return { lines, cursorRow: b.cursorRow, cursorCol: 0 }
}

/** Kill from the cursor to the end of the line (Ctrl+K). No-op at end-of-line. */
export function deleteToLineEnd(b: InputBuffer): InputBuffer {
  const line = b.lines[b.cursorRow]
  if (b.cursorCol >= line.length) return b
  const lines = [...b.lines]
  lines[b.cursorRow] = line.slice(0, b.cursorCol)
  return { lines, cursorRow: b.cursorRow, cursorCol: b.cursorCol }
}

export function moveLeft(b: InputBuffer): InputBuffer {
  if (b.cursorCol > 0) return { ...b, cursorCol: b.cursorCol - 1 }
  if (b.cursorRow > 0) {
    const row = b.cursorRow - 1
    return { ...b, cursorRow: row, cursorCol: b.lines[row].length }
  }
  return b
}

export function moveRight(b: InputBuffer): InputBuffer {
  if (b.cursorCol < b.lines[b.cursorRow].length) return { ...b, cursorCol: b.cursorCol + 1 }
  if (b.cursorRow < b.lines.length - 1) return { ...b, cursorRow: b.cursorRow + 1, cursorCol: 0 }
  return b
}

export function moveUp(b: InputBuffer): InputBuffer {
  if (b.cursorRow === 0) return { ...b, cursorCol: 0 }
  const row = b.cursorRow - 1
  return { ...b, cursorRow: row, cursorCol: Math.min(b.cursorCol, b.lines[row].length) }
}

export function moveDown(b: InputBuffer): InputBuffer {
  if (b.cursorRow === b.lines.length - 1) return { ...b, cursorCol: b.lines[b.cursorRow].length }
  const row = b.cursorRow + 1
  return { ...b, cursorRow: row, cursorCol: Math.min(b.cursorCol, b.lines[row].length) }
}

export function moveHome(b: InputBuffer): InputBuffer {
  return { ...b, cursorCol: 0 }
}

export function moveEnd(b: InputBuffer): InputBuffer {
  return { ...b, cursorCol: b.lines[b.cursorRow].length }
}

/** Whether the cursor sits on the first line (used to gate history-up). */
export function onFirstLine(b: InputBuffer): boolean {
  return b.cursorRow === 0
}

/** Whether the cursor sits on the last line (used to gate history-down). */
export function onLastLine(b: InputBuffer): boolean {
  return b.cursorRow === b.lines.length - 1
}
