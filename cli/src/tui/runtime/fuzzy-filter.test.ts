import { fuzzyFilter, fuzzyScore, NO_MATCH } from "./fuzzy-filter"

describe("fuzzyScore", () => {
  it("returns 0 for an empty query (matches everything)", () => {
    expect(fuzzyScore("", "anything")).toBe(0)
    expect(fuzzyScore("   ", "anything")).toBe(0)
  })

  it("returns NO_MATCH when chars are absent or out of order", () => {
    expect(fuzzyScore("xyz", "github")).toBe(NO_MATCH)
    expect(fuzzyScore("bug", "github")).toBe(NO_MATCH) // 'b' after 'g' but no 'u' before... actually out of order
  })

  it("matches a subsequence in order", () => {
    expect(fuzzyScore("gh", "github")).toBeGreaterThan(NO_MATCH)
    expect(fuzzyScore("gth", "github")).toBeGreaterThan(NO_MATCH)
  })

  it("is case-insensitive", () => {
    expect(fuzzyScore("GH", "github")).toBe(fuzzyScore("gh", "GitHub"))
  })

  it("ranks a prefix above a scattered match", () => {
    expect(fuzzyScore("git", "github")).toBeGreaterThan(fuzzyScore("git", "legit-thing"))
  })

  it("rewards word-boundary matches", () => {
    // 'fs' hits the boundary after the dash in "file-system"
    expect(fuzzyScore("fs", "file-system")).toBeGreaterThan(fuzzyScore("fs", "filesystem"))
  })

  it("rewards consecutive runs", () => {
    expect(fuzzyScore("ello", "hello")).toBeGreaterThan(fuzzyScore("hlo", "hello"))
  })
})

describe("fuzzyFilter", () => {
  const items = [
    { name: "github" },
    { name: "filesystem" },
    { name: "brave-search" },
    { name: "git-extras" },
  ]

  it("returns all items (original order) for an empty query", () => {
    expect(fuzzyFilter(items, "", (i) => i.name)).toEqual(items)
  })

  it("drops non-matches and ranks the rest", () => {
    const out = fuzzyFilter(items, "git", (i) => i.name)
    expect(out.map((i) => i.name)).toEqual(["github", "git-extras"])
  })

  it("matches across multiple keys, taking the best", () => {
    const rows = [
      { name: "alpha", desc: "the github connector" },
      { name: "beta", desc: "unrelated" },
    ]
    const out = fuzzyFilter(rows, "github", (r) => [r.name, r.desc])
    expect(out.map((r) => r.name)).toEqual(["alpha"])
  })

  it("is stable for equal scores", () => {
    const rows = [{ name: "aa" }, { name: "ab" }, { name: "ac" }]
    const out = fuzzyFilter(rows, "a", (r) => r.name)
    // All start with 'a' (same prefix bonus, same length) → original order kept.
    expect(out.map((r) => r.name)).toEqual(["aa", "ab", "ac"])
  })
})
