import type { Memory } from "../types/memory"
import {
  DEFAULT_COLD_RETENTION_THRESHOLD,
  DEFAULT_RETENTION_PARAMS,
  isDecayable,
  lambdaFromHalfLifeDays,
  retentionScore,
  SALIENCE_DEFAULT,
  SALIENCE_MAX,
  SALIENCE_MIN,
  SALIENCE_STEP,
  salienceFor,
  type RetentionMemory,
} from "./retention"

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function row(over: Partial<RetentionMemory> = {}): RetentionMemory {
  return { createdAt: NOW, lastAccessedAt: NOW, accessCount: 0, ...over }
}

describe("constants", () => {
  it("match ai-memory's defaults", () => {
    expect(DEFAULT_RETENTION_PARAMS).toEqual({ lambda: 0.02, sigma: 0.6, mu: 0.04 })
    expect(DEFAULT_COLD_RETENTION_THRESHOLD).toBe(0.2)
    expect([SALIENCE_MIN, SALIENCE_MAX, SALIENCE_STEP, SALIENCE_DEFAULT]).toEqual([
      0.25, 2, 0.25, 1,
    ])
  })
})

describe("lambdaFromHalfLifeDays", () => {
  it("converts a half-life into a decay rate", () => {
    expect(lambdaFromHalfLifeDays(30)).toBeCloseTo(Math.LN2 / 30)
    // One half-life halves the time term.
    const lambda = lambdaFromHalfLifeDays(10)
    const score = retentionScore(row({ createdAt: NOW - 10 * DAY }), {
      now: NOW,
      params: { lambda },
    })
    expect(score).toBeCloseTo(0.5)
  })

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the default lambda for %p",
    (input) => {
      expect(lambdaFromHalfLifeDays(input)).toBe(DEFAULT_RETENTION_PARAMS.lambda)
    }
  )
})

describe("salienceFor", () => {
  it("is 1 without feedback", () => {
    expect(salienceFor({})).toBe(1)
    expect(salienceFor({ retrievalFeedback: { positive: 0, negative: 0 } })).toBe(1)
  })

  it("steps by 0.25 per net verdict", () => {
    expect(salienceFor({ retrievalFeedback: { positive: 1, negative: 0 } })).toBe(1.25)
    expect(salienceFor({ retrievalFeedback: { positive: 3, negative: 1 } })).toBe(1.5)
    expect(salienceFor({ retrievalFeedback: { positive: 0, negative: 2 } })).toBe(0.5)
  })

  it("clamps to [0.25, 2]", () => {
    expect(salienceFor({ retrievalFeedback: { positive: 50, negative: 0 } })).toBe(SALIENCE_MAX)
    expect(salienceFor({ retrievalFeedback: { positive: 0, negative: 50 } })).toBe(SALIENCE_MIN)
  })

  it("ignores negative counters", () => {
    expect(salienceFor({ retrievalFeedback: { positive: -4, negative: 0 } })).toBe(1)
    expect(salienceFor({ retrievalFeedback: { positive: 1, negative: -4 } })).toBe(1.25)
  })

  it("drops stale or expired rows to the floor regardless of feedback", () => {
    expect(
      salienceFor({ staleness: "stale", retrievalFeedback: { positive: 10, negative: 0 } })
    ).toBe(SALIENCE_MIN)
    expect(salienceFor({ staleness: "expired" })).toBe(SALIENCE_MIN)
    expect(salienceFor({ staleness: "fresh" })).toBe(1)
  })
})

