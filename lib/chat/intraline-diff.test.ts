import { computeIntralineDiff, MAX_INTRALINE_LENGTH } from "./intraline-diff"

describe("computeIntralineDiff", () => {
  it("returns null for identical lines", () => {
    expect(computeIntralineDiff("same", "same")).toBeNull()
  })

  it("returns null when the combined length exceeds the cap", () => {
    const big = "x".repeat(MAX_INTRALINE_LENGTH)
    expect(computeIntralineDiff(big, big + "y")).toBeNull()
  })

  it("splits a single-word change into equal + removed/added runs", () => {
    const d = computeIntralineDiff("const a = 1", "const a = 2")
    expect(d).not.toBeNull()
    // removed side: shared prefix (equal) + the old char (removed)
    expect(d!.removed).toEqual([
      { value: "const a = ", kind: "equal" },
      { value: "1", kind: "removed" },
    ])
    expect(d!.added).toEqual([
      { value: "const a = ", kind: "equal" },
      { value: "2", kind: "added" },
    ])
  })

  it("reconstructs each side from its segments", () => {
    const oldLine = "the quick brown fox"
    const newLine = "the slow brown cat"
    const d = computeIntralineDiff(oldLine, newLine)!
    expect(d.removed.map((s) => s.value).join("")).toBe(oldLine)
    expect(d.added.map((s) => s.value).join("")).toBe(newLine)
  })

  it("marks a pure insertion with no removed runs", () => {
    const d = computeIntralineDiff("ab", "abc")!
    expect(d.removed.every((s) => s.kind === "equal")).toBe(true)
    expect(d.added.some((s) => s.kind === "added")).toBe(true)
  })

  it("marks a pure deletion with no added runs", () => {
    const d = computeIntralineDiff("abc", "ab")!
    expect(d.added.every((s) => s.kind === "equal")).toBe(true)
    expect(d.removed.some((s) => s.kind === "removed")).toBe(true)
  })
})
