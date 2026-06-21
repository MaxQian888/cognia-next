/**
 * @jest-environment node
 */
import {
  backspace,
  bufferFromText,
  bufferText,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordLeft,
  emptyBuffer,
  insertNewline,
  insertText,
  isEmpty,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveTo,
  moveUp,
  moveWordLeft,
  moveWordRight,
  onFirstLine,
  onLastLine,
} from "./buffer"
import type { InputBuffer } from "../state/types"

const buf = (lines: string[], row: number, col: number): InputBuffer => ({
  lines,
  cursorRow: row,
  cursorCol: col,
})

describe("buffer basics", () => {
  it("empty buffer + isEmpty + text round-trip", () => {
    expect(isEmpty(emptyBuffer())).toBe(true)
    expect(bufferText(emptyBuffer())).toBe("")
    const b = bufferFromText("a\nbc")
    expect(b).toEqual({ lines: ["a", "bc"], cursorRow: 1, cursorCol: 2 })
    expect(isEmpty(b)).toBe(false)
    expect(bufferText(b)).toBe("a\nbc")
  })
})

describe("insertText", () => {
  it("inserts inline text at the cursor", () => {
    expect(insertText(buf(["ac"], 0, 1), "b")).toEqual({
      lines: ["abc"],
      cursorRow: 0,
      cursorCol: 2,
    })
  })
  it("no-ops on empty insert", () => {
    const b = buf(["x"], 0, 1)
    expect(insertText(b, "")).toBe(b)
  })
  it("splits across newlines (paste)", () => {
    expect(insertText(buf(["ad"], 0, 1), "b\nc")).toEqual({
      lines: ["ab", "cd"],
      cursorRow: 1,
      cursorCol: 1,
    })
  })
  it("inserts multi-line with middle lines", () => {
    expect(insertText(buf(["XY"], 0, 1), "1\n2\n3")).toEqual({
      lines: ["X1", "2", "3Y"],
      cursorRow: 2,
      cursorCol: 1,
    })
  })
  it("insertNewline splits the line", () => {
    expect(insertNewline(buf(["ab"], 0, 1))).toEqual({
      lines: ["a", "b"],
      cursorRow: 1,
      cursorCol: 0,
    })
  })
})

describe("backspace", () => {
  it("removes a character within a line", () => {
    expect(backspace(buf(["abc"], 0, 2))).toEqual({ lines: ["ac"], cursorRow: 0, cursorCol: 1 })
  })
  it("merges with the previous line at column 0", () => {
    expect(backspace(buf(["ab", "cd"], 1, 0))).toEqual({
      lines: ["abcd"],
      cursorRow: 0,
      cursorCol: 2,
    })
  })
  it("no-ops at the very start", () => {
    const b = buf([""], 0, 0)
    expect(backspace(b)).toBe(b)
  })
})

describe("deleteWordLeft", () => {
  it("deletes the word before the cursor", () => {
    expect(deleteWordLeft(buf(["foo bar"], 0, 7))).toEqual({
      lines: ["foo "],
      cursorRow: 0,
      cursorCol: 4,
    })
  })
  it("deletes trailing spaces and the word", () => {
    expect(deleteWordLeft(buf(["foo   "], 0, 6))).toEqual({
      lines: [""],
      cursorRow: 0,
      cursorCol: 0,
    })
  })
  it("falls back to backspace at column 0", () => {
    expect(deleteWordLeft(buf(["ab", "cd"], 1, 0))).toEqual({
      lines: ["abcd"],
      cursorRow: 0,
      cursorCol: 2,
    })
  })
})

