/** @jest-environment node */
import {
  cellRefText,
  collectTableFootnotes,
  fitCell,
  padCell,
  TABLE_RULE_MID,
  TABLE_RULE_TOP,
  tableFrameOverhead,
  tableLayout,
  tableRule,
} from "./table-layout"
import type { MdLine, MdSpan, TableAlign } from "./types"

type TableLine = Extract<MdLine, { kind: "table" }>

const cell = (text: string, link?: string): MdSpan[] => [{ text, ...(link ? { link } : {}) }]

const table = (header: string[], rows: string[][], align: TableAlign[] = []): TableLine => ({
  kind: "table",
  header: header.map((h) => cell(h)),
  rows: rows.map((row) => row.map((c) => cell(c))),
  align: align.length > 0 ? align : header.map(() => null),
})

/** The plain text of a cell, the way a renderer with no footnotes prints it. */
const plain = (spans: MdSpan[]) => spans.map((s) => s.text).join("")

describe("tableFrameOverhead", () => {
  it("counts one edge glyph and one pad space per side of every column", () => {
    // `│ a │ bb │` is 7 columns of frame for 2 data columns.
    expect(tableFrameOverhead(2)).toBe(7)
    expect(tableFrameOverhead(1)).toBe(4)
    expect(tableFrameOverhead(0)).toBe(0)
  })
})

describe("tableRule", () => {
  it("joins each column boundary with the rule's own glyph", () => {
    expect(tableRule([2, 3], TABLE_RULE_TOP)).toBe("╭────┬─────╮")
    expect(tableRule([2, 3], TABLE_RULE_MID)).toBe("├────┼─────┤")
  })

  it("is exactly as wide as a body row of the same columns", () => {
    const widths = [4, 6, 2]
    const body = `│${widths.map((w) => ` ${" ".repeat(w)} │`).join("")}`
    expect(tableRule(widths, TABLE_RULE_TOP).length).toBe(body.length)
  })
})

describe("padCell", () => {
  it("places the gap per the column's alignment", () => {
    expect(padCell(1, 4, null)).toEqual({ left: "", right: "   " })
    expect(padCell(1, 4, "right")).toEqual({ left: "   ", right: "" })
    expect(padCell(1, 4, "center")).toEqual({ left: " ", right: "  " })
  })

  it("never returns negative padding for a cell wider than its column", () => {
    expect(padCell(9, 4, "center")).toEqual({ left: "", right: "" })
  })
})

describe("tableLayout", () => {
  it("sizes every column to its widest cell in display columns", () => {
    // "模型" is 4 display columns even though it is 2 code units, so the column
    // has to be 5 wide to hold "Model" and 4 to hold the CJK cell.
    const { widths, capped } = tableLayout(table(["Model", "N"], [["模型", "ok"]]), plain)
    expect(widths).toEqual([5, 2])
    expect(capped).toBe(false)
  })

  it("leaves a table that fits alone", () => {
    const { widths, capped } = tableLayout(table(["a", "b"], [["cc", "d"]]), plain, 80)
    expect(widths).toEqual([2, 1])
    expect(capped).toBe(false)
  })

  it("caps columns to an even share of what the frame leaves", () => {
    const line = table(
      ["Command", "Description"],
      [["/backend", "switch the agent backend for this session"]]
    )
    const { widths, capped } = tableLayout(line, plain, 28)
    expect(capped).toBe(true)
    // 28 columns minus 7 of frame, split two ways.
    expect(widths).toEqual([8, 10])
    expect(widths.reduce((a, b) => a + b, 0) + tableFrameOverhead(2)).toBeLessThanOrEqual(28)
  })

  it("keeps a floor of three columns so nothing collapses to nothing", () => {
    const line = table(["aaaaaa", "bbbbbb", "cccccc"], [])
    const { widths } = tableLayout(line, plain, 4)
    expect(widths).toEqual([3, 3, 3])
  })
})

describe("fitCell", () => {
  it("returns the cell untouched when the column was not capped", () => {
    expect(fitCell("abc", 6, null, false)).toEqual({
      text: "abc",
      left: "",
      right: "   ",
      truncated: false,
    })
  })

  it("truncates only a cell wider than a capped column", () => {
    expect(fitCell("abcdef", 4, null, true).truncated).toBe(true)
    expect(fitCell("abcdef", 4, null, true).text).toBe("abc…")
    expect(fitCell("ab", 4, null, true).truncated).toBe(false)
  })

  it("pads from the truncated text, not the original, so the column still lines up", () => {
    const fit = fitCell("abcdefgh", 4, "right", true)
    expect(fit.left + fit.text + fit.right).toHaveLength(4)
  })
})

describe("collectTableFootnotes / cellRefText", () => {
  const line: TableLine = {
    kind: "table",
    header: [cell("Site")],
    rows: [[cell("Home", "http://x.test/p")], [cell("http://y.test", "http://y.test")]],
    align: [null],
  }

  it("footnotes only off-label URLs, and only without OSC-8", () => {
    expect(collectTableFootnotes(line, false)).toEqual(["http://x.test/p"])
    expect(collectTableFootnotes(line, true)).toEqual([])
  })

  it("writes a footnoted link as label[n] so measurement matches what prints", () => {
    const footnotes = collectTableFootnotes(line, false)
    expect(cellRefText(line.rows[0][0], footnotes)).toBe("Home[1]")
    expect(cellRefText(line.rows[1][0], footnotes)).toBe("http://y.test")
  })
})
