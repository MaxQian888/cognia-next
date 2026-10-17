import {
  combineParallelEstimates,
  decayWeight,
  EMPTY_ESTIMATE,
  ESTIMATE_HALF_LIFE_MS,
  ESTIMATE_WINDOW_MS,
  estimateRun,
  weightedQuantile,
  type RunEstimate,
  type RunSample,
} from "./estimate"

const NOW = 1_800_000_000_000
const DAY = 86_400_000

/** $1 per 1M input and output tokens; cache tiers fall back to multipliers. */
const flatPricing = () => ({ promptPer1M: 1, completionPer1M: 1 })

function sample(over: Partial<RunSample> = {}): RunSample {
  return {
    surface: "goal",
    harness: "builtin",
    modelFamily: "claude-sonnet",
    model: "claude-sonnet-4-5",
    providerId: "anthropic",
    endedAt: NOW - DAY,
    durationMs: 10 * 60_000,
    tokens: {
      input: 100_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    },
    frozenCostUsd: null,
    stoppedEarly: false,
    ...over,
  }
}

function many(n: number, over: Partial<RunSample> = {}): RunSample[] {
  return Array.from({ length: n }, () => sample(over))
}

describe("weightedQuantile", () => {
  it("matches the Hazen percentile when weights are equal", () => {
    const pts = [1, 2, 3, 4, 5].map((value) => ({ value, weight: 1 }))
    expect(weightedQuantile(pts, 0.5)).toBe(3)
    expect(weightedQuantile(pts, 0)).toBe(1)
    expect(weightedQuantile(pts, 1)).toBe(5)
    expect(weightedQuantile(pts, 0.25)).toBeCloseTo(1.75)
  })

  it("leans toward heavier points", () => {
    const pts = [
      { value: 0, weight: 1 },
      { value: 100, weight: 9 },
    ]
    expect(weightedQuantile(pts, 0.5)).toBeCloseTo(90)
  })

  it("handles empty, single and zero-weight inputs", () => {
    expect(weightedQuantile([], 0.5)).toBe(0)
    expect(weightedQuantile([{ value: 7, weight: 1 }], 0.9)).toBe(7)
    expect(weightedQuantile([{ value: 7, weight: 0 }], 0.9)).toBe(0)
  })
})

describe("decayWeight", () => {
  it("halves every half-life", () => {
    expect(decayWeight(0)).toBe(1)
    expect(decayWeight(ESTIMATE_HALF_LIFE_MS)).toBeCloseTo(0.5)
    expect(decayWeight(-5)).toBe(1)
  })
})

