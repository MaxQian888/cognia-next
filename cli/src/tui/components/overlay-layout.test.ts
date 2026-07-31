import {
  wrappedRows,
  windowByWrappedRows,
  logPanelItemRows,
  overlayListRows,
  LOG_PANEL_EXTRA_ROWS,
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

describe("logPanelItemRows", () => {
  it("reserves the log panel's extra chrome on top of the shared budget", () => {
    expect(logPanelItemRows(30)).toBe(30 - LOG_PANEL_EXTRA_ROWS)
  })

  it("floors at OVERLAY_MIN_ROWS on a tiny terminal", () => {
    expect(logPanelItemRows(overlayListRows(5, true))).toBe(OVERLAY_MIN_ROWS)
  })

  // The same regression guard as above, extended to the log panel's taller
  // chrome: chips + filter + a SECOND footer row. If any of those go unreserved
  // the list overflows and Ink clips the highlighted row — "the cursor
  // disappears when I scroll down".
  it("keeps the WHOLE log panel within the terminal in both modes", () => {
    // Below 24 rows the OVERLAY_MIN_ROWS floor deliberately wins (cramped but
    // usable), so the exact reserve is only assertable from there up.
    for (let rows = 24; rows <= 120; rows++) {
      for (const fullscreen of [true, false]) {
        const items = logPanelItemRows(overlayListRows(rows, fullscreen))
        const widgetTotal =
          items +
          OVERLAY_CHROME_ROWS +
          LOG_PANEL_EXTRA_ROWS +
          OVERLAY_BOTTOM_ROWS +
          (fullscreen ? OVERLAY_BANNER_ROWS : 0)
        expect(widgetTotal - OVERLAY_SLACK_ROWS).toBeLessThanOrEqual(rows)
      }
    }
  })
})

describe("wrappedRows", () => {
  it("counts a short label as one row", () => {
    expect(wrappedRows("claude-sonnet-4-6", 80)).toBe(1)
  })

  it("counts the rows a long label actually wraps to", () => {
    expect(wrappedRows("x".repeat(100), 40)).toBe(3)
    expect(wrappedRows("x".repeat(80), 40)).toBe(2)
  })

  it("counts explicit newlines before wrapping is considered", () => {
    expect(wrappedRows("a\nb\nc", 80)).toBe(3)
  })

  it("never reports zero rows, even for an empty label or a zero width", () => {
    expect(wrappedRows("", 80)).toBe(1)
    expect(wrappedRows("anything", 0)).toBe(1)
  })
})

describe("windowByWrappedRows", () => {
  const short = ["a", "b", "c", "d", "e", "f"]

  it("returns an empty window for an empty list", () => {
    expect(windowByWrappedRows([], 0, 10, 80)).toEqual({
      start: 0,
      count: 0,
      above: 0,
      below: 0,
    })
  })

  it("shows the whole list when it fits", () => {
    const win = windowByWrappedRows(short, 0, 10, 80)
    expect(win).toMatchObject({ start: 0, count: 6, above: 0, below: 0 })
  })

  it("keeps the selection visible near the end of a long list", () => {
    const win = windowByWrappedRows(short, 5, 3, 80)
    expect(win.start + win.count).toBeGreaterThan(5)
    expect(win.start).toBeLessThanOrEqual(5)
    expect(win.count).toBe(3)
  })

  it("charges a wrapping item its real height, so fewer items fit", () => {
    // Same six entries, but one is three rows tall at width 20.
    const tall = ["a", "x".repeat(60), "c", "d", "e", "f"]
    const plain = windowByWrappedRows(short, 0, 4, 20).count
    const wrapped = windowByWrappedRows(tall, 0, 4, 20).count
    expect(wrapped).toBeLessThan(plain)
  })

  it("always includes the selection even when it alone exceeds the budget", () => {
    const huge = ["a", "x".repeat(400), "c"]
    const win = windowByWrappedRows(huge, 1, 2, 40)
    expect(win.start).toBe(1)
    expect(win.count).toBe(1)
    expect(win.above).toBe(1)
    expect(win.below).toBe(1)
  })

  it("reports what is hidden on each side so the scroll hints stay truthful", () => {
    const win = windowByWrappedRows(short, 3, 2, 80)
    expect(win.above + win.count + win.below).toBe(short.length)
  })

  it("clamps an out-of-range index rather than producing an empty window", () => {
    expect(windowByWrappedRows(short, 99, 3, 80).count).toBeGreaterThan(0)
    expect(windowByWrappedRows(short, -5, 3, 80).start).toBe(0)
  })

  it("survives a zero row budget by showing exactly the selection", () => {
    expect(windowByWrappedRows(short, 2, 0, 80)).toMatchObject({ start: 2, count: 1 })
  })
})
