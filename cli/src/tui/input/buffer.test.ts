/**
 * @jest-environment node
 */
import {
  backspace,
  bufferFromText,
  bufferText,
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
  moveUp,
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
  it("onFirstLine / onLastLine", () => {
    expect(onFirstLine(buf(["a", "b"], 0, 0))).toBe(true)
    expect(onFirstLine(buf(["a", "b"], 1, 0))).toBe(false)
    expect(onLastLine(buf(["a", "b"], 1, 0))).toBe(true)
    expect(onLastLine(buf(["a", "b"], 0, 0))).toBe(false)
  })
})
