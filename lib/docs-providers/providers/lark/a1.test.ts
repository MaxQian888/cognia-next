import { columnLetters, sheetRange } from "./a1"

describe("columnLetters", () => {
  it("maps the first column to A", () => {
    expect(columnLetters(1)).toBe("A")
  })

  it("handles the bijective base-26 boundary that a plain modulo gets wrong", () => {
    expect(columnLetters(26)).toBe("Z")
    expect(columnLetters(27)).toBe("AA")
    expect(columnLetters(52)).toBe("AZ")
    expect(columnLetters(53)).toBe("BA")
    expect(columnLetters(702)).toBe("ZZ")
    expect(columnLetters(703)).toBe("AAA")
  })

  it("rejects non-positive and fractional indices", () => {
    expect(() => columnLetters(0)).toThrow(RangeError)
    expect(() => columnLetters(-1)).toThrow(RangeError)
    expect(() => columnLetters(1.5)).toThrow(RangeError)
  })
})

describe("sheetRange", () => {
  it("builds the sheetId-qualified A1 range", () => {
    expect(sheetRange("sht1", 500, 26)).toBe("sht1!A1:Z500")
  })

  it("clamps degenerate bounds to a single cell rather than emitting A1:A0", () => {
    expect(sheetRange("sht1", 0, 0)).toBe("sht1!A1:A1")
  })
})
