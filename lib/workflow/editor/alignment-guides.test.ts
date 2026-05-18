import {
  buildAlignmentIndex,
  computeAlignmentGuides,
  type AlignmentIndex,
  type RectLike,
} from "./alignment-guides"

function rect(id: string, x: number, y: number, w = 100, h = 50): RectLike {
  return { id, x, y, width: w, height: h }
}

describe("computeAlignmentGuides", () => {
  it("returns empty when there are no peers", () => {
    const out = computeAlignmentGuides(rect("a", 0, 0), [])
    expect(out.vertical).toEqual([])
    expect(out.horizontal).toEqual([])
    expect(out.snap).toEqual({ dx: 0, dy: 0 })
  })

  it("ignores the dragged rect itself when supplied as a peer", () => {
    const r = rect("a", 0, 0)
    const out = computeAlignmentGuides(r, [r])
    expect(out.vertical).toEqual([])
    expect(out.horizontal).toEqual([])
  })

  it("emits a left-edge vertical guide and zero snap when already aligned", () => {
    const out = computeAlignmentGuides(rect("a", 100, 0), [rect("b", 100, 200)])
    // left↔left, center↔center, right↔right all align since same width.
    expect(out.vertical.find((g) => g.source === "left")?.peerId).toBe("b")
    expect(out.snap).toEqual({ dx: 0, dy: 0 })
  })

  it("snaps within tolerance and reports the delta", () => {
    // left edges off by 2px (within default tolerance=4)
    const out = computeAlignmentGuides(rect("a", 102, 0), [rect("b", 100, 200)])
    expect(out.vertical.length).toBeGreaterThan(0)
    expect(out.snap.dx).toBe(-2)
    expect(out.snap.dy).toBe(0)
  })

  it("does NOT emit a guide when every anchor pair exceeds tolerance", () => {
    // Tiny rects with no edge / center coincidences: dragged's anchors
    // (300, 305, 310) vs peer's (100, 105, 110) — all 190+ px apart.
    const out = computeAlignmentGuides(rect("a", 300, 0, 10, 10), [rect("b", 100, 0, 10, 10)], 4)
    expect(out.vertical).toEqual([])
    expect(out.snap.dx).toBe(0)
  })

  it("matches center↔center independently of edges", () => {
    // dragged is 100 wide → center=150 when x=100
    // peer is 200 wide @ x=50 → center=150
    const out = computeAlignmentGuides(rect("a", 100, 100), [rect("b", 50, 200, 200, 50)])
    const centerGuide = out.vertical.find((g) => g.source === "center")
    expect(centerGuide?.x).toBe(150)
  })

  it("emits horizontal top + middle + bottom guides", () => {
    // Same y, same height → all three horizontal anchors align
    const out = computeAlignmentGuides(rect("a", 0, 50), [rect("b", 200, 50)])
    expect(out.horizontal.find((g) => g.source === "top")).toBeDefined()
    expect(out.horizontal.find((g) => g.source === "middle")).toBeDefined()
    expect(out.horizontal.find((g) => g.source === "bottom")).toBeDefined()
  })

  it("keeps only the closest peer per source axis", () => {
    // Two peers both within tolerance for left edge — closer one wins
    const out = computeAlignmentGuides(rect("a", 100, 0), [
      rect("near", 101, 200), // 1px off
      rect("far", 103, 400), // 3px off
    ])
    const left = out.vertical.find((g) => g.source === "left")
    expect(left?.peerId).toBe("near")
    expect(out.snap.dx).toBe(1)
  })

  it("yStart / yEnd span both rects so the guide line covers the full pair", () => {
    const out = computeAlignmentGuides(rect("a", 0, 0, 100, 50), [rect("b", 0, 200, 100, 50)])
    const left = out.vertical.find((g) => g.source === "left")
    expect(left?.yStart).toBe(0)
    expect(left?.yEnd).toBe(250)
  })
})

describe("buildAlignmentIndex / computeAlignmentGuides(indexed)", () => {
  it("produces the same guides whether passed peers[] or a pre-built index", () => {
    const peers = [
      rect("a", 0, 0),
      rect("b", 100, 0, 50, 80),
      rect("c", 200, 50, 100, 60),
      rect("d", 50, 200, 80, 40),
      rect("e", 300, 300, 120, 90),
    ]
    const dragged = rect("d", 100, 100, 100, 50)
    const direct = computeAlignmentGuides(dragged, peers)
    const indexed = computeAlignmentGuides(dragged, buildAlignmentIndex(peers))
    // Sort both axes by source for stable comparison.
    const sortBySource = <T extends { source: string }>(a: T[]) =>
      [...a].sort((x, y) => x.source.localeCompare(y.source))
    expect(sortBySource(indexed.vertical)).toEqual(sortBySource(direct.vertical))
    expect(sortBySource(indexed.horizontal)).toEqual(sortBySource(direct.horizontal))
    expect(indexed.snap).toEqual(direct.snap)
  })

  it("returns empty for a far-away dragged rect (binary-search range is empty)", () => {
    const peers = [rect("p1", 0, 0), rect("p2", 100, 0)]
    const dragged = rect("d", 99999, 99999, 10, 10)
    const idx = buildAlignmentIndex(peers)
    const out = computeAlignmentGuides(dragged, idx)
    expect(out.vertical).toEqual([])
    expect(out.horizontal).toEqual([])
    expect(out.snap).toEqual({ dx: 0, dy: 0 })
  })

  it("matches an axis even when the peer is far on the other axis (alignment is by-axis, not proximity)", () => {
    // Peer's left edge is at x=100 just like dragged, but they are far apart in y.
    // Sorted-axis binary search must still find this match.
    const peers = [rect("b", 100, 100000, 50, 50)]
    const dragged = rect("a", 100, -100000, 80, 80)
    const idx = buildAlignmentIndex(peers)
    const out = computeAlignmentGuides(dragged, idx)
    expect(out.vertical.find((g) => g.source === "left")?.peerId).toBe("b")
  })

  it("skips the dragged rect when its id is present in the index", () => {
    // Place `other` far from `self` on the x axis so the only entries in
    // the binary-search range [-4..4] etc. all belong to `self` itself —
    // those must be skipped, leaving zero matches.
    const peers = [rect("self", 0, 0), rect("other", 500, 500)]
    const idx = buildAlignmentIndex(peers)
    const out = computeAlignmentGuides(rect("self", 0, 0), idx)
    expect(out.vertical).toEqual([])
    expect(out.horizontal).toEqual([])
  })

  it("builds an empty index for zero peers", () => {
    const idx: AlignmentIndex = buildAlignmentIndex([])
    expect(idx.vertical).toEqual([])
    expect(idx.horizontal).toEqual([])
    expect(computeAlignmentGuides(rect("a", 0, 0), idx)).toEqual({
      vertical: [],
      horizontal: [],
      snap: { dx: 0, dy: 0 },
    })
  })

  it("sorted index keeps 3n anchors per axis (left/center/right and top/middle/bottom)", () => {
    const peers = [rect("a", 0, 0, 10, 10), rect("b", 100, 100, 20, 20)]
    const idx = buildAlignmentIndex(peers)
    expect(idx.vertical.length).toBe(6)
    expect(idx.horizontal.length).toBe(6)
    // Vertical anchors sorted ascending: 0(a left), 5(a center), 10(a right), 100, 110, 120
    expect(idx.vertical.map((e) => e.axis)).toEqual([0, 5, 10, 100, 110, 120])
  })
})
