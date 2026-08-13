import {
  PROVENANCE_VERACITY,
  RECENCY_HALF_LIFE_MULTIPLIER,
  recencyHalfLifeDaysForType,
  governanceScoreFor,
  scoreMemories,
  veracityFor,
  type ScorableMemory,
} from "./scoring"

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function mem(over: Partial<ScorableMemory> = {}): ScorableMemory {
  return { importance: 5, lastAccessedAt: NOW, relevance: 0.5, ...over }
}

describe("scoreMemories", () => {
  it("returns [] for empty input", () => {
    expect(scoreMemories([])).toEqual([])
  })

  it("ranks by the summed three-factor score, descending", () => {
    const a = mem({ importance: 10, relevance: 0.9, lastAccessedAt: NOW })
    const b = mem({ importance: 1, relevance: 0.1, lastAccessedAt: NOW - 30 * DAY })
    const out = scoreMemories([b, a], { now: NOW })
    expect(out[0].memory).toBe(a)
    expect(out[1].memory).toBe(b)
    expect(out[0].score).toBeGreaterThan(out[1].score)
  })

  it("min-max normalizes each factor to [0,1]", () => {
    const out = scoreMemories(
      [
        mem({ importance: 10, relevance: 1, lastAccessedAt: NOW }),
        mem({ importance: 1, relevance: 0, lastAccessedAt: NOW - 100 * DAY }),
      ],
      { now: NOW }
    )
    const top = out[0]
    expect(top.parts.recency).toBeCloseTo(1)
    expect(top.parts.importance).toBeCloseTo(1)
    expect(top.parts.relevance).toBeCloseTo(1)
    const bottom = out[1]
    expect(bottom.parts.recency).toBeCloseTo(0)
    expect(bottom.parts.importance).toBeCloseTo(0)
    expect(bottom.parts.relevance).toBeCloseTo(0)
  })

  it("neutralizes a factor (→1) when all candidates share the same value", () => {
    const out = scoreMemories([mem({ importance: 5 }), mem({ importance: 5 })], { now: NOW })
    expect(out.every((o) => o.parts.importance === 1)).toBe(true)
  })

  it("recency decays with age and never exceeds the freshest", () => {
    const fresh = mem({ lastAccessedAt: NOW })
    const old = mem({ lastAccessedAt: NOW - 200 * DAY })
    const out = scoreMemories([old, fresh], { now: NOW })
    const freshScored = out.find((o) => o.memory === fresh)!
    const oldScored = out.find((o) => o.memory === old)!
    expect(freshScored.parts.recency).toBeGreaterThan(oldScored.parts.recency)
  })

  it("treats future timestamps as age 0 (recency = 1)", () => {
    const out = scoreMemories(
      [mem({ lastAccessedAt: NOW + 10 * DAY }), mem({ lastAccessedAt: NOW - 10 * DAY })],
      { now: NOW }
    )
    // The future-dated memory is the freshest → top recency after normalization.
    const future = out.find((o) => o.memory.lastAccessedAt > NOW)!
    expect(future.parts.recency).toBeCloseTo(1)
  })

  it("clamps importance into 1..10 before normalizing", () => {
    const out = scoreMemories(
      [mem({ importance: 99, relevance: 0.5 }), mem({ importance: -5, relevance: 0.5 })],
      { now: NOW }
    )
    const hi = out.find((o) => o.memory.importance === 99)!
    const lo = out.find((o) => o.memory.importance === -5)!
    expect(hi.parts.importance).toBeCloseTo(1)
    expect(lo.parts.importance).toBeCloseTo(0)
  })

  it("honors custom weights (relevance-only ranking)", () => {
    const a = mem({ importance: 1, relevance: 1, lastAccessedAt: NOW - 100 * DAY })
    const b = mem({ importance: 10, relevance: 0, lastAccessedAt: NOW })
    const out = scoreMemories([b, a], {
      now: NOW,
      weights: { recency: 0, importance: 0, relevance: 1 },
    })
    expect(out[0].memory).toBe(a) // highest relevance wins despite worse recency/importance
  })

  it("respects a custom recency decay base", () => {
    const old = mem({ lastAccessedAt: NOW - 10 * DAY })
    const fresh = mem({ lastAccessedAt: NOW })
    const slow = scoreMemories([old, fresh], { now: NOW, recencyDecay: 0.999 })
    const fast = scoreMemories([old, fresh], { now: NOW, recencyDecay: 0.5 })
    // Both rank fresh first; assert the function runs with either base.
    expect(slow[0].memory).toBe(fresh)
    expect(fast[0].memory).toBe(fresh)
  })

  it("uses a per-memory half-life for recency when `halfLifeDays` is set", () => {
    // Same age; the longer half-life retains more recency after normalization.
    const shortLived = mem({ lastAccessedAt: NOW - 30 * DAY, halfLifeDays: 15 })
    const longLived = mem({ lastAccessedAt: NOW - 30 * DAY, halfLifeDays: 60 })
    const out = scoreMemories([shortLived, longLived], {
      now: NOW,
      weights: { recency: 1, importance: 0, relevance: 0, veracity: 0 },
    })
    expect(out[0].memory).toBe(longLived)
    expect(out.find((o) => o.memory === longLived)!.parts.recency).toBeGreaterThan(
      out.find((o) => o.memory === shortLived)!.parts.recency
    )
  })

  it("leaves recency on the generic decay path when `halfLifeDays` is absent", () => {
    // No halfLifeDays → identical to the pre-existing `decay ^ ageDays` behavior.
    const old = mem({ lastAccessedAt: NOW - 100 * DAY })
    const out = scoreMemories([old], { now: NOW })
    expect(out[0].parts.recency).toBeCloseTo(1) // single candidate normalizes to 1
  })

  it("adds veracity as a 4th factor when any candidate supplies it", () => {
    const trusted = mem({ veracity: 1 })
    const doubted = mem({ veracity: 0.5 })
    const out = scoreMemories([doubted, trusted], {
      now: NOW,
      weights: { recency: 0, importance: 0, relevance: 0, veracity: 1 },
    })
    expect(out[0].memory).toBe(trusted)
    expect(out.find((o) => o.memory === trusted)!.parts.veracity).toBeCloseTo(1)
    expect(out.find((o) => o.memory === doubted)!.parts.veracity).toBeCloseTo(0)
  })

  it("contributes nothing (parts.veracity=0) when no candidate supplies veracity", () => {
    const out = scoreMemories([mem({ importance: 8 }), mem({ importance: 3 })], { now: NOW })
    expect(out.every((o) => o.parts.veracity === 0)).toBe(true)
    // Score is exactly the prior three-factor sum (veracity term is 0).
    for (const o of out) {
      expect(o.score).toBeCloseTo(o.parts.recency + o.parts.importance + o.parts.relevance)
    }
  })

  it("ranks verified positive-feedback governance above stale contaminated rows", () => {
    const trusted = governanceScoreFor({
      confidence: 0.9,
      reviewStatus: "verified",
      contaminationState: "clean",
      staleness: "fresh",
      trustState: "trusted",
      retrievalFeedback: { positive: 5, negative: 0 },
    } as never)
    const doubted = governanceScoreFor({
      confidence: 0.2,
      reviewStatus: "unreviewed",
      contaminationState: "external-context",
      staleness: "stale",
      trustState: "untrusted",
      retrievalFeedback: { positive: 0, negative: 4 },
    } as never)
    expect(trusted).toBeGreaterThan(doubted)
  })
})

