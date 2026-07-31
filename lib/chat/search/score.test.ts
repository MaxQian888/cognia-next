import {
  DEFAULT_SCORE_WEIGHTS,
  RECENCY_HALF_LIFE_DAYS,
  rankHits,
  scoreHit,
  type ScorableHit,
} from "./score"

const NOW = 1_700_000_000_000
const DAY = 86_400_000

function hit(over: Partial<ScorableHit> = {}): ScorableHit {
  return {
    messageId: over.messageId ?? "m1",
    count: over.count ?? 1,
    at: over.at ?? 0,
    createdAt: over.createdAt ?? NOW,
    role: over.role ?? "user",
    titleMatched: over.titleMatched ?? false,
  }
}

describe("scoreHit", () => {
  it("keeps every part within 0..1", () => {
    const { parts } = scoreHit(hit({ count: 500, at: 9_999, createdAt: 0 }), { now: NOW })
    for (const value of Object.values(parts)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it("scores more occurrences higher", () => {
    const one = scoreHit(hit({ count: 1 }), { now: NOW }).score
    const many = scoreHit(hit({ count: 5 }), { now: NOW }).score
    expect(many).toBeGreaterThan(one)
  })

  it("saturates the occurrence count so one message cannot run away with it", () => {
    const ten = scoreHit(hit({ count: 10 }), { now: NOW }).parts.count
    const thousand = scoreHit(hit({ count: 1_000 }), { now: NOW }).parts.count
    expect(thousand - ten).toBeLessThan(0.1)
  })

  it("scores an earlier match position higher", () => {
    const early = scoreHit(hit({ at: 0 }), { now: NOW }).score
    const late = scoreHit(hit({ at: 2_000 }), { now: NOW }).score
    expect(early).toBeGreaterThan(late)
  })

  it("scores a title match higher", () => {
    const plain = scoreHit(hit({ titleMatched: false }), { now: NOW }).score
    const titled = scoreHit(hit({ titleMatched: true }), { now: NOW }).score
    expect(titled).toBeGreaterThan(plain)
  })

  it("scores recent messages higher", () => {
    const fresh = scoreHit(hit({ createdAt: NOW }), { now: NOW }).score
    const old = scoreHit(hit({ createdAt: NOW - 365 * DAY }), { now: NOW }).score
    expect(fresh).toBeGreaterThan(old)
  })

  it("halves the recency part after one half-life", () => {
    const fresh = scoreHit(hit({ createdAt: NOW }), { now: NOW }).parts.recency
    const aged = scoreHit(hit({ createdAt: NOW - RECENCY_HALF_LIFE_DAYS * DAY }), { now: NOW })
      .parts.recency
    expect(aged).toBeCloseTo(fresh / 2, 5)
  })

  it("clamps a future timestamp rather than scoring it above fresh", () => {
    // Clock skew is real; `dateBucketFor` already clamps for the same reason.
    const skewed = scoreHit(hit({ createdAt: NOW + 10 * DAY }), { now: NOW }).parts.recency
    expect(skewed).toBe(1)
  })

  it("ranks a user message above an assistant message, all else equal", () => {
    const user = scoreHit(hit({ role: "user" }), { now: NOW }).score
    const assistant = scoreHit(hit({ role: "assistant" }), { now: NOW }).score
    expect(user).toBeGreaterThan(assistant)
  })

  it("scores a zero occurrence count as no signal", () => {
    // Reachable through the remote merge: a host row can arrive with a count
    // this client never computed.
    expect(scoreHit(hit({ count: 0 }), { now: NOW }).parts.count).toBe(0)
    expect(scoreHit(hit({ count: -1 }), { now: NOW }).parts.count).toBe(0)
  })

  it("treats an unknown role as neutral rather than throwing", () => {
    expect(() => scoreHit(hit({ role: "toolbot" }), { now: NOW })).not.toThrow()
    expect(scoreHit(hit({ role: "toolbot" }), { now: NOW }).parts.role).toBe(0)
  })

  it("honours weight overrides", () => {
    const base = scoreHit(hit({ titleMatched: true }), { now: NOW }).score
    const muted = scoreHit(hit({ titleMatched: true }), {
      now: NOW,
      weights: { ...DEFAULT_SCORE_WEIGHTS, title: 0 },
    }).score
    expect(muted).toBeLessThan(base)
  })

  // ---- the property that makes remote merging safe ----

  it("scores a hit independently of the other candidates", () => {
    // Min-max normalisation over the candidate set — which is what
    // `scoreMemories` does — would make every score a function of the whole
    // result list. Merging remote results in would then re-rank the local ones
    // that are already on screen. Absolute normalisation is what keeps the list
    // from jumping under the user's cursor.
    const solo = scoreHit(hit({ messageId: "a", count: 2 }), { now: NOW }).score
    const alongside = rankHits(
      [hit({ messageId: "a", count: 2 }), hit({ messageId: "b", count: 99, titleMatched: true })],
      { now: NOW }
    ).find((h) => h.messageId === "a")!.score
    expect(alongside).toBe(solo)
  })
})

describe("rankHits", () => {
  it("returns an empty array for no hits", () => {
    expect(rankHits([], { now: NOW })).toEqual([])
  })

  it("sorts by descending score", () => {
    const ranked = rankHits(
      [
        hit({ messageId: "weak", count: 1, createdAt: NOW - 200 * DAY }),
        hit({ messageId: "strong", count: 9, titleMatched: true, createdAt: NOW }),
      ],
      { now: NOW }
    )
    expect(ranked.map((h) => h.messageId)).toEqual(["strong", "weak"])
  })

  it("breaks ties by recency, then by id, so the order is total", () => {
    // Equal scores with no tie-breaker let a re-render swap rows visibly — the
    // same defect `byRecent` in conversation-list-model exists to prevent.
    const ranked = rankHits(
      [
        hit({ messageId: "b", createdAt: NOW - DAY }),
        hit({ messageId: "a", createdAt: NOW - DAY }),
        hit({ messageId: "c", createdAt: NOW }),
      ],
      { now: NOW }
    )
    expect(ranked.map((h) => h.messageId)).toEqual(["c", "a", "b"])
  })

  it("produces the same order however the input was ordered", () => {
    const hits = [
      hit({ messageId: "a", count: 3, createdAt: NOW - DAY }),
      hit({ messageId: "b", count: 3, createdAt: NOW - DAY }),
      hit({ messageId: "c", count: 1, createdAt: NOW }),
    ]
    const forward = rankHits(hits, { now: NOW }).map((h) => h.messageId)
    const reversed = rankHits([...hits].reverse(), { now: NOW }).map((h) => h.messageId)
    expect(reversed).toEqual(forward)
  })

  it("preserves the caller's own fields", () => {
    const ranked = rankHits([{ ...hit(), extra: "kept" }], { now: NOW })
    expect(ranked[0].extra).toBe("kept")
    expect(typeof ranked[0].score).toBe("number")
  })

  it("does not mutate the input array", () => {
    const hits = [hit({ messageId: "a" }), hit({ messageId: "b", count: 9 })]
    const snapshot = hits.map((h) => h.messageId)
    rankHits(hits, { now: NOW })
    expect(hits.map((h) => h.messageId)).toEqual(snapshot)
  })
})
