import { isPointInPolygon, nodeIdsInPolygon, rectIntersectsPolygon, type Point } from "./lasso"

const triangle: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 5, y: 10 },
]

describe("isPointInPolygon", () => {
  it("returns true for an interior point", () => {
    expect(isPointInPolygon({ x: 5, y: 2 }, triangle)).toBe(true)
  })

  it("returns false for an exterior point", () => {
    expect(isPointInPolygon({ x: 50, y: 50 }, triangle)).toBe(false)
  })

  it("handles a concave shape (L)", () => {
    const L: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ]
    expect(isPointInPolygon({ x: 2, y: 8 }, L)).toBe(true)
    expect(isPointInPolygon({ x: 6, y: 8 }, L)).toBe(false)
  })

  it("returns false for fewer than 3 vertices", () => {
    expect(isPointInPolygon({ x: 0, y: 0 }, [])).toBe(false)
    expect(isPointInPolygon({ x: 0, y: 0 }, [{ x: 0, y: 0 }])).toBe(false)
    expect(
      isPointInPolygon({ x: 0, y: 0 }, [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
      ])
    ).toBe(false)
  })
})

describe("rectIntersectsPolygon", () => {
  it("returns true when the rect is fully inside the polygon", () => {
    const big: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]
    expect(rectIntersectsPolygon({ x: 10, y: 10, width: 20, height: 20 }, big)).toBe(true)
  })

  it("returns true when a single vertex of the polygon sits inside the rect", () => {
    expect(rectIntersectsPolygon({ x: 3, y: 3, width: 4, height: 4 }, triangle)).toBe(true)
  })

  it("returns false when the rect is fully outside", () => {
    expect(rectIntersectsPolygon({ x: 100, y: 100, width: 20, height: 20 }, triangle)).toBe(false)
  })

  it("handles partial overlap (corner inside polygon)", () => {
    expect(rectIntersectsPolygon({ x: 4, y: 1, width: 100, height: 1 }, triangle)).toBe(true)
  })

  it("returns false for invalid polygons", () => {
    expect(rectIntersectsPolygon({ x: 0, y: 0, width: 1, height: 1 }, [])).toBe(false)
  })
})

describe("nodeIdsInPolygon", () => {
  it("returns ids of nodes whose default-size rect overlaps the polygon", () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 100 },
      { x: 0, y: 100 },
    ]
    const nodes = [
      { id: "a", position: { x: 0, y: 0 } },
      { id: "b", position: { x: 500, y: 500 } }, // far outside
      { id: "c", position: { x: 100, y: 50 } },
    ]
    expect(nodeIdsInPolygon(nodes, polygon)).toEqual(["a", "c"])
  })

  it("honours explicit width/height per node", () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
      { x: 0, y: 50 },
    ]
    const nodes = [
      { id: "wide", position: { x: -10, y: -10 }, width: 5, height: 5 }, // outside
      { id: "tiny", position: { x: 1, y: 1 }, width: 2, height: 2 }, // inside
    ]
    expect(nodeIdsInPolygon(nodes, polygon)).toEqual(["tiny"])
  })

  it("returns [] when polygon has fewer than 3 vertices", () => {
    expect(
      nodeIdsInPolygon(
        [{ id: "a", position: { x: 0, y: 0 } }],
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ]
      )
    ).toEqual([])
  })

  it("uses custom default size when provided", () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    // With default size (240×80), this node at (50,50) is outside. With
    // a 100×100 default, its rect crosses the polygon's bottom-right corner.
    const nodes = [{ id: "x", position: { x: -50, y: -50 } }]
    expect(nodeIdsInPolygon(nodes, polygon, { defaultWidth: 100, defaultHeight: 100 })).toEqual([
      "x",
    ])
  })
})
