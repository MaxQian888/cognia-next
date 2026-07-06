import { joinOutput, outputEndLine, readBufferRange } from "./command-output"
import type { BufferLineReader } from "./command-output"

/** Build a reader over a fixed array; lines outside range return null. */
function readerOf(lines: Array<string | null>): BufferLineReader {
  return (line) => (line >= 0 && line < lines.length ? lines[line] : null)
}

describe("readBufferRange", () => {
  it("collects lines in [start, end)", () => {
    const read = readerOf(["a", "b", "c", "d"])
    expect(readBufferRange(read, 1, 3)).toEqual(["b", "c"])
  })

  it("skips unreadable (null) lines rather than pushing blanks", () => {
    const read = readerOf(["a", null, "c"])
    expect(readBufferRange(read, 0, 3)).toEqual(["a", "c"])
  })

  it("clamps a negative start to 0", () => {
    const read = readerOf(["a", "b"])
    expect(readBufferRange(read, -5, 2)).toEqual(["a", "b"])
  })

  it("returns [] for inverted or non-finite ranges", () => {
    const read = readerOf(["a", "b"])
    expect(readBufferRange(read, 2, 1)).toEqual([])
    expect(readBufferRange(read, Number.NaN, 2)).toEqual([])
    expect(readBufferRange(read, 0, Number.POSITIVE_INFINITY)).toEqual([])
  })
})

describe("joinOutput", () => {
  it("joins with newlines and trims trailing blank rows", () => {
    expect(joinOutput(["one", "two", "", "  "])).toBe("one\ntwo")
  })

  it("preserves interior blank lines", () => {
    expect(joinOutput(["a", "", "b"])).toBe("a\n\nb")
  })

  it("returns empty string for all-blank input", () => {
    expect(joinOutput(["", "   ", ""])).toBe("")
    expect(joinOutput([])).toBe("")
  })
})

describe("outputEndLine", () => {
  it("returns the next command's start line", () => {
    expect(outputEndLine(10, [2, 10, 25, 40], 100)).toBe(25)
  })

  it("falls back to the cursor row for the most recent command", () => {
    expect(outputEndLine(40, [2, 10, 25, 40], 87)).toBe(87)
  })

  it("ignores start lines at or before this command", () => {
    expect(outputEndLine(25, [2, 10, 25], 60)).toBe(60)
  })
})
