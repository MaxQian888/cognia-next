import {
  EFFORT_GAUGE_PREFIX,
  EFFORT_LEVEL_DESCRIPTIONS,
  EFFORT_WIDE_MIN_WIDTH,
  effortCellToIndex,
  effortGaugeCells,
  effortGaugeWidth,
  effortKeyToIndex,
  effortLayout,
  effortPositionLabel,
  effortSliderClick,
} from "./effort-slider-view"
import { EFFORT_SLIDER_LEVELS } from "../../config/schema"

describe("effortLayout", () => {
  it("is wide at/above the threshold and compact below it", () => {
    expect(effortLayout(EFFORT_WIDE_MIN_WIDTH)).toBe("wide")
    expect(effortLayout(EFFORT_WIDE_MIN_WIDTH - 1)).toBe("compact")
    expect(effortLayout(120)).toBe("wide")
    expect(effortLayout(20)).toBe("compact")
  })

  it("defaults to wide when width is unknown", () => {
    expect(effortLayout(undefined)).toBe("wide")
    expect(effortLayout(NaN)).toBe("wide")
  })
})

describe("effortGaugeWidth", () => {
  it("scales with width but stays inside the readable band", () => {
    expect(effortGaugeWidth(10)).toBe(12) // floor clamp
    expect(effortGaugeWidth(1000)).toBe(72) // ceil clamp
    const mid = effortGaugeWidth(50)
    expect(mid).toBeGreaterThanOrEqual(12)
    expect(mid).toBeLessThanOrEqual(72)
  })

  it("falls back to a sensible default for unknown width", () => {
    expect(effortGaugeWidth(undefined)).toBe(32)
  })
})

describe("effortGaugeCells", () => {
  it("returns exactly `cells` entries with one marker", () => {
    const cells = effortGaugeCells(2, 5, 20)
    expect(cells).toHaveLength(20)
    expect(cells.filter((c) => c === "marker")).toHaveLength(1)
  })

  it("places the marker at the start for index 0 and the end for the last index", () => {
    expect(effortGaugeCells(0, 5, 10)[0]).toBe("marker")
    expect(effortGaugeCells(5, 5, 10)[9]).toBe("marker")
  })

  it("fills everything before the marker and empties everything after", () => {
    const cells = effortGaugeCells(5, 5, 10)
    expect(cells.slice(0, 9).every((c) => c === "filled")).toBe(true)
    expect(cells[9]).toBe("marker")
  })

  it("clamps an out-of-range index", () => {
    expect(effortGaugeCells(99, 5, 8)[7]).toBe("marker")
    expect(effortGaugeCells(-3, 5, 8)[0]).toBe("marker")
  })

  it("marks the whole track for a single tier (last <= 0)", () => {
    expect(effortGaugeCells(0, 0, 5)).toEqual(["marker", "marker", "marker", "marker", "marker"])
  })

  it("returns [] for a zero-width track", () => {
    expect(effortGaugeCells(0, 5, 0)).toEqual([])
  })
})

describe("effortKeyToIndex", () => {
  it("maps 1-based digits to 0-based indices within range", () => {
    expect(effortKeyToIndex("1")).toBe(0)
    expect(effortKeyToIndex(String(EFFORT_SLIDER_LEVELS.length))).toBe(
      EFFORT_SLIDER_LEVELS.length - 1
    )
  })

  it("returns null for 0, out-of-range digits, and non-digits", () => {
    expect(effortKeyToIndex("0")).toBeNull()
    expect(effortKeyToIndex("9")).toBeNull() // only 6 tiers
    expect(effortKeyToIndex("x")).toBeNull()
    expect(effortKeyToIndex("")).toBeNull()
  })
})

describe("effortPositionLabel", () => {
  it("formats a 1-based position with the tier name", () => {
    expect(effortPositionLabel(2, false)).toBe(`3/${EFFORT_SLIDER_LEVELS.length} · high`)
  })

  it("reports the off default", () => {
    expect(effortPositionLabel(2, true)).toBe("off · model default")
  })

  it("clamps an out-of-range index", () => {
    expect(effortPositionLabel(99, false)).toBe(
      `${EFFORT_SLIDER_LEVELS.length}/${EFFORT_SLIDER_LEVELS.length} · ultracode`
    )
  })
})

describe("EFFORT_LEVEL_DESCRIPTIONS", () => {
  it("has a description for every non-off tier", () => {
    for (const lvl of EFFORT_SLIDER_LEVELS) {
      expect(EFFORT_LEVEL_DESCRIPTIONS[lvl]).toBeTruthy()
    }
  })
})

describe("effortCellToIndex", () => {
  it("is the inverse of effortGaugeCells at the endpoints", () => {
    const cells = 20
    const last = 5
    expect(effortCellToIndex(0, cells, last)).toBe(0)
    expect(effortCellToIndex(cells - 1, cells, last)).toBe(last)
  })

  it("maps the midpoint cell to a middle tier", () => {
    expect(effortCellToIndex(10, 21, 6)).toBe(3)
  })

  it("clamps out-of-range cells and degenerate inputs", () => {
    expect(effortCellToIndex(-5, 20, 5)).toBe(0)
    expect(effortCellToIndex(999, 20, 5)).toBe(5)
    expect(effortCellToIndex(3, 1, 5)).toBe(0)
    expect(effortCellToIndex(3, 20, 0)).toBe(0)
  })
})

describe("effortSliderClick", () => {
  const base = { boxTop: 0, boxLeft: 0, gaugeWidth: 20, last: 5 }

  it("returns off for a click on the checkbox row (boxTop+2)", () => {
    expect(effortSliderClick({ ...base, clickRow: 2, clickCol: 5 })).toEqual({ kind: "off" })
  })

  it("returns a tier for a click on the gauge track (boxTop+3)", () => {
    // track starts at col border(1)+padding(1)+prefix(9) = 11.
    expect(effortSliderClick({ ...base, clickRow: 3, clickCol: 11 })).toEqual({
      kind: "tier",
      index: 0,
    })
    expect(effortSliderClick({ ...base, clickRow: 3, clickCol: 11 + 19 })).toEqual({
      kind: "tier",
      index: 5,
    })
  })

  it("returns null for clicks before/after the track on the gauge row", () => {
    expect(effortSliderClick({ ...base, clickRow: 3, clickCol: 10 })).toBeNull()
    expect(effortSliderClick({ ...base, clickRow: 3, clickCol: 11 + 20 })).toBeNull()
  })

  it("returns null for clicks on other rows (title / border / scale)", () => {
    expect(effortSliderClick({ ...base, clickRow: 0, clickCol: 11 })).toBeNull()
    expect(effortSliderClick({ ...base, clickRow: 1, clickCol: 11 })).toBeNull()
    expect(effortSliderClick({ ...base, clickRow: 4, clickCol: 11 })).toBeNull()
  })

  it("honours a non-zero box origin", () => {
    expect(effortSliderClick({ ...base, boxTop: 5, boxLeft: 3, clickRow: 7, clickCol: 5 })).toEqual(
      { kind: "off" }
    )
    expect(
      effortSliderClick({ ...base, boxTop: 5, boxLeft: 3, clickRow: 8, clickCol: 3 + 11 })
    ).toEqual({ kind: "tier", index: 0 })
  })

  it("exposes the gauge prefix constant", () => {
    expect(EFFORT_GAUGE_PREFIX).toBe(9)
  })
})
