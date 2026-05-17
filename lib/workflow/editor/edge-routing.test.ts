import { computeSmartRoute, type RouteRect } from "./edge-routing"

const noBlockers: RouteRect[] = []

describe("computeSmartRoute — L-shaped step path", () => {
  it("emits a 6-command path with rounded corners when both deltas exceed the threshold", () => {
    const result = computeSmartRoute({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: "right",
      targetX: 400,
      targetY: 200,
      targetPosition: "left",
      nodes: noBlockers,
      excludeNodeIds: [],
    })
    // The L path always starts with "M …", contains two "Q" rounded corners
    // and a horizontal "L" segment in the middle.
    expect(result.path.startsWith("M 0 0")).toBe(true)
    expect(result.path).toContain(" Q ")
    expect((result.path.match(/ Q /g) ?? []).length).toBe(2)
    expect(result.midpoint).toEqual({ x: 200, y: 100 })
  })

  it("falls back to bezier when one of the deltas is tiny", () => {
    const result = computeSmartRoute({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: "right",
      targetX: 40, // dx < threshold
      targetY: 80,
      targetPosition: "left",
      nodes: noBlockers,
      excludeNodeIds: [],
    })
    expect(result.path).toContain(" C ")
    expect(result.path).not.toContain(" Q ")
  })

  it("produces a vertical L-shape when source/target handles are top/bottom", () => {
    const result = computeSmartRoute({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: "bottom",
      targetX: 200,
      targetY: 400,
      targetPosition: "top",
      nodes: noBlockers,
      excludeNodeIds: [],
    })
    // Vertical L has 2 Q corners and emits an L commands going first down
    // (sx=0), then sideways across the midline, then down again.
    expect((result.path.match(/ Q /g) ?? []).length).toBe(2)
    expect(result.midpoint).toEqual({ x: 100, y: 200 })
  })

  it("falls back to bezier for top/bottom handles when one delta is tiny", () => {
    const result = computeSmartRoute({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: "bottom",
      targetX: 20, // dx < threshold
      targetY: 200,
      targetPosition: "top",
      nodes: noBlockers,
      excludeNodeIds: [],
    })
    expect(result.path).toContain(" C ")
    expect(result.path).not.toContain(" Q ")
  })
})

describe("computeSmartRoute — bezier fallback", () => {
  it("produces a single cubic bezier (`C`) command", () => {
    const result = computeSmartRoute({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: "top",
      targetX: 50,
      targetY: 50,
      targetPosition: "bottom",
      nodes: noBlockers,
      excludeNodeIds: [],
    })
    expect((result.path.match(/ C /g) ?? []).length).toBe(1)
    expect(result.midpoint).toEqual({ x: 25, y: 25 })
  })

  it("offsets control points when a blocker rect contains the midpoint", () => {
    const blocker: RouteRect = { id: "block", x: 90, y: -20, width: 80, height: 80 }
    const unblocked = computeSmartRoute({
      sourceX: 0,
      sourceY: 30,
      sourcePosition: "top",
      targetX: 200,
      targetY: 30,
      targetPosition: "bottom",
      nodes: [],
      excludeNodeIds: [],
    })
    const blocked = computeSmartRoute({
      sourceX: 0,
      sourceY: 30,
      sourcePosition: "top",
      targetX: 200,
      targetY: 30,
      targetPosition: "bottom",
      nodes: [blocker],
      excludeNodeIds: [],
    })
    // With the blocker centred at y=20, midpoint at y=30 sits inside the
    // rect; the route should push the midpoint downward to clear it.
    expect(unblocked.midpoint.y).toBe(30)
    expect(blocked.midpoint.y).toBeGreaterThan(unblocked.midpoint.y)
  })

  it("skips blockers listed in excludeNodeIds", () => {
    const blocker: RouteRect = { id: "endpoint", x: 90, y: -20, width: 80, height: 80 }
    const route = computeSmartRoute({
      sourceX: 0,
      sourceY: 30,
      sourcePosition: "top",
      targetX: 200,
      targetY: 30,
      targetPosition: "bottom",
      nodes: [blocker],
      excludeNodeIds: ["endpoint"],
    })
    expect(route.midpoint.y).toBe(30)
  })
})
