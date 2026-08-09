import { windowList, windowListWithinRows } from "./list-window"

describe("windowList", () => {
  it("shows the whole list when it fits", () => {
    expect(windowList(3, 0, 8)).toEqual({ start: 0, end: 3, above: 0, below: 0 })
    expect(windowList(8, 7, 8)).toEqual({ start: 0, end: 8, above: 0, below: 0 })
  })

  it("keeps the selection centred while scrolling a long list", () => {
    // maxRows 5, half = 2.
    expect(windowList(10, 0, 5)).toEqual({ start: 0, end: 5, above: 0, below: 5 })
    expect(windowList(10, 4, 5)).toEqual({ start: 2, end: 7, above: 2, below: 3 })
  })

  it("clamps the window to the bottom so the last item stays visible", () => {
    expect(windowList(10, 9, 5)).toEqual({ start: 5, end: 10, above: 5, below: 0 })
    expect(windowList(10, 8, 5)).toEqual({ start: 5, end: 10, above: 5, below: 0 })
  })

  it("clamps an out-of-range selection into the list", () => {
    expect(windowList(10, 99, 5)).toEqual({ start: 5, end: 10, above: 5, below: 0 })
    expect(windowList(10, -3, 5)).toEqual({ start: 0, end: 5, above: 0, below: 5 })
  })

  it("never keeps the selection off-screen for any index", () => {
    const length = 40
    const maxRows = 7
    for (let sel = 0; sel < length; sel++) {
      const w = windowList(length, sel, maxRows)
      expect(sel).toBeGreaterThanOrEqual(w.start)
      expect(sel).toBeLessThan(w.end)
      expect(w.end - w.start).toBe(maxRows)
      expect(w.above).toBe(w.start)
      expect(w.below).toBe(length - w.end)
    }
  })

  it("degrades safely for empty lists and non-positive row budgets", () => {
    expect(windowList(0, 0, 8)).toEqual({ start: 0, end: 0, above: 0, below: 0 })
    expect(windowList(5, 2, 0)).toEqual({ start: 0, end: 0, above: 0, below: 5 })
    expect(windowList(5, 2, -1)).toEqual({ start: 0, end: 0, above: 0, below: 5 })
  })
})

describe("windowListWithinRows", () => {
  it("includes scroll indicators in the row budget", () => {
    const window = windowListWithinRows(20, 10, 6)
    const used = window.end - window.start + Number(window.above > 0) + Number(window.below > 0)
    expect(used).toBeLessThanOrEqual(6)
    expect(10).toBeGreaterThanOrEqual(window.start)
    expect(10).toBeLessThan(window.end)
  })

  it("uses the whole budget when the list fits", () => {
    expect(windowListWithinRows(3, 1, 6)).toEqual({ start: 0, end: 3, above: 0, below: 0 })
  })
})