describe("retentionScore", () => {
  it("fresh and unused ≈ 1.0 (ai-memory sanity)", () => {
    expect(retentionScore(row(), { now: NOW })).toBeCloseTo(1, 6)
  })

  it("365 days unused falls below 0.20 (ai-memory sanity)", () => {
    expect(retentionScore(row({ createdAt: NOW - 365 * DAY }), { now: NOW })).toBeLessThan(0.2)
  })

  it("a 200-day page with 50 recalls, last 2 days ago, survives (ai-memory sanity)", () => {
    const score = retentionScore(
      row({ createdAt: NOW - 200 * DAY, accessCount: 50, lastAccessedAt: NOW - 2 * DAY }),
      { now: NOW }
    )
    expect(score).toBeGreaterThanOrEqual(0.2)
    const expected = Math.exp(-0.02 * 200) + 0.6 * Math.log1p(50) * Math.exp(-0.04 * 2)
    expect(score).toBeCloseTo(expected, 10)
  })

  it("multiplies the time term by salience", () => {
    const base = row({ createdAt: NOW - 10 * DAY })
    const boosted = { ...base, retrievalFeedback: { positive: 4, negative: 0 } }
    expect(retentionScore(boosted, { now: NOW })).toBeCloseTo(
      2 * retentionScore(base, { now: NOW })
    )
  })

  it("adds no access term when never recalled, even with a later lastAccessedAt", () => {
    const score = retentionScore(
      row({ createdAt: NOW - 50 * DAY, lastAccessedAt: NOW, accessCount: 0 }),
      { now: NOW }
    )
    expect(score).toBeCloseTo(Math.exp(-0.02 * 50))
  })

  it("adds the access term once recalled", () => {
    const score = retentionScore(
      row({ createdAt: NOW - 50 * DAY, lastAccessedAt: NOW - 10 * DAY, accessCount: 3 }),
      { now: NOW }
    )
    expect(score).toBeCloseTo(Math.exp(-0.02 * 50) + 0.6 * Math.log1p(3) * Math.exp(-0.04 * 10))
  })

  it("counts age from revisedAt when present", () => {
    const revised = row({ createdAt: NOW - 300 * DAY, revisedAt: NOW })
    expect(retentionScore(revised, { now: NOW })).toBeCloseTo(1)
  })

  it("sigma = 0 disables reinforcement", () => {
    const used = row({ createdAt: NOW - 100 * DAY, accessCount: 40, lastAccessedAt: NOW })
    expect(retentionScore(used, { now: NOW, params: { sigma: 0 } })).toBeCloseTo(
      Math.exp(-0.02 * 100)
    )
  })

  it("clamps future timestamps to zero age", () => {
    const future = row({ createdAt: NOW + 10 * DAY, lastAccessedAt: NOW + 5 * DAY, accessCount: 1 })
    expect(retentionScore(future, { now: NOW })).toBeCloseTo(1 + 0.6 * Math.log1p(1))
  })

  it("treats invalid params as 0 (fail-safe)", () => {
    const m = row({ createdAt: NOW - 100 * DAY, accessCount: 5, lastAccessedAt: NOW - 100 * DAY })
    // lambda invalid → no time decay; sigma invalid → no access term.
    expect(retentionScore(m, { now: NOW, params: { lambda: Number.NaN, sigma: -1 } })).toBeCloseTo(
      1
    )
    expect(
      retentionScore(m, { now: NOW, params: { lambda: -3, sigma: Number.POSITIVE_INFINITY } })
    ).toBeCloseTo(1)
    // mu invalid → access term does not decay.
    expect(retentionScore(m, { now: NOW, params: { lambda: 0, mu: Number.NaN } })).toBeCloseTo(
      1 + 0.6 * Math.log1p(5)
    )
  })

  it("defaults the clock to Date.now()", () => {
    const spy = jest.spyOn(Date, "now").mockReturnValue(NOW + 35 * DAY)
    try {
      expect(retentionScore(row())).toBeCloseTo(Math.exp(-0.02 * 35))
    } finally {
      spy.mockRestore()
    }
  })

  it("decreases monotonically with age", () => {
    const scores = [0, 10, 50, 200].map((days) =>
      retentionScore(row({ createdAt: NOW - days * DAY }), { now: NOW })
    )
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1])
  })
})

describe("isDecayable", () => {
  const base: Pick<Memory, "type" | "pinned" | "status" | "projectMemoryKind"> = {
    type: "episodic",
    pinned: false,
    status: "active",
  }

  it("accepts an active unpinned episodic memory", () => {
    expect(isDecayable(base)).toBe(true)
  })

  it.each([
    ["semantic type", { type: "semantic" as const }],
    ["procedural type", { type: "procedural" as const }],
    ["pinned", { pinned: true }],
    ["invalidated", { status: "invalidated" as const }],
    ["mined project claim", { projectMemoryKind: "decision" as const }],
  ])("rejects %s", (_label, over) => {
    expect(isDecayable({ ...base, ...over } as typeof base)).toBe(false)
  })
})
