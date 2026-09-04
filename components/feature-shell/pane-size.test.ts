import { centerPaneSize, paneSize } from "./pane-size"

describe("paneSize", () => {
  it("reads a number as a percentage, which is the historical contract", () => {
    expect(paneSize(14, 18)).toBe("14%")
    expect(paneSize(0, 18)).toBe("0%")
  })

  it("falls back when no size is given", () => {
    expect(paneSize(undefined, 18)).toBe("18%")
  })

  it("passes a CSS length through so a rail can be pinned", () => {
    // A percentage rail matches a fixed-width neighbour at exactly one window
    // size. This is what lets a caller express both in the same unit.
    expect(paneSize("13rem", 18)).toBe("13rem")
    expect(paneSize("208px", 18)).toBe("208px")
  })
})

describe("centerPaneSize", () => {
  const base = { hasLeft: true, hasRight: true, leftFallback: 18, rightFallback: 22 }

  it("takes the remainder of the two percentage siblings", () => {
    expect(centerPaneSize({ ...base, left: 14, right: 34 })).toBe("52%")
  })

  it("uses each sibling's fallback when it did not name a size", () => {
    expect(centerPaneSize({ ...base, left: undefined, right: undefined })).toBe("60%")
  })

  it("counts a missing pane as zero rather than as its fallback", () => {
    expect(centerPaneSize({ ...base, hasLeft: false, left: undefined, right: 34 })).toBe("66%")
    expect(centerPaneSize({ ...base, hasRight: false, left: 14, right: undefined })).toBe("86%")
  })

  it("declines to size the center when a sibling is a CSS length", () => {
    // There is no percentage to subtract, so any number would be a guess. The
    // panel library assigns the remainder itself when the size is absent.
    expect(centerPaneSize({ ...base, left: "13rem", right: 34 })).toBeUndefined()
    expect(centerPaneSize({ ...base, left: 14, right: "20rem" })).toBeUndefined()
  })

  it("ignores a CSS length belonging to a pane that is not rendered", () => {
    expect(centerPaneSize({ ...base, hasLeft: false, left: "13rem", right: 34 })).toBe("66%")
  })
})
