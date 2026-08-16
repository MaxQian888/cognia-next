import {
  DEFAULT_INLINE_MAX_CANDIDATES,
  DEFAULT_INLINE_SCORE,
  INLINE_SOURCE_PRIORITY,
  type InlineSuggestionSource,
} from "./types"

describe("inline completion contracts", () => {
  it("orders sources so richer origins outrank mechanical ones", () => {
    // The ranking in `rank.ts` is meaningless unless this ordering holds, and
    // silently reordering it would change which ghost the user sees.
    expect(INLINE_SOURCE_PRIORITY.plugin).toBeGreaterThan(INLINE_SOURCE_PRIORITY.agent)
    expect(INLINE_SOURCE_PRIORITY.agent).toBeGreaterThan(INLINE_SOURCE_PRIORITY.ai)
    expect(INLINE_SOURCE_PRIORITY.ai).toBeGreaterThan(INLINE_SOURCE_PRIORITY.command)
    expect(INLINE_SOURCE_PRIORITY.command).toBeGreaterThan(INLINE_SOURCE_PRIORITY.history)
  })

  it("assigns every source a distinct weight", () => {
    const sources: InlineSuggestionSource[] = ["plugin", "agent", "ai", "command", "history"]
    const weights = sources.map((s) => INLINE_SOURCE_PRIORITY[s])
    expect(new Set(weights).size).toBe(sources.length)
  })

  it("uses a neutral default score inside the confidence range", () => {
    expect(DEFAULT_INLINE_SCORE).toBeGreaterThan(0)
    expect(DEFAULT_INLINE_SCORE).toBeLessThan(1)
  })

  it("keeps the candidate cap small enough to cycle by hand", () => {
    expect(DEFAULT_INLINE_MAX_CANDIDATES).toBeGreaterThan(1)
    expect(DEFAULT_INLINE_MAX_CANDIDATES).toBeLessThanOrEqual(10)
  })
})
