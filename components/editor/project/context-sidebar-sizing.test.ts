import { getContextSidebarSizing } from "./context-sidebar-sizing"

describe("getContextSidebarSizing", () => {
  it("reserves room for the full header instead of clipping it at the proportional default", () => {
    expect(getContextSidebarSizing(600, 252)).toEqual({ minWidth: 252, defaultWidth: 252 })
  })

  it("lets measured chrome exceed the preferred default cap when space permits", () => {
    expect(getContextSidebarSizing(1200, 344)).toEqual({ minWidth: 344, defaultWidth: 344 })
  })

  it("bounds the content floor by the sidebar's share of the workspace", () => {
    expect(getContextSidebarSizing(432, 400)).toEqual({ minWidth: 280, defaultWidth: 280 })
  })

  it.each([
    [320, 128],
    [431, 172],
    [432, 173],
    [600, 200],
    [750, 225],
    [880, 264],
    [1200, 320],
    [2400, 320],
  ])("keeps the default compact in a %ipx workspace", (width, expected) => {
    const sizing = getContextSidebarSizing(width)
    expect(sizing.defaultWidth).toBe(expected)
    expect(sizing.defaultWidth).toBeGreaterThanOrEqual(sizing.minWidth)
    expect(sizing.defaultWidth).toBeLessThanOrEqual(Math.ceil(width * 0.4))
  })

  it.each([0, -1, NaN, Infinity])("uses a bounded fallback before measurement (%s)", (width) => {
    expect(getContextSidebarSizing(width)).toEqual({ minWidth: 200, defaultWidth: 200 })
  })
})
