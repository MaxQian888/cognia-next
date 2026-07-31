import { personalizedPageRank, normalizeScores } from "./pagerank"

function graph(edges: [string, string[]][]): Map<string, Set<string>> {
  return new Map(edges.map(([k, v]) => [k, new Set(v)]))
}

describe("personalizedPageRank", () => {
  it("returns an empty map for an empty graph", () => {
    expect(personalizedPageRank(new Map()).size).toBe(0)
  })

  it("ranks a heavily-imported module above its importers", () => {
    // a, b, c all import core → core should score highest.
    const g = graph([
      ["a", ["core"]],
      ["b", ["core"]],
      ["c", ["core"]],
    ])
    const pr = personalizedPageRank(g)
    expect(pr.get("core")!).toBeGreaterThan(pr.get("a")!)
    expect(pr.get("core")!).toBeGreaterThan(pr.get("b")!)
    // scores sum to ~1
    const total = [...pr.values()].reduce((s, v) => s + v, 0)
    expect(total).toBeCloseTo(1, 5)
  })

  it("is deterministic across runs", () => {
    const g = graph([
      ["a", ["b", "c"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ])
    expect([...personalizedPageRank(g).entries()]).toEqual([...personalizedPageRank(g).entries()])
  })

  it("ignores self-edges and unknown targets are still ranked", () => {
    const g = graph([["a", ["a", "b"]]])
    const pr = personalizedPageRank(g)
    expect(pr.has("a")).toBe(true)
    expect(pr.has("b")).toBe(true)
    expect(pr.get("b")!).toBeGreaterThan(0)
  })

  it("honours a personalization vector", () => {
    const g = graph([
      ["a", ["b"]],
      ["b", ["a"]],
    ])
    const biased = personalizedPageRank(g, { personalization: new Map([["a", 1]]) })
    expect(biased.get("a")!).toBeGreaterThan(biased.get("b")!)
  })

  it("falls back to even teleport when personalization sums to zero", () => {
    const g = graph([
      ["a", ["b"]],
      ["b", ["a"]],
    ])
    const pr = personalizedPageRank(g, { personalization: new Map([["a", 0]]) })
    expect(pr.get("a")!).toBeCloseTo(pr.get("b")!, 5)
  })
})

describe("normalizeScores", () => {
  it("scales the max to 1", () => {
    const norm = normalizeScores(
      new Map([
        ["a", 2],
        ["b", 1],
      ])
    )
    expect(norm.get("a")).toBe(1)
    expect(norm.get("b")).toBe(0.5)
  })

  it("returns zeros for an all-zero / empty map", () => {
    expect(normalizeScores(new Map([["a", 0]])).get("a")).toBe(0)
    expect(normalizeScores(new Map()).size).toBe(0)
  })
})
