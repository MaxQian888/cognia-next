import { collectUnresolvedComments, hasUnresolvedNonBotComments } from "./predicates"
import type { PrReviewThreadObservation } from "./types"

function thread(over: Partial<PrReviewThreadObservation>): PrReviewThreadObservation {
  return { id: "t", path: "x", line: 1, resolved: false, isBot: false, comments: [], ...over }
}

describe("hasUnresolvedNonBotComments", () => {
  it("true for an unresolved non-bot thread with a non-bot comment", () => {
    expect(
      hasUnresolvedNonBotComments([
        thread({ comments: [{ id: "1", author: "h", body: "b", isBot: false }] }),
      ])
    ).toBe(true)
  })
  it("false for resolved, bot threads, or bot-only comments", () => {
    expect(
      hasUnresolvedNonBotComments([
        thread({ resolved: true, comments: [{ id: "1", author: "h", body: "b", isBot: false }] }),
      ])
    ).toBe(false)
    expect(
      hasUnresolvedNonBotComments([
        thread({ isBot: true, comments: [{ id: "1", author: "bot", body: "b", isBot: true }] }),
      ])
    ).toBe(false)
    expect(
      hasUnresolvedNonBotComments([
        thread({ comments: [{ id: "1", author: "bot", body: "b", isBot: true }] }),
      ])
    ).toBe(false)
  })
  it("false for an empty thread list", () => {
    expect(hasUnresolvedNonBotComments([])).toBe(false)
  })
})

describe("collectUnresolvedComments", () => {
  it("collects non-bot bodies and ids from unresolved threads", () => {
    const { bodies, ids } = collectUnresolvedComments([
      thread({
        comments: [
          { id: "1", author: "h", body: "fix a", isBot: false },
          { id: "2", author: "bot", body: "skip", isBot: true },
        ],
      }),
      thread({
        resolved: true,
        comments: [{ id: "3", author: "h", body: "ignore", isBot: false }],
      }),
      thread({ isBot: true, comments: [{ id: "4", author: "bot", body: "ignore", isBot: true }] }),
    ])
    expect(bodies).toEqual(["fix a"])
    expect(ids).toEqual(["1"])
  })
})