describe("cursor movement", () => {
  it("moveLeft within and across lines", () => {
    expect(moveLeft(buf(["ab"], 0, 1)).cursorCol).toBe(0)
    expect(moveLeft(buf(["ab", "cd"], 1, 0))).toEqual({
      lines: ["ab", "cd"],
      cursorRow: 0,
      cursorCol: 2,
    })
    const start = buf(["ab"], 0, 0)
    expect(moveLeft(start)).toBe(start)
  })
  it("moveRight within and across lines", () => {
    expect(moveRight(buf(["ab"], 0, 1)).cursorCol).toBe(2)
    expect(moveRight(buf(["ab", "cd"], 0, 2))).toEqual({
      lines: ["ab", "cd"],
      cursorRow: 1,
      cursorCol: 0,
    })
    const end = buf(["ab"], 0, 2)
    expect(moveRight(end)).toBe(end)
  })
  it("moveUp / moveDown clamp the column", () => {
    expect(moveUp(buf(["ab", "cdef"], 1, 4))).toEqual({
      lines: ["ab", "cdef"],
      cursorRow: 0,
      cursorCol: 2,
    })
    expect(moveUp(buf(["abc"], 0, 2))).toEqual({ lines: ["abc"], cursorRow: 0, cursorCol: 0 })
    expect(moveDown(buf(["abcd", "ef"], 0, 4))).toEqual({
      lines: ["abcd", "ef"],
      cursorRow: 1,
      cursorCol: 2,
    })
    expect(moveDown(buf(["abc"], 0, 1))).toEqual({ lines: ["abc"], cursorRow: 0, cursorCol: 3 })
  })
  it("moveHome / moveEnd", () => {
    expect(moveHome(buf(["abc"], 0, 2)).cursorCol).toBe(0)
    expect(moveEnd(buf(["abc"], 0, 0)).cursorCol).toBe(3)
  })
  it("moveTo places the cursor and clamps out-of-range row/col", () => {
    expect(moveTo(buf(["abc", "de"], 0, 0), 1, 1)).toEqual({
      lines: ["abc", "de"],
      cursorRow: 1,
      cursorCol: 1,
    })
    // Row past the end clamps to the last line; col past the end clamps to its length.
    expect(moveTo(buf(["abc", "de"], 0, 0), 9, 9)).toMatchObject({ cursorRow: 1, cursorCol: 2 })
    // Negatives clamp to the origin.
    expect(moveTo(buf(["abc"], 0, 2), -1, -1)).toMatchObject({ cursorRow: 0, cursorCol: 0 })
  })
  it("onFirstLine / onLastLine", () => {
    expect(onFirstLine(buf(["a", "b"], 0, 0))).toBe(true)
    expect(onFirstLine(buf(["a", "b"], 1, 0))).toBe(false)
    expect(onLastLine(buf(["a", "b"], 1, 0))).toBe(true)
    expect(onLastLine(buf(["a", "b"], 0, 0))).toBe(false)
  })
})

describe("word movement", () => {
  it("moveWordLeft jumps to the start of the previous word", () => {
    expect(moveWordLeft(buf(["foo bar"], 0, 7)).cursorCol).toBe(4)
    expect(moveWordLeft(buf(["foo bar"], 0, 4)).cursorCol).toBe(0)
  })
  it("moveWordLeft skips trailing spaces", () => {
    expect(moveWordLeft(buf(["foo   "], 0, 6)).cursorCol).toBe(0)
  })
  it("moveWordLeft steps to the end of the previous line at column 0", () => {
    expect(moveWordLeft(buf(["ab", "cd"], 1, 0))).toEqual({
      lines: ["ab", "cd"],
      cursorRow: 0,
      cursorCol: 2,
    })
    const start = buf(["ab"], 0, 0)
    expect(moveWordLeft(start)).toBe(start)
  })
  it("moveWordRight skips leading spaces then the word", () => {
    expect(moveWordRight(buf(["foo bar"], 0, 0)).cursorCol).toBe(3)
    expect(moveWordRight(buf(["foo bar"], 0, 3)).cursorCol).toBe(7)
  })
  it("moveWordRight steps to the start of the next line at end-of-line", () => {
    expect(moveWordRight(buf(["ab", "cd"], 0, 2))).toEqual({
      lines: ["ab", "cd"],
      cursorRow: 1,
      cursorCol: 0,
    })
    const end = buf(["ab"], 0, 2)
    expect(moveWordRight(end)).toBe(end)
  })
})

describe("line kills", () => {
  it("deleteToLineStart kills from the cursor to the line start", () => {
    expect(deleteToLineStart(buf(["foo bar"], 0, 4))).toEqual({
      lines: ["bar"],
      cursorRow: 0,
      cursorCol: 0,
    })
  })
  it("deleteToLineStart no-ops at column 0", () => {
    const b = buf(["foo"], 0, 0)
    expect(deleteToLineStart(b)).toBe(b)
  })
  it("deleteToLineEnd kills from the cursor to the line end", () => {
    expect(deleteToLineEnd(buf(["foo bar"], 0, 3))).toEqual({
      lines: ["foo"],
      cursorRow: 0,
      cursorCol: 3,
    })
  })
  it("deleteToLineEnd no-ops at end-of-line", () => {
    const b = buf(["foo"], 0, 3)
    expect(deleteToLineEnd(b)).toBe(b)
  })
})
