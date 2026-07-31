import {
  PANEL_SNAP_MAGNET_PX,
  magnetAsPercent,
  snapPanelSize,
  type PanelSnapOptions,
} from "./panel-snap"

/** The chat dock's compact presets on a 1280px group, panel currently open. */
function options(overrides: Partial<PanelSnapOptions> = {}): PanelSnapOptions {
  return {
    presets: [34, 50],
    floor: 24,
    expandTo: 34,
    wasCollapsed: false,
    magnet: magnetAsPercent(1280),
    ...overrides,
  }
}

describe("magnetAsPercent", () => {
  it("turns the physical radius into a percentage of the group", () => {
    expect(magnetAsPercent(1280)).toBeCloseTo(1.875)
    expect(magnetAsPercent(2560)).toBeCloseTo(0.9375)
  })

  it("disables magnetism when the group has not measured yet", () => {
    expect(magnetAsPercent(0)).toBe(0)
    expect(magnetAsPercent(Number.NaN)).toBe(0)
    expect(magnetAsPercent(-100)).toBe(0)
  })

  it("accepts a caller-supplied radius", () => {
    expect(magnetAsPercent(1000, 50)).toBeCloseTo(5)
  })
})

describe("snapPanelSize", () => {
  describe("while open", () => {
    it("collapses below the floor", () => {
      expect(snapPanelSize(23.9, options())).toEqual({ kind: "collapsed" })
    })

    it("keeps a width that is exactly the floor", () => {
      expect(snapPanelSize(24, options())).toEqual({ kind: "size", size: 24 })
    })

    it("magnetizes to the nearest preset within the radius", () => {
      // 24px of a 1280px group is 1.875%, so 35.5% is inside 34%'s radius.
      expect(snapPanelSize(35.5, options())).toEqual({ kind: "size", size: 34 })
      expect(snapPanelSize(49, options())).toEqual({ kind: "size", size: 50 })
    })

    it("leaves a width outside every radius untouched", () => {
      expect(snapPanelSize(42, options())).toEqual({ kind: "size", size: 42 })
    })

    it("picks the closer preset when two are in range", () => {
      const wide = options({ magnet: 20 })
      expect(snapPanelSize(41, wide)).toEqual({ kind: "size", size: 34 })
      expect(snapPanelSize(43, wide)).toEqual({ kind: "size", size: 50 })
    })

    it("keeps the magnet a physical distance as the window grows", () => {
      // A 35.5% drop sits 1.5% from the 34% preset. On a 1280px group that gap
      // is 19px and snaps (asserted above); on a 2560px one it is 38px — outside
      // the 24px radius, so a wider window does not turn the preset into a well.
      expect(snapPanelSize(35.5, options({ magnet: magnetAsPercent(2560) }))).toEqual({
        kind: "size",
        size: 35.5,
      })
    })

    it("does not magnetize when the group has not measured yet", () => {
      expect(snapPanelSize(35.5, options({ magnet: 0 }))).toEqual({ kind: "size", size: 35.5 })
    })

    it("ignores a non-finite preset instead of snapping to it", () => {
      expect(snapPanelSize(42, options({ presets: [Number.NaN, 34] }))).toEqual({
        kind: "size",
        size: 42,
      })
    })
  })

  describe("while collapsed", () => {
    it("stays collapsed when the drag never clears the floor", () => {
      expect(snapPanelSize(12, options({ wasCollapsed: true }))).toEqual({ kind: "collapsed" })
    })

    it("opens to the remembered width once the drag clears the floor", () => {
      // Barely past the floor still means "put it back", not "settle at 24.1".
      expect(snapPanelSize(24.1, options({ wasCollapsed: true, expandTo: 45 }))).toEqual({
        kind: "size",
        size: 45,
      })
    })

    it("never opens below the floor even if the remembered width is stale", () => {
      expect(snapPanelSize(30, options({ wasCollapsed: true, expandTo: 5 }))).toEqual({
        kind: "size",
        size: 24,
      })
    })
  })

  describe("pixel-unit hosts", () => {
    // The project editor sizes the workbench itself, so it snaps in px with the
    // magnet passed through unconverted.
    const px = (overrides: Partial<PanelSnapOptions> = {}): PanelSnapOptions => ({
      presets: [360],
      floor: 240,
      expandTo: 360,
      wasCollapsed: false,
      magnet: PANEL_SNAP_MAGNET_PX,
      ...overrides,
    })

    it("snaps to the default width within the physical radius", () => {
      expect(snapPanelSize(372, px())).toEqual({ kind: "size", size: 360 })
    })

    it("leaves a deliberate width alone", () => {
      expect(snapPanelSize(500, px())).toEqual({ kind: "size", size: 500 })
    })

    it("collapses below the minimum width", () => {
      expect(snapPanelSize(200, px())).toEqual({ kind: "collapsed" })
    })
  })

  describe("degenerate input", () => {
    it("holds the collapsed state when the size is not a number", () => {
      expect(snapPanelSize(Number.NaN, options({ wasCollapsed: true }))).toEqual({
        kind: "collapsed",
      })
    })

    it("falls back to the remembered width when an open panel reports no size", () => {
      expect(snapPanelSize(Number.NaN, options({ expandTo: 34 }))).toEqual({
        kind: "size",
        size: 34,
      })
    })
  })

  it("exposes a magnet radius the hosts can reuse", () => {
    expect(PANEL_SNAP_MAGNET_PX).toBeGreaterThan(0)
  })
})
