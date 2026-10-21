import { formatDateTime, lineRange, percent } from "./format"

describe("format", () => {
  it("formats rates, dates and line ranges", () => {
    expect(percent(undefined)).toBe("—")
    expect(percent(0.256)).toBe("26%")
    expect(formatDateTime("en", Date.UTC(2026, 0, 2, 3, 4))).toMatch(/2026/)
    expect(formatDateTime("not a locale!!", 0)).toMatch(/19(69|70)/)
    expect(lineRange(undefined, 3)).toBe("")
    expect(lineRange(2, 2)).toBe("2")
    expect(lineRange(2, 5)).toBe("2–5")
  })
})
