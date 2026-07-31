import { DISCOVER_VIEW_CONTAINER, discoverViewContainer } from "./view-classes"

describe("discover view-classes", () => {
  it("maps each mode to a distinct container class", () => {
    expect(DISCOVER_VIEW_CONTAINER.grid).toContain("grid-cols")
    expect(DISCOVER_VIEW_CONTAINER.list).toBe("flex flex-col gap-2")
    expect(DISCOVER_VIEW_CONTAINER.compact).toBe("flex flex-col gap-1")
  })

  it("uses container-query column variants (not viewport) so panes reflow by their own width", () => {
    expect(DISCOVER_VIEW_CONTAINER.grid).toMatch(/@\w+\/discover-grid:grid-cols/)
    // Guard against a regression back to viewport breakpoints inside a pane.
    expect(DISCOVER_VIEW_CONTAINER.grid).not.toMatch(/\bsm:grid-cols/)
    expect(DISCOVER_VIEW_CONTAINER.grid).not.toMatch(/\blg:grid-cols/)
    expect(DISCOVER_VIEW_CONTAINER.grid).not.toMatch(/\bxl:grid-cols/)
  })

  it("contains no padding so call sites control their own", () => {
    for (const cls of Object.values(DISCOVER_VIEW_CONTAINER)) {
      expect(cls).not.toMatch(/\bp-\d/)
    }
  })

  it("resolves a mode and defaults to grid for an unknown value", () => {
    expect(discoverViewContainer("list")).toBe(DISCOVER_VIEW_CONTAINER.list)
    expect(discoverViewContainer("nope" as never)).toBe(DISCOVER_VIEW_CONTAINER.grid)
  })
})
