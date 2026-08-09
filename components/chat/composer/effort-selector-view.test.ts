import { EFFORT_SLIDER_LEVELS } from "@/lib/ai/thinking-level"
import {
  DEFAULT_EFFORT_SELECTOR_MODE,
  EFFORT_WIDE_MIN_PX,
  LAST_TIER_INDEX,
  effortIndexFromRatio,
  effortKeyAction,
  effortMarkerPercent,
  effortRatioFromPointer,
  effortSelectorLayout,
  effortTrackOffset,
} from "./effort-selector-view"

describe("module constants", () => {
  it("defaults to the slider presentation", () => {
    expect(DEFAULT_EFFORT_SELECTOR_MODE).toBe("slider")
  })

  it("tracks the shared tier ladder rather than a private copy", () => {
    expect(LAST_TIER_INDEX).toBe(EFFORT_SLIDER_LEVELS.length - 1)
  })
})

describe("effortSelectorLayout", () => {
  it("takes the wide branch before the first measurement", () => {
    // `useElementWidth` reports 0 until the ref attaches; the control lives in a
    // 360px popover, so wide is the right guess and avoids a compact flash.
    expect(effortSelectorLayout(0)).toBe("wide")
  })

  it("is wide at the threshold and compact just below it", () => {
    expect(effortSelectorLayout(EFFORT_WIDE_MIN_PX)).toBe("wide")
    expect(effortSelectorLayout(EFFORT_WIDE_MIN_PX - 1)).toBe("compact")
  })

  it("treats a non-finite or negative width as unmeasured", () => {
    expect(effortSelectorLayout(Number.NaN)).toBe("wide")
    expect(effortSelectorLayout(-40)).toBe("wide")
  })
})

describe("effortMarkerPercent", () => {
  it("spans 0-100% across the ladder", () => {
    expect(effortMarkerPercent(0)).toBe(0)
    expect(effortMarkerPercent(LAST_TIER_INDEX)).toBe(100)
  })

  it("places interior tiers proportionally", () => {
    expect(effortMarkerPercent(1, 5)).toBe(20)
    expect(effortMarkerPercent(3, 5)).toBe(60)
  })

  it("returns 0 for 'off', which draws no marker at all", () => {
    expect(effortMarkerPercent(-1)).toBe(0)
  })

  it("centres a single-tier ladder instead of dividing by zero", () => {
    expect(effortMarkerPercent(0, 0)).toBe(50)
  })

  it("clamps an index past the end", () => {
    expect(effortMarkerPercent(99, 5)).toBe(100)
  })
})

describe("effortTrackOffset", () => {
  it("reserves half a marker at each end so neither extreme overhangs the track", () => {
    // Without the inset a marker at tier 0 / the last tier is drawn half outside
    // the rounded track — visible at both ends of the real control.
    expect(effortTrackOffset(0, 5)).toBe("calc(0.5rem + 0 * (100% - 0.5rem * 2))")
    expect(effortTrackOffset(5, 5)).toBe("calc(0.5rem + 1 * (100% - 0.5rem * 2))")
  })

  it("places interior tiers proportionally within the inset span", () => {
    expect(effortTrackOffset(1, 5)).toBe("calc(0.5rem + 0.2 * (100% - 0.5rem * 2))")
  })

  it("parks 'off' at the fast end — the marker is not drawn there anyway", () => {
    expect(effortTrackOffset(-1, 5)).toBe("calc(0.5rem + 0 * (100% - 0.5rem * 2))")
  })
})

