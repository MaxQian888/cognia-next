import { exitMarkerColor, nextMarkerLine, prevMarkerLine } from "./command-markers"

describe("exitMarkerColor", () => {
  it("is neutral while running / unknown", () => {
    expect(exitMarkerColor(null)).toBe("#a1a1aa")
  })
  it("is emerald for exit 0", () => {
    expect(exitMarkerColor(0)).toBe("#10b981")
  })
  it("is red for any non-zero exit", () => {
    expect(exitMarkerColor(1)).toBe("#ef4444")
    expect(exitMarkerColor(127)).toBe("#ef4444")
  })
})

describe("prevMarkerLine", () => {
  it("returns the largest line strictly above the reference", () => {
    expect(prevMarkerLine([2, 10, 25, 40], 25)).toBe(10)
  })
  it("returns null when nothing is above", () => {
    expect(prevMarkerLine([30, 40], 30)).toBeNull()
    expect(prevMarkerLine([], 5)).toBeNull()
  })
  it("ignores order of the input", () => {
    expect(prevMarkerLine([40, 2, 25, 10], 26)).toBe(25)
  })
})

describe("nextMarkerLine", () => {
  it("returns the smallest line strictly below the reference", () => {
    expect(nextMarkerLine([2, 10, 25, 40], 10)).toBe(25)
  })
  it("returns null when nothing is below", () => {
    expect(nextMarkerLine([2, 10], 10)).toBeNull()
    expect(nextMarkerLine([], 5)).toBeNull()
  })
  it("ignores order of the input", () => {
    expect(nextMarkerLine([40, 2, 25, 10], 11)).toBe(25)
  })
})
