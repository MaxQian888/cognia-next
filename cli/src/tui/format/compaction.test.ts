import { formatCompactBoundary } from "./compaction"

describe("formatCompactBoundary", () => {
  it("formats a manual boundary with humanized tokens and a saved percentage", () => {
    expect(formatCompactBoundary("manual", 45_000, 8_000)).toBe(
      "⊟ Context compacted (manual): 45k → 8.0k tokens (−82%)"
    )
  })

  it("labels the auto trigger", () => {
    expect(formatCompactBoundary("auto", 200_000, 20_000)).toBe(
      "⊟ Context compacted (auto): 200k → 20k tokens (−90%)"
    )
  })

  it("omits the percentage when pre-tokens are unknown (0)", () => {
    expect(formatCompactBoundary("manual", 0, 0)).toBe("⊟ Context compacted (manual): 0 → 0 tokens")
  })

  it("omits the percentage when post exceeds pre (no meaningful saving)", () => {
    expect(formatCompactBoundary("auto", 5_000, 9_000)).toBe(
      "⊟ Context compacted (auto): 5.0k → 9.0k tokens"
    )
  })
})
