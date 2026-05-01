/**
 * Tests for late interaction utilities
 */

import { embedTokens, scoreLateInteraction } from "./late-interaction"

describe("late-interaction", () => {
  it("embeds tokens with maxTokens limit", () => {
    const tokens = embedTokens("one two three four", { maxTokens: 2 })

    expect(tokens).toHaveLength(2)
  })

  it("returns high score for matching text", () => {
    const score = scoreLateInteraction("hello world", "hello world")

    expect(score).toBeCloseTo(1, 5)
  })

  it("returns zero score for empty input", () => {
    const score = scoreLateInteraction("", "content")

    expect(score).toBe(0)
  })
})
