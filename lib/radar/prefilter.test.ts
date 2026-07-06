import { computeImportance, ngrams, jaccard, dedupeSimilar, smartPreFilter } from "./prefilter"
import type { RadarDataItem } from "@/types/radar"

function item(id: string, text: string, over: Partial<RadarDataItem> = {}): RadarDataItem {
  return { id, text, source: "memory", at: 1000, ...over }
}

describe("computeImportance", () => {
  it("uses memory importance and rewards length + captures", () => {
    expect(computeImportance(item("a", "x", { importance: 7 }))).toBe(7)
    expect(computeImportance(item("b", "y".repeat(300), { importance: 4 }))).toBe(5)
    expect(computeImportance(item("c", "z", { source: "capture" }))).toBe(4) // 3 + capture
  })
})

describe("ngrams + jaccard", () => {
  it("computes similarity of identical text as 1", () => {
    expect(jaccard(ngrams("hello world"), ngrams("hello world"))).toBe(1)
  })
  it("computes similarity of disjoint text near 0", () => {
    expect(jaccard(ngrams("aaaaaa"), ngrams("zzzzzz"))).toBeLessThan(0.1)
  })
})

describe("dedupeSimilar", () => {
  it("keeps the higher-importance item among near-duplicates", () => {
    const items = [
      item("low", "the quick brown fox jumps", { importance: 2 }),
      item("high", "the quick brown fox jumps!", { importance: 9 }),
    ]
    const out = dedupeSimilar(items)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("high")
  })

  it("keeps distinct items", () => {
    const out = dedupeSimilar([item("a", "cats are great"), item("b", "databases scale")])
    expect(out).toHaveLength(2)
  })
})

describe("smartPreFilter", () => {
  it("dedups, sorts by importance, and caps", () => {
    const items = [
      item("a", "cats and kittens", { importance: 1 }),
      item("b", "database indexing", { importance: 9 }),
      item("c", "rocket propulsion", { importance: 5 }),
    ]
    const out = smartPreFilter(items, 2)
    expect(out.map((i) => i.id)).toEqual(["b", "c"])
  })
})