describe("estimateRun", () => {
  const opts = { now: NOW, resolve: flatPricing }

  it("answers none with no history", () => {
    expect(estimateRun([], { surface: "goal" }, opts)).toEqual(EMPTY_ESTIMATE)
  })

  it("keeps bot dormant even when samples exist (ADR-0232)", () => {
    const samples = many(30)
    expect(estimateRun(samples, { surface: "bot" }, opts)).toEqual(EMPTY_ESTIMATE)
  })

  it("labels confidence by sample count", () => {
    expect(estimateRun(many(3), { surface: "goal" }, opts).confidence).toBe("rough")
    expect(estimateRun(many(5), { surface: "goal" }, opts).confidence).toBe("few")
    expect(estimateRun(many(20), { surface: "goal" }, opts).confidence).toBe("based")
  })

  it("re-prices tokens at today's rates for the query model", () => {
    const est = estimateRun(
      many(5),
      { surface: "goal", model: "x", providerId: "p" },
      {
        now: NOW,
        resolve: (_p, model) => (model === "x" ? { promptPer1M: 10, completionPer1M: 10 } : null),
      }
    )
    expect(est.costUsd?.p50).toBeCloseTo(1)
    expect(est.tokens?.p50).toBe(100_000)
  })

  it("falls back to the sample's own model when the query model is unpriced", () => {
    const est = estimateRun(
      many(5),
      { surface: "goal", model: "unknown" },
      {
        now: NOW,
        resolve: (_p, model) => (model === "claude-sonnet-4-5" ? flatPricing() : null),
      }
    )
    expect(est.costUsd?.p50).toBeCloseTo(0.1)
  })

  it("leaves cost null when nothing can be priced", () => {
    const est = estimateRun(many(5), { surface: "goal" }, { now: NOW, resolve: () => null })
    expect(est.costUsd).toBeNull()
    expect(est.tokens).not.toBeNull()
  })

  it("uses frozen cost for samples without tokens and multiplies parallel runs", () => {
    const samples = many(5, { surface: "best-of-n", tokens: null, frozenCostUsd: 2 })
    const est = estimateRun(samples, { surface: "best-of-n", multiplier: 3 }, opts)
    expect(est.costUsd?.p50).toBeCloseTo(6)
    expect(est.tokens).toBeNull()
    // Parallel candidates do not take longer together.
    expect(est.durationMs?.p50).toBe(10 * 60_000)
  })

  it("ignores runs outside the window and runs from the future", () => {
    const old = many(10, { endedAt: NOW - ESTIMATE_WINDOW_MS - DAY })
    const future = many(10, { endedAt: NOW + DAY })
    expect(estimateRun([...old, ...future], { surface: "goal" }, opts)).toEqual(EMPTY_ESTIMATE)
  })

  it("prefers the finest bucket that has enough samples", () => {
    const opus = many(5, {
      modelFamily: "claude-opus",
      tokens: { ...sample().tokens!, input: 900_000 },
    })
    const sonnet = many(10)
    const est = estimateRun(
      [...opus, ...sonnet],
      { surface: "goal", harness: "builtin", modelFamily: "claude-opus" },
      opts
    )
    expect(est.sampleCount).toBe(5)
    expect(est.tokens?.p50).toBe(900_000)
  })

  it("falls back to coarser buckets, never to another surface", () => {
    const est = estimateRun(
      [...many(3, { modelFamily: "claude-opus" }), ...many(4), ...many(30, { surface: "team" })],
      { surface: "goal", harness: "builtin", modelFamily: "claude-opus" },
      opts
    )
    expect(est.confidence).toBe("few")
    expect(est.sampleCount).toBe(7)
  })

  it("answers rough from the fullest bucket when none reaches five", () => {
    const est = estimateRun(
      [...many(1, { modelFamily: "claude-opus" }), ...many(2), ...many(30, { surface: "team" })],
      { surface: "goal", harness: "builtin", modelFamily: "claude-opus" },
      opts
    )
    expect(est.confidence).toBe("rough")
    expect(est.sampleCount).toBe(3)
  })

  it("does not match unknown-harness samples in harness buckets", () => {
    const est = estimateRun(
      [...many(5, { harness: null }), ...many(2)],
      { surface: "goal", harness: "builtin", modelFamily: "claude-sonnet" },
      opts
    )
    // Harness levels hold 2; only the surface level reaches 5.
    expect(est.sampleCount).toBe(7)
    expect(est.confidence).toBe("few")
  })

  it("consults imported sessions only for an external harness", () => {
    const imported = many(6, { surface: "external-session", harness: "ext:codex" })
    expect(
      estimateRun(imported, { surface: "best-of-n", harness: "ext:codex" }, opts).sampleCount
    ).toBe(6)
    expect(estimateRun(imported, { surface: "best-of-n", harness: "builtin" }, opts)).toEqual(
      EMPTY_ESTIMATE
    )
    expect(estimateRun(imported, { surface: "goal" }, opts)).toEqual(EMPTY_ESTIMATE)
  })

  it("prefers the surface's own history over imported sessions", () => {
    const own = many(5, {
      surface: "best-of-n",
      harness: "ext:codex",
      tokens: null,
      frozenCostUsd: 1,
    })
    const imported = many(20, { surface: "external-session", harness: "ext:codex" })
    const est = estimateRun(
      [...own, ...imported],
      { surface: "best-of-n", harness: "ext:codex" },
      opts
    )
    expect(est.sampleCount).toBe(5)
  })

  it("reports the weighted share of runs that stopped early", () => {
    const est = estimateRun(
      [...many(3, { stoppedEarly: true }), ...many(1), ...many(2, { stoppedEarly: null })],
      { surface: "goal" },
      opts
    )
    expect(est.stoppedShare).toBeCloseTo(0.75)
    expect(
      estimateRun(many(5, { stoppedEarly: null }), { surface: "goal" }, opts).stoppedShare
    ).toBeNull()
  })

  it("skips missing durations", () => {
    const est = estimateRun(many(5, { durationMs: null }), { surface: "goal" }, opts)
    expect(est.durationMs).toBeNull()
  })
})

describe("combineParallelEstimates", () => {
  const part = (over: Partial<RunEstimate>): RunEstimate => ({
    confidence: "based",
    sampleCount: 30,
    tokens: { p10: 1, p50: 2, p90: 3 },
    costUsd: { p10: 1, p50: 2, p90: 3 },
    durationMs: { p10: 10, p50: 20, p90: 30 },
    stoppedShare: 0.1,
    ...over,
  })

  it("adds cost and tokens, takes the slowest duration and the weakest confidence", () => {
    const combined = combineParallelEstimates([
      part({}),
      part({
        confidence: "few",
        sampleCount: 6,
        durationMs: { p10: 5, p50: 40, p90: 50 },
        stoppedShare: 0.3,
      }),
    ])
    expect(combined.costUsd).toEqual({ p10: 2, p50: 4, p90: 6 })
    expect(combined.tokens).toEqual({ p10: 2, p50: 4, p90: 6 })
    expect(combined.durationMs).toEqual({ p10: 10, p50: 40, p90: 50 })
    expect(combined.confidence).toBe("few")
    expect(combined.sampleCount).toBe(6)
    expect(combined.stoppedShare).toBe(0.3)
  })

  it("is none when any part has no estimate, and null where a part lacks a figure", () => {
    expect(combineParallelEstimates([part({}), EMPTY_ESTIMATE])).toEqual(EMPTY_ESTIMATE)
    expect(combineParallelEstimates([])).toEqual(EMPTY_ESTIMATE)
    const noTokens = combineParallelEstimates([part({}), part({ tokens: null, durationMs: null })])
    expect(noTokens.tokens).toBeNull()
    expect(noTokens.durationMs).toBeNull()
  })
})