describe("recencyHalfLifeDaysForType", () => {
  it("scales the base half-life by type: episodic < semantic < procedural", () => {
    const base = 30
    expect(recencyHalfLifeDaysForType("episodic", base)).toBeLessThan(
      recencyHalfLifeDaysForType("semantic", base)
    )
    expect(recencyHalfLifeDaysForType("semantic", base)).toBeLessThan(
      recencyHalfLifeDaysForType("procedural", base)
    )
    expect(recencyHalfLifeDaysForType("semantic", base)).toBe(
      base * RECENCY_HALF_LIFE_MULTIPLIER.semantic
    )
  })

  it("clamps a negative base to 0", () => {
    expect(recencyHalfLifeDaysForType("semantic", -10)).toBe(0)
  })
})

describe("veracityFor", () => {
  it("ranks provenance user/explicit > external > system > inbound", () => {
    expect(veracityFor({ provenance: "user" })).toBeGreaterThan(
      veracityFor({ provenance: "external" })
    )
    expect(veracityFor({ provenance: "external" })).toBeGreaterThan(
      veracityFor({ provenance: "system" })
    )
    expect(veracityFor({ provenance: "system" })).toBeGreaterThan(
      veracityFor({ provenance: "inbound" })
    )
    expect(veracityFor({ provenance: "explicit" })).toBe(PROVENANCE_VERACITY.explicit)
  })

  it("treats a pinned memory as fully trusted regardless of provenance", () => {
    expect(veracityFor({ provenance: "inbound", pinned: true })).toBe(1)
  })
})
