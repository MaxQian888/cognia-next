/** @jest-environment node */
import { bufferFromText, moveTo } from "./buffer"
import { composerViewport } from "./composer-viewport"

describe("composerViewport", () => {
  it("keeps the caret visible in a bounded multiline buffer", () => {
    const buffer = moveTo(bufferFromText("one\ntwo\nthree\nfour\nfive"), 3, 2)
    const view = composerViewport(buffer, 20, 3)
    expect(view.rows).toHaveLength(3)
    expect(view.rows.some((row) => row.cursorCol !== null)).toBe(true)
    expect(view.rows.map((row) => row.logicalRow)).toContain(3)
  })

  it("wraps by terminal display cells without splitting graphemes", () => {
    const view = composerViewport(moveTo(bufferFromText("A中👩‍💻B"), 0, 7), 3, 8)
    expect(view.rows.map((row) => row.text)).toEqual(["A中", "👩‍💻B"])
    const boundaries = view.rows.flatMap((row) => [row.start, row.end])
    expect(boundaries).not.toContain(3)
    expect(boundaries).not.toContain(4)
    expect(boundaries).not.toContain(5)
    expect(boundaries).not.toContain(6)
  })

  it("adds a continuation row when the end cursor follows a full-width row", () => {
    const view = composerViewport(bufferFromText("abcd"), 4, 2)
    expect(view.rows.map((row) => row.text)).toEqual(["abcd", ""])
    expect(view.rows[1].cursorCol).toBe(0)
  })

  it("never returns more than the requested rows on tiny terminals", () => {
    expect(composerViewport(bufferFromText("a\nb\nc"), 1, 1).rows).toHaveLength(1)
    expect(composerViewport(bufferFromText("a"), 0, 0).rows).toHaveLength(0)
  })
})
