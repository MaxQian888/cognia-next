import { searchHistory } from "./history-search"

const H = ["git status", "git commit -m wip", "npm test", "git push"]

describe("searchHistory", () => {
  it("returns the most-recent match when fromIndex is entries.length", () => {
    expect(searchHistory(H, "git", H.length)).toEqual({ index: 3, match: "git push" })
  })

  it("cycles to the next-older match when fromIndex is the last hit index", () => {
    expect(searchHistory(H, "git", 3)).toEqual({ index: 1, match: "git commit -m wip" })
  })

  it("continues cycling to even older matches", () => {
    expect(searchHistory(H, "git", 1)).toEqual({ index: 0, match: "git status" })
  })

  it("is case-insensitive on the query", () => {
    expect(searchHistory(H, "PUSH", H.length)).toEqual({ index: 3, match: "git push" })
  })

  it("is case-insensitive on the entries", () => {
    expect(searchHistory(["GIT PUSH"], "push", 1)).toEqual({ index: 0, match: "GIT PUSH" })
  })

  it("returns null when there is no match", () => {
    expect(searchHistory(H, "rust", H.length)).toBeNull()
  })

  it("returns null for an empty query", () => {
    expect(searchHistory(H, "", H.length)).toBeNull()
  })

  it("returns null for a whitespace-only query", () => {
    expect(searchHistory(H, "   ", H.length)).toBeNull()
  })

  it("returns null when fromIndex is 0 (nothing below to scan)", () => {
    expect(searchHistory(H, "git", 0)).toBeNull()
  })

  it("returns null for an empty history", () => {
    expect(searchHistory([], "git", 0)).toBeNull()
  })

  it("does not wrap once the oldest match is exhausted", () => {
    // index 0 is the only/last match; scanning from 0 finds nothing older.
    expect(searchHistory(H, "status", 0)).toBeNull()
  })

  it("clamps a fromIndex above entries.length to the array bounds", () => {
    expect(searchHistory(H, "git", 999)).toEqual({ index: 3, match: "git push" })
  })

  it("ignores leading/trailing whitespace around a real query", () => {
    expect(searchHistory(H, "  push  ", H.length)).toEqual({ index: 3, match: "git push" })
  })
})
