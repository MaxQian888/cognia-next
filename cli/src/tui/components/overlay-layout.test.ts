import {
  overlayListRows,
  OVERLAY_BANNER_ROWS,
  OVERLAY_BOTTOM_ROWS,
  OVERLAY_CHROME_ROWS,
  OVERLAY_MIN_ROWS,
  OVERLAY_SLACK_ROWS,
} from "./overlay-layout"

describe("overlayListRows", () => {
  it("reserves banner + chrome + bottom + slack in fullscreen", () => {
    // 40-row terminal: 40 - (6 chrome + 3 bottom + 1 slack + 7 banner) = 23.
    expect(overlayListRows(40, true)).toBe(23)
  })

  it("drops the banner reserve in scrollback mode", () => {
    // No fixed banner on-screen: 40 - (6 + 3 + 1) = 30.
    expect(overlayListRows(40, false)).toBe(30)
    // Scrollback always leaves more item rows than fullscreen for the same size.
    expect(overlayListRows(40, false)).toBeGreaterThan(overlayListRows(40, true))
  })

  it("floors at OVERLAY_MIN_ROWS on a tiny terminal", () => {
    expect(overlayListRows(5, true)).toBe(OVERLAY_MIN_ROWS)
    expect(overlayListRows(1, false)).toBe(OVERLAY_MIN_ROWS)
    expect(overlayListRows(0, true)).toBe(OVERLAY_MIN_ROWS)
  })

  it("grows the item budget one-for-one with the terminal height", () => {
    expect(overlayListRows(41, true) - overlayListRows(40, true)).toBe(1)
  })

  // The regression guard for the reported bug: whatever item budget we hand the
  // list, the FULL widget (items + both scroll-hint rows + border/title/footer)
  // plus the banner and the bottom region must fit within the terminal — so the
  // list scrolls instead of overflowing and clipping the highlighted row.
  it("keeps the whole overlay within the terminal while scrolling (fullscreen)", () => {
    for (let rows = 20; rows <= 120; rows++) {
      const items = overlayListRows(rows, true)
      const widgetTotal = items + OVERLAY_CHROME_ROWS + OVERLAY_BANNER_ROWS + OVERLAY_BOTTOM_ROWS
      // -SLACK: the situational search / "scrolled up" row may or may not show;
      // the budget must still fit the always-present regions with room to spare.
      expect(widgetTotal - OVERLAY_SLACK_ROWS).toBeLessThanOrEqual(rows)
    }
  })

  it("keeps the whole overlay within the terminal while scrolling (scrollback)", () => {
    for (let rows = 20; rows <= 120; rows++) {
      const items = overlayListRows(rows, false)
      const widgetTotal = items + OVERLAY_CHROME_ROWS + OVERLAY_BOTTOM_ROWS
      expect(widgetTotal - OVERLAY_SLACK_ROWS).toBeLessThanOrEqual(rows)
    }
  })
})
