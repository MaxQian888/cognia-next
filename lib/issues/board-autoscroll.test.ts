import {
  BOARD_EDGE_SCROLL_MAX_PX,
  BOARD_EDGE_SCROLL_ZONE_PX,
  boardEdgeScrollDelta,
  clampScrollDelta,
} from "./board-autoscroll"

const BOUNDS = { left: 100, right: 1100 } // 1000px wide, zones are 88px

describe("boardEdgeScrollDelta", () => {
  it("does nothing in the middle of the board", () => {
    expect(boardEdgeScrollDelta(600, BOUNDS)).toBe(0)
  })

  it("does nothing just inside either hot zone", () => {
    expect(boardEdgeScrollDelta(BOUNDS.left + BOARD_EDGE_SCROLL_ZONE_PX + 1, BOUNDS)).toBe(0)
    expect(boardEdgeScrollDelta(BOUNDS.right - BOARD_EDGE_SCROLL_ZONE_PX - 1, BOUNDS)).toBe(0)
  })

  it("scrolls left near the left edge and right near the right edge", () => {
    expect(boardEdgeScrollDelta(BOUNDS.left + 10, BOUNDS)).toBeLessThan(0)
    expect(boardEdgeScrollDelta(BOUNDS.right - 10, BOUNDS)).toBeGreaterThan(0)
  })

  it("ramps: deeper into the zone scrolls faster", () => {
    const shallow = boardEdgeScrollDelta(BOUNDS.right - 80, BOUNDS)
    const deep = boardEdgeScrollDelta(BOUNDS.right - 5, BOUNDS)
    expect(deep).toBeGreaterThan(shallow)
  })

  it("hits exactly the maximum at the edge", () => {
    expect(boardEdgeScrollDelta(BOUNDS.right, BOUNDS)).toBe(BOARD_EDGE_SCROLL_MAX_PX)
    expect(boardEdgeScrollDelta(BOUNDS.left, BOUNDS)).toBe(-BOARD_EDGE_SCROLL_MAX_PX)
  })

  it("clamps rather than accelerating when dragged past the board entirely", () => {
    expect(boardEdgeScrollDelta(BOUNDS.right + 5000, BOUNDS)).toBe(BOARD_EDGE_SCROLL_MAX_PX)
    expect(boardEdgeScrollDelta(BOUNDS.left - 5000, BOUNDS)).toBe(-BOARD_EDGE_SCROLL_MAX_PX)
  })

  it("halves the zones on a board too narrow to hold two of them", () => {
    const narrow = { left: 0, right: 100 } // zones would overlap at 88px each
    // The midpoint belongs to neither zone once they are halved to 50px.
    expect(boardEdgeScrollDelta(50, narrow)).toBe(0)
    expect(boardEdgeScrollDelta(10, narrow)).toBeLessThan(0)
    expect(boardEdgeScrollDelta(90, narrow)).toBeGreaterThan(0)
  })

  it("is inert for a zero-width board", () => {
    expect(boardEdgeScrollDelta(0, { left: 0, right: 0 })).toBe(0)
  })

  it("is inert for a zero-width zone", () => {
    expect(boardEdgeScrollDelta(BOUNDS.right, BOUNDS, 0)).toBe(0)
  })
})

describe("clampScrollDelta", () => {
  it("passes a delta through when there is room in both directions", () => {
    expect(clampScrollDelta(20, 200, 2000, 1000)).toBe(20)
    expect(clampScrollDelta(-20, 200, 2000, 1000)).toBe(-20)
  })

  it("stops at the left end", () => {
    expect(clampScrollDelta(-20, 5, 2000, 1000)).toBe(-5)
    expect(clampScrollDelta(-20, 0, 2000, 1000)).toBe(0)
  })

  it("stops at the right end", () => {
    expect(clampScrollDelta(20, 995, 2000, 1000)).toBe(5)
    expect(clampScrollDelta(20, 1000, 2000, 1000)).toBe(0)
  })

  it("is inert when the board does not overflow at all", () => {
    expect(clampScrollDelta(20, 0, 800, 1000)).toBe(0)
  })

  it("passes zero through", () => {
    expect(clampScrollDelta(0, 200, 2000, 1000)).toBe(0)
  })
})
