import {
  wrappedRows,
  windowByWrappedRows,
  logPanelItemRows,
  LOG_PANEL_EXTRA_ROWS,
  OVERLAY_MIN_ROWS,
} from "./overlay-layout"

describe("logPanelItemRows", () => {
  it("reserves the log panel's extra chrome on top of the shared budget", () => {
    expect(logPanelItemRows(30)).toBe(30 - LOG_PANEL_EXTRA_ROWS)
  })

  it("floors at OVERLAY_MIN_ROWS on a tiny terminal", () => {
    expect(logPanelItemRows(1)).toBe(OVERLAY_MIN_ROWS)
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

  it("uses terminal display width for CJK, emoji, and combining marks", () => {
    expect(wrappedRows("中中中", 4)).toBe(2)
    expect(wrappedRows("👩‍💻👩‍💻", 2)).toBe(2)
    expect(wrappedRows("e\u0301e\u0301", 2)).toBe(1)
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
