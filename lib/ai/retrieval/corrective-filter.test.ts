import { filterByGrade } from "./corrective-filter"

describe("filterByGrade", () => {
  it("returns [] for an empty pool", async () => {
    expect(await filterByGrade("query", [])).toEqual([])
  })

  it("drops low-relevance chunks while keeping the relevant ones", async () => {
    const chunks = [
      { id: "hit", content: "twin distill orchestrator usage details", score: 0.9 },
      { id: "hit2", content: "twin distill orchestrator pipeline steps", score: 0.8 },
      { id: "miss", content: "a completely unrelated cooking recipe for dinner", score: 0.7 },
    ]
    const out = await filterByGrade("twin distill orchestrator", chunks, { minKeep: 1 })
    const ids = out.map((c) => c.id)
    expect(ids).toContain("hit")
    expect(ids).not.toContain("miss")
  })

  it("preserves input order of the survivors", async () => {
    const chunks = [
      { id: "a", content: "alpha token relevant match here", score: 0.5 },
      { id: "b", content: "alpha token relevant match again", score: 0.6 },
    ]
    const out = await filterByGrade("alpha token relevant", chunks, { minKeep: 2 })
    expect(out.map((c) => c.id)).toEqual(["a", "b"])
  })

  it("keeps the pool untouched when nothing clears the relevance bar", async () => {
    const chunks = [
      { id: "x", content: "unrelated one", score: 0.1 },
      { id: "y", content: "unrelated two", score: 0.1 },
    ]
    const out = await filterByGrade("zzz nonmatching query terms", chunks)
    expect(out.map((c) => c.id)).toEqual(["x", "y"])
  })
})
