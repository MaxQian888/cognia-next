import { extendsDraft, ghostSuffix, rankInlineSuggestions } from "./rank"
import type { InlineSuggestion, InlineSuggestionSource } from "./types"

function suggestion(
  text: string,
  source: InlineSuggestionSource,
  score?: number
): InlineSuggestion {
  return { text, source, providerId: `test:${source}`, score }
}

describe("extendsDraft", () => {
  it("accepts a strict extension", () => {
    expect(extendsDraft("fix the build", "fix ")).toBe(true)
  })

  it("rejects an identical text (nothing left to render as ghost)", () => {
    expect(extendsDraft("fix", "fix")).toBe(false)
  })

  it("rejects a shorter text", () => {
    expect(extendsDraft("fi", "fix")).toBe(false)
  })

  it("rejects a text that rewrites typed characters", () => {
    expect(extendsDraft("Fix the build", "fix ")).toBe(false)
  })
})

describe("ghostSuffix", () => {
  it("returns only the untyped tail", () => {
    expect(ghostSuffix("fix the build", "fix ")).toBe("the build")
  })

  it("returns empty when the text does not extend the draft", () => {
    expect(ghostSuffix("other", "fix ")).toBe("")
  })
})

describe("rankInlineSuggestions", () => {
  it("drops suggestions that do not extend the draft", () => {
    const ranked = rankInlineSuggestions(
      [suggestion("nope", "ai"), suggestion("fix the build", "ai")],
      "fix "
    )
    expect(ranked.map((s) => s.text)).toEqual(["fix the build"])
  })

  it("ranks by source priority before score", () => {
    const ranked = rankInlineSuggestions(
      [
        suggestion("fix a", "history", 1),
        suggestion("fix b", "ai", 0.1),
        suggestion("fix c", "agent", 0.1),
      ],
      "fix "
    )
    expect(ranked.map((s) => s.source)).toEqual(["agent", "ai", "history"])
  })

  it("ranks by score within one source", () => {
    const ranked = rankInlineSuggestions(
      [suggestion("fix low", "history", 0.2), suggestion("fix high", "history", 0.9)],
      "fix "
    )
    expect(ranked.map((s) => s.text)).toEqual(["fix high", "fix low"])
  })

  it("treats a missing score as the neutral default", () => {
    const ranked = rankInlineSuggestions(
      [suggestion("fix low", "history", 0.1), suggestion("fix mid", "history")],
      "fix "
    )
    expect(ranked.map((s) => s.text)).toEqual(["fix mid", "fix low"])
  })

  it("breaks full ties by input order so cycling is deterministic", () => {
    const ranked = rankInlineSuggestions(
      [suggestion("fix first", "history", 0.5), suggestion("fix second", "history", 0.5)],
      "fix "
    )
    expect(ranked.map((s) => s.text)).toEqual(["fix first", "fix second"])
  })

  it("dedupes identical results, keeping the higher-ranked origin", () => {
    const ranked = rankInlineSuggestions(
      [suggestion("fix the build", "history", 0.9), suggestion("fix the build", "ai", 0.1)],
      "fix "
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].source).toBe("ai")
  })

  it("honours the candidate limit", () => {
    const ranked = rankInlineSuggestions(
      [
        suggestion("fix a", "history"),
        suggestion("fix b", "history"),
        suggestion("fix c", "history"),
      ],
      "fix ",
      { limit: 2 }
    )
    expect(ranked.map((s) => s.text)).toEqual(["fix a", "fix b"])
  })

  it("returns an empty list when nothing matches", () => {
    expect(rankInlineSuggestions([], "fix ")).toEqual([])
  })
})
