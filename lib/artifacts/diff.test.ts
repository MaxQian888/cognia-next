import { computeDiff, computeDiffStats } from "./diff"

describe("computeDiff", () => {
  it("marks identical input as all unchanged", () => {
    const diff = computeDiff("a\nb\nc", "a\nb\nc")
    expect(diff.every((l) => l.type === "unchanged")).toBe(true)
    expect(diff).toHaveLength(3)
    expect(diff[0]).toMatchObject({ content: "a", oldLineNum: 1, newLineNum: 1 })
  })

  it("detects pure additions", () => {
    const diff = computeDiff("a\nb", "a\nb\nc\nd")
    const added = diff.filter((l) => l.type === "added").map((l) => l.content)
    expect(added).toEqual(["c", "d"])
  })

  it("detects pure removals", () => {
    const diff = computeDiff("a\nb\nc", "a")
    const removed = diff.filter((l) => l.type === "removed").map((l) => l.content)
    expect(removed).toEqual(["b", "c"])
  })

  it("captures replacements as remove+add pairs with both sides represented", () => {
    const diff = computeDiff("a\nb\nc", "a\nB\nc")
    const removed = diff.find((l) => l.type === "removed")
    const added = diff.find((l) => l.type === "added")
    expect(removed?.content).toBe("b")
    expect(added?.content).toBe("B")
  })

  it("falls back to a flat add/remove list for very large inputs", () => {
    // Force m * n > 1_000_000 by feeding 1001 lines on each side.
    const big = Array.from({ length: 1001 }, (_, i) => String(i)).join("\n")
    const diff = computeDiff(big, big)
    // Fallback path emits all-removed + all-added, never "unchanged".
    expect(diff.some((l) => l.type === "unchanged")).toBe(false)
    expect(diff.filter((l) => l.type === "removed")).toHaveLength(1001)
    expect(diff.filter((l) => l.type === "added")).toHaveLength(1001)
  })
})

describe("computeDiffStats", () => {
  it("counts added and removed lines", () => {
    const diff = computeDiff("a\nb\nc", "a\nx\ny")
    const stats = computeDiffStats(diff)
    expect(stats.added).toBeGreaterThan(0)
    expect(stats.removed).toBeGreaterThan(0)
  })

  it("returns 0/0 for unchanged input", () => {
    const diff = computeDiff("a\nb", "a\nb")
    expect(computeDiffStats(diff)).toEqual({ added: 0, removed: 0 })
  })
})