describe("effortRatioFromPointer", () => {
  const rect = { left: 100, width: 200 }

  it("maps a position inside the track to its ratio", () => {
    expect(effortRatioFromPointer(100, rect)).toBe(0)
    expect(effortRatioFromPointer(200, rect)).toBe(0.5)
    expect(effortRatioFromPointer(300, rect)).toBe(1)
  })

  it("clamps a drag that left the element to an end", () => {
    expect(effortRatioFromPointer(-500, rect)).toBe(0)
    expect(effortRatioFromPointer(9999, rect)).toBe(1)
  })

  it("collapses a zero-width rect (jsdom / pre-layout) to 0", () => {
    expect(effortRatioFromPointer(50, { left: 0, width: 0 })).toBe(0)
  })

  it("collapses a coordinate-less event to 0 rather than propagating NaN", () => {
    // A synthetic event with no `clientX` would otherwise produce NaN, which
    // survives every clamp and indexes the tier ladder to `undefined`.
    expect(effortRatioFromPointer(Number.NaN, rect)).toBe(0)
    expect(effortRatioFromPointer(undefined as unknown as number, rect)).toBe(0)
  })
})

describe("effortIndexFromRatio", () => {
  it("snaps to the nearest tier", () => {
    expect(effortIndexFromRatio(0, 5)).toBe(0)
    expect(effortIndexFromRatio(1, 5)).toBe(5)
    expect(effortIndexFromRatio(0.5, 5)).toBe(3) // 2.5 rounds up
    expect(effortIndexFromRatio(0.42, 5)).toBe(2)
  })

  it("clamps out-of-range ratios", () => {
    expect(effortIndexFromRatio(-3, 5)).toBe(0)
    expect(effortIndexFromRatio(7, 5)).toBe(5)
  })

  it("collapses a single-tier ladder to index 0", () => {
    expect(effortIndexFromRatio(0.9, 0)).toBe(0)
  })
})

describe("effortKeyAction", () => {
  it("steps one tier on either axis", () => {
    expect(effortKeyAction("ArrowRight", 2, 5)).toEqual({ kind: "tier", index: 3 })
    expect(effortKeyAction("ArrowUp", 2, 5)).toEqual({ kind: "tier", index: 3 })
    expect(effortKeyAction("ArrowLeft", 2, 5)).toEqual({ kind: "tier", index: 1 })
    expect(effortKeyAction("ArrowDown", 2, 5)).toEqual({ kind: "tier", index: 1 })
  })

  it("clamps at both ends instead of wrapping", () => {
    expect(effortKeyAction("ArrowLeft", 0, 5)).toEqual({ kind: "tier", index: 0 })
    expect(effortKeyAction("ArrowRight", 5, 5)).toEqual({ kind: "tier", index: 5 })
  })

  it("jumps to the ends with Home/End", () => {
    expect(effortKeyAction("Home", 3, 5)).toEqual({ kind: "tier", index: 0 })
    expect(effortKeyAction("End", 3, 5)).toEqual({ kind: "tier", index: 5 })
  })

  it("jumps to a tier by 1-based digit, matching the CLI's hint", () => {
    expect(effortKeyAction("1", 4, 5)).toEqual({ kind: "tier", index: 0 })
    expect(effortKeyAction("6", 0, 5)).toEqual({ kind: "tier", index: 5 })
  })

  it("ignores a digit past the end of the ladder", () => {
    expect(effortKeyAction("9", 0, 5)).toBeNull()
  })

  it("returns to the model default on '0'", () => {
    expect(effortKeyAction("0", 3, 5)).toEqual({ kind: "off" })
  })

  it("engages the track from 'off' rather than stepping a marker that isn't drawn", () => {
    expect(effortKeyAction("ArrowRight", -1, 5)).toEqual({ kind: "tier", index: 0 })
    expect(effortKeyAction("ArrowLeft", -1, 5)).toEqual({ kind: "tier", index: 0 })
    expect(effortKeyAction("End", -1, 5)).toEqual({ kind: "tier", index: 5 })
  })

  it("passes unrelated keys through so Tab and Escape still work", () => {
    expect(effortKeyAction("Tab", 2, 5)).toBeNull()
    expect(effortKeyAction("Escape", 2, 5)).toBeNull()
    expect(effortKeyAction("a", 2, 5)).toBeNull()
  })

  it("defaults its bound to the real ladder", () => {
    expect(effortKeyAction("End", 0)).toEqual({ kind: "tier", index: LAST_TIER_INDEX })
  })
})
