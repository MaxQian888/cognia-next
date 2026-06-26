import { fuzzyScore, fuzzyMatch, fuzzyFilterSort, fuzzyFilterSortRanked } from "./fuzzy-match"

describe("fuzzyScore", () => {
  it("returns 0 for an empty query (neutral match)", () => {
    expect(fuzzyScore("", "anything")).toBe(0)
  })

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "model")).toBeNull()
    expect(fuzzyScore("modelx", "model")).toBeNull()
  })

  it("matches a subsequence even with gaps", () => {
    expect(fuzzyScore("mdl", "model")).not.toBeNull()
  })

  it("is case-insensitive", () => {
    expect(fuzzyScore("MOD", "model")).not.toBeNull()
  })

  it("scores an exact match highest", () => {
    const exact = fuzzyScore("model", "model")!
    const prefix = fuzzyScore("mod", "model")!
    expect(exact).toBeGreaterThan(prefix)
  })

  it("prefers a prefix match over a mid-string match", () => {
    const prefix = fuzzyScore("re", "review")!
    const mid = fuzzyScore("re", "compare")!
    expect(prefix).toBeGreaterThan(mid)
  })

  it("rewards word-boundary matches (after / - _ space)", () => {
    const boundary = fuzzyScore("gc", "git/commit")!
    const scattered = fuzzyScore("gc", "logical")!
    expect(boundary).toBeGreaterThan(scattered)
  })

  it("rewards consecutive runs over scattered matches", () => {
    const run = fuzzyScore("abc", "abcdef")!
    const scattered = fuzzyScore("abc", "axbxcx")!
    expect(run).toBeGreaterThan(scattered)
  })

  it("prefers shorter targets on ties", () => {
    const short = fuzzyScore("co", "cost")!
    const long = fuzzyScore("co", "context")!
    expect(short).toBeGreaterThan(long)
  })
})

describe("fuzzyMatch", () => {
  it("returns neutral score and no positions for an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] })
  })

  it("returns null when not a subsequence", () => {
    expect(fuzzyMatch("xyz", "model")).toBeNull()
  })

  it("reports the matched indices in order", () => {
    const m = fuzzyMatch("mdl", "model")!
    // m(0) d(2) l(4) in "model"
    expect(m.positions).toEqual([0, 2, 4])
  })

  it("reports contiguous indices for a prefix match", () => {
    const m = fuzzyMatch("mod", "model")!
    expect(m.positions).toEqual([0, 1, 2])
  })

  it("reports boundary indices across a slashed name", () => {
    const m = fuzzyMatch("gc", "git/commit")!
    // g at 0, c at 4 (right after the slash boundary)
    expect(m.positions).toEqual([0, 4])
  })

  it("agrees with fuzzyScore on the score", () => {
    expect(fuzzyMatch("co", "cost")!.score).toBe(fuzzyScore("co", "cost"))
  })
})

describe("fuzzyFilterSortRanked", () => {
  const commands = [
    { name: "clear", description: "Clear the conversation" },
    { name: "compact", description: "Compact context" },
    { name: "cost", description: "Show session cost" },
    { name: "model", description: "Pick the model" },
    { name: "review", description: "Review the diff" },
  ]

  it("returns all items with empty positions for an empty query", () => {
    const result = fuzzyFilterSortRanked(commands, "", (c) => c.name)
    expect(result.map((r) => r.item.name)).toEqual(["clear", "compact", "cost", "model", "review"])
    expect(result.every((r) => r.positions.length === 0)).toBe(true)
  })

  it("ranks like fuzzyFilterSort and carries primary positions", () => {
    const result = fuzzyFilterSortRanked(commands, "co", (c) => c.name)
    expect(result.map((r) => r.item.name)).toEqual(["cost", "compact"])
    expect(result[0].positions).toEqual([0, 1]) // c,o in "cost"
  })

  it("keeps description-only hits with NO primary positions", () => {
    const result = fuzzyFilterSortRanked(commands, "diff", (c) => c.name, {
      secondaryText: (c) => c.description,
    })
    expect(result.map((r) => r.item.name)).toEqual(["review"])
    expect(result[0].positions).toEqual([])
  })

  it("respects the limit option", () => {
    const result = fuzzyFilterSortRanked(commands, "c", (c) => c.name, { limit: 2 })
    expect(result).toHaveLength(2)
  })
})

describe("fuzzyFilterSort", () => {
  const commands = [
    { name: "clear", description: "Clear the conversation" },
    { name: "compact", description: "Compact context" },
    { name: "cost", description: "Show session cost" },
    { name: "model", description: "Pick the model" },
    { name: "review", description: "Review the diff" },
  ]

  it("returns all items in original order for an empty query", () => {
    const result = fuzzyFilterSort(commands, "", (c) => c.name)
    expect(result.map((c) => c.name)).toEqual(["clear", "compact", "cost", "model", "review"])
  })

  it("filters out non-matches and ranks the best first", () => {
    const result = fuzzyFilterSort(commands, "co", (c) => c.name)
    expect(result.map((c) => c.name)).toEqual(["cost", "compact"])
  })

  it("falls back to secondary text when primary misses, ranked below name matches", () => {
    const result = fuzzyFilterSort(commands, "diff", (c) => c.name, {
      secondaryText: (c) => c.description,
    })
    // No name contains "diff"; only /review's description does.
    expect(result.map((c) => c.name)).toEqual(["review"])
  })

  it("ranks a name match above a description-only match", () => {
    const items = [
      { name: "alpha", description: "model picker" },
      { name: "model", description: "unrelated" },
    ]
    const result = fuzzyFilterSort(items, "model", (c) => c.name, {
      secondaryText: (c) => c.description,
    })
    expect(result.map((c) => c.name)).toEqual(["model", "alpha"])
  })

  it("respects the limit option", () => {
    const result = fuzzyFilterSort(commands, "c", (c) => c.name, { limit: 2 })
    expect(result).toHaveLength(2)
  })

  it("truncates to the limit for an empty query", () => {
    const result = fuzzyFilterSort(commands, "", (c) => c.name, { limit: 3 })
    expect(result).toHaveLength(3)
  })

  it("keeps a stable order for equal scores", () => {
    const ties = [
      { name: "ab", description: "" },
      { name: "ab", description: "" },
    ]
    const result = fuzzyFilterSort(ties, "ab", (c) => c.name)
    expect(result).toHaveLength(2)
  })
})
