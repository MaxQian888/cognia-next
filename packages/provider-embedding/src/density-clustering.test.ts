import { adaptiveEps, cosineDistance, dbscan } from "./density-clustering"

/** Unit vector at `angle` radians in 2D — cosine distance between two is 1 − cos(Δ). */
const at = (angle: number): number[] => [Math.cos(angle), Math.sin(angle)]
const gap = (delta: number) => 1 - Math.cos(delta)

describe("cosineDistance", () => {
  it("is 0 for identical and parallel vectors", () => {
    expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0, 12)
    expect(cosineDistance([1, 2, 3], [2, 4, 6])).toBeCloseTo(0, 12)
  })

  it("is 1 for orthogonal vectors and 2 for opposite ones", () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1)
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2)
  })

  it("matches 1 − cos(Δ) for 2D unit vectors", () => {
    expect(cosineDistance(at(0), at(0.5))).toBeCloseTo(gap(0.5), 12)
  })

  it.each([
    ["mismatched lengths", [1, 2], [1, 2, 3]],
    ["empty vectors", [], []],
    ["a zero vector", [0, 0], [1, 0]],
    ["two zero vectors", [0, 0], [0, 0]],
    ["NaN component", [Number.NaN, 1], [1, 1]],
    ["Infinity component", [1, 1], [Number.POSITIVE_INFINITY, 1]],
  ])("reads %s as 1 (orthogonal)", (_label, a, b) => {
    expect(cosineDistance(a, b)).toBe(1)
  })

  it("clamps floating-point error into [0, 2]", () => {
    for (let i = 1; i < 50; i++) {
      const v = [i * 0.1, i * 0.37, i * 1.3, 0.7]
      const neg = v.map((x) => -x)
      const same = cosineDistance(v, v)
      const opposite = cosineDistance(v, neg)
      expect(same).toBeGreaterThanOrEqual(0)
      expect(opposite).toBeLessThanOrEqual(2)
    }
  })
})

describe("adaptiveEps", () => {
  it("returns null when k is 0 or there are not more than k points", () => {
    expect(adaptiveEps([at(0), at(1)], 0, 0.5)).toBeNull()
    expect(adaptiveEps([at(0), at(1)], 2, 0.5)).toBeNull()
    expect(adaptiveEps([at(0)], 1, 0.5)).toBeNull()
    expect(adaptiveEps([], 1, 0.5)).toBeNull()
  })

  it("uses the last k-distance for n ≤ 2", () => {
    expect(adaptiveEps([at(0), at(0.1)], 1, 0.5)).toBeCloseTo(gap(0.1), 12)
  })

  it("clamps to maxEps", () => {
    expect(adaptiveEps([at(0), at(1)], 1, 0.01)).toBe(0.01)
    // A spread-out corpus: every knee candidate is far larger than maxEps.
    expect(adaptiveEps([at(0), at(1), at(2), at(3)], 1, 0.15)).toBe(0.15)
  })

  it("clamps a negative maxEps to 0", () => {
    expect(adaptiveEps([at(0), at(0.1), at(0.2)], 1, -1)).toBe(0)
  })

  it("picks the knee of the sorted k-distance curve", () => {
    // Four tight points (nearest-neighbour distance gap(0.01)) and one outlier.
    const points = [at(0), at(0.01), at(0.02), at(0.03), at(1.5)]
    const eps = adaptiveEps(points, 1, 0.15)
    expect(eps).not.toBeNull()
    expect(eps!).toBeCloseTo(gap(0.01), 10)
    expect(eps!).toBeLessThan(gap(1.5 - 0.03))
  })

  it("uses the k-th neighbour with self excluded", () => {
    // k = 2: each tight point's 2nd-nearest neighbour is ≤ gap(0.02) away.
    const points = [at(0), at(0.01), at(0.02), at(0.03), at(1.5)]
    const eps = adaptiveEps(points, 2, 0.15)!
    expect(eps).toBeGreaterThanOrEqual(gap(0.01) - 1e-12)
    expect(eps).toBeLessThanOrEqual(gap(0.02) + 1e-12)
  })

  it("returns 0 when every point is a duplicate", () => {
    const p = at(0.3)
    expect(adaptiveEps([p, p, p, p], 1, 0.15)).toBeCloseTo(0, 12)
  })
})

describe("dbscan", () => {
  it("groups dense points and omits noise", () => {
    const points = [at(0), at(1.5), at(0.01), at(3), at(0.02)]
    expect(dbscan(points, gap(0.015), 2)).toEqual([[0, 2, 4]])
  })

  it("finds several clusters in index order", () => {
    const points = [at(2), at(0), at(2.01), at(0.01)]
    expect(dbscan(points, gap(0.02), 2)).toEqual([
      [0, 2],
      [1, 3],
    ])
  })

  it("returns [] when everything is noise", () => {
    expect(dbscan([at(0), at(1), at(2)], gap(0.1), 2)).toEqual([])
    expect(dbscan([], 0.1, 2)).toEqual([])
  })

  it("attaches border points (previously noise) without expanding through them", () => {
    // eps admits a 0.01-rad step but not 0.02. minPts = 4.
    //  Z(-0.01): {Z, A}            → noise, never reached through a core
    //  A(0):     {Z, A, B}         → border (visited first as noise)
    //  B(0.01):  {A, B, C, C'}     → core
    //  C, C'(0.02): {B, C, C'}     → border
    const points = [at(-0.01), at(0), at(0.01), at(0.02), at(0.02)]
    expect(dbscan(points, gap(0.015), 4)).toEqual([[1, 2, 3, 4]])
  })

  it("expands through chains of core points", () => {
    const points = [0, 0.01, 0.02, 0.03, 0.04, 0.05].map(at)
    // Consecutive steps are within eps; the chain ends are far apart.
    expect(dbscan(points, gap(0.015), 2)).toEqual([[0, 1, 2, 3, 4, 5]])
  })

  it("lists each member once even when it is queued repeatedly", () => {
    const p = at(0.7)
    expect(dbscan([p, p, p, p, p], 0.01, 2)).toEqual([[0, 1, 2, 3, 4]])
  })

  it("never clusters zero or corrupt vectors (distance 1)", () => {
    expect(
      dbscan(
        [
          [0, 0],
          [0, 0],
          [Number.NaN, 1],
        ],
        0.5,
        2
      )
    ).toEqual([])
  })

  it("is deterministic", () => {
    const points = [0, 0.01, 1, 1.01, 2, 0.02].map(at)
    const first = dbscan(points, gap(0.015), 2)
    expect(dbscan(points, gap(0.015), 2)).toEqual(first)
    expect(first).toEqual([
      [0, 1, 5],
      [2, 3],
    ])
  })
})
