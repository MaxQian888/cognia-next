import {
  MULTI_CLICK_MS,
  nextGranularity,
  selectionLength,
  selectionSpans,
  selectionText,
  wordSpanAt,
  type Selection,
} from "./text-selection"

const LINES = ["hello world", "second line", "third"]

function sel(
  anchor: [number, number],
  head: [number, number],
  granularity: Selection["granularity"] = "char"
): Selection {
  return {
    anchor: { row: anchor[0], col: anchor[1] },
    head: { row: head[0], col: head[1] },
    granularity,
  }
}

describe("nextGranularity", () => {
  it("starts at char with no previous press", () => {
    expect(nextGranularity(null, 100, { row: 0, col: 0 })).toBe("char")
  })

  it("cycles char → word → line → char on repeat presses at the same cell", () => {
    const point = { row: 2, col: 4 }
    expect(nextGranularity({ at: 0, point, granularity: "char" }, 100, point)).toBe("word")
    expect(nextGranularity({ at: 0, point, granularity: "word" }, 100, point)).toBe("line")
    expect(nextGranularity({ at: 0, point, granularity: "line" }, 100, point)).toBe("char")
  })

  it("restarts at char once the multi-click window lapses", () => {
    const point = { row: 2, col: 4 }
    const at = MULTI_CLICK_MS + 1
    expect(nextGranularity({ at: 0, point, granularity: "char" }, at, point)).toBe("char")
  })

  it("restarts at char when the press lands on a different cell", () => {
    const previous = { at: 0, point: { row: 2, col: 4 }, granularity: "char" as const }
    expect(nextGranularity(previous, 100, { row: 2, col: 5 })).toBe("char")
    expect(nextGranularity(previous, 100, { row: 3, col: 4 })).toBe("char")
  })
})

describe("wordSpanAt", () => {
  it("expands to the whole word around the column", () => {
    expect(wordSpanAt("hello world", 7)).toEqual({ start: 6, end: 11 })
  })

  it("keeps a path or flag whole", () => {
    expect(wordSpanAt("see src/app.ts:12 now", 8)).toEqual({ start: 4, end: 17 })
  })

  it("selects just the cell when the column lands on whitespace", () => {
    expect(wordSpanAt("a b", 1)).toEqual({ start: 1, end: 2 })
  })

  it("selects just the cell past the end of the line", () => {
    expect(wordSpanAt("ab", 9)).toEqual({ start: 9, end: 10 })
  })

  it("works in display columns when wide glyphs precede the word", () => {
    // 中文 occupies columns 0-3, the space column 4, "abc" columns 5-7.
    expect(wordSpanAt("中文 abc", 6)).toEqual({ start: 5, end: 8 })
  })

  it("treats a run of CJK as one word (they are letters)", () => {
    expect(wordSpanAt("中文字", 2)).toEqual({ start: 0, end: 6 })
  })
})

describe("selectionSpans", () => {
  it("takes the drag range end-inclusive of the cell under the pointer", () => {
    expect(selectionSpans(sel([0, 2], [0, 4]), LINES)).toEqual([{ row: 0, startCol: 2, endCol: 5 }])
  })

  it("normalizes a backwards drag", () => {
    expect(selectionSpans(sel([0, 4], [0, 2]), LINES)).toEqual([{ row: 0, startCol: 2, endCol: 5 }])
  })

  it("runs the middle rows of a multi-row drag edge to edge", () => {
    expect(selectionSpans(sel([0, 6], [2, 2]), LINES)).toEqual([
      { row: 0, startCol: 6, endCol: 11 },
      { row: 1, startCol: 0, endCol: 11 },
      { row: 2, startCol: 0, endCol: 3 },
    ])
  })

  it("widens both ends to word boundaries in word granularity", () => {
    expect(selectionSpans(sel([0, 7], [0, 8], "word"), LINES)).toEqual([
      { row: 0, startCol: 6, endCol: 11 },
    ])
  })

  it("takes whole rows in line granularity", () => {
    expect(selectionSpans(sel([1, 4], [1, 4], "line"), LINES)).toEqual([
      { row: 1, startCol: 0, endCol: 11 },
    ])
  })

  it("clamps to the rows the frame actually has", () => {
    expect(selectionSpans(sel([1, 0], [9, 0]), LINES).map((s) => s.row)).toEqual([1, 2])
    expect(selectionSpans(sel([5, 0], [9, 0]), LINES)).toEqual([])
    expect(selectionSpans(sel([0, 0], [0, 0]), [])).toEqual([])
  })

  it("drops a blank row's empty span so it gets no phantom highlight", () => {
    const lines = ["one", "", "three"]
    expect(selectionSpans(sel([0, 0], [2, 4]), lines).map((s) => s.row)).toEqual([0, 2])
  })
})

describe("selectionText", () => {
  it("copies the sliced rows joined by newlines", () => {
    expect(selectionText(sel([0, 6], [1, 5]), LINES)).toBe("world\nsecond")
  })

  it("keeps a blank row inside the drag as a blank line", () => {
    const lines = ["one", "", "three"]
    expect(selectionText(sel([0, 0], [2, 4]), lines)).toBe("one\n\nthree")
  })

  it("trims the pad cells a short row's highlight added", () => {
    expect(selectionText(sel([2, 0], [2, 20]), LINES)).toBe("third")
  })

  it("returns empty when the drag only ever covered blank cells", () => {
    expect(selectionText(sel([0, 0], [1, 3]), ["   ", "   "])).toBe("")
  })

  it("returns empty for a selection outside the frame", () => {
    expect(selectionText(sel([9, 0], [9, 4]), LINES)).toBe("")
  })

  it("counts the copied characters", () => {
    expect(selectionLength(sel([0, 6], [0, 10]), LINES)).toBe(5)
  })
})
