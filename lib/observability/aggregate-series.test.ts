import {
  bucketSpans,
  costSeries,
  errorRateSeries,
  latencyPercentileSeries,
  requestRateSeries,
  tokenSeries,
  windowKpis,
} from "./aggregate-series"
import { customRange } from "./time-range"
import { makeSpan } from "./fixtures"

describe("aggregate-series", () => {
  // 4 buckets of 1s each: [0,1000), [1000,2000), [2000,3000), [3000,4000]
  const range = customRange(0, 3000)
  const bucketMs = 1000

  const spans = [
    makeSpan({ startTime: 100, durationMs: 50, costUsdEstimate: 0.01 }),
    makeSpan({ startTime: 200, durationMs: 150, costUsdEstimate: 0.02, errorMessage: "x" }),
    makeSpan({ startTime: 2500, durationMs: 300, costUsdEstimate: 0.05 }),
  ]

  describe("bucketSpans", () => {
    it("aligns spans to fixed boundaries", () => {
      const buckets = bucketSpans(spans, range, bucketMs)
      expect(buckets).toHaveLength(4)
      expect(buckets[0]).toHaveLength(2)
      expect(buckets[1]).toHaveLength(0)
      expect(buckets[2]).toHaveLength(1)
      expect(buckets[3]).toHaveLength(0)
    })

    it("skips out-of-range spans", () => {
      const buckets = bucketSpans([makeSpan({ startTime: 99_999 })], range, bucketMs)
      expect(buckets.every((b) => b.length === 0)).toBe(true)
    })
  })

  describe("costSeries", () => {
    it("sums cost per bucket and emits empty buckets as 0", () => {
      const s = costSeries(spans, range, bucketMs)
      expect(s.points.map((p) => p.costUsd)).toEqual([0.03, 0, 0.05, 0])
      expect(s.points[0].t).toBe(0)
    })
  })

  describe("tokenSeries", () => {
    it("splits tokens by class", () => {
      const withTokens = [
        makeSpan({
          startTime: 100,
          usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 1 },
        }),
      ]
      const s = tokenSeries(withTokens, range, bucketMs)
      expect(s.points[0]).toMatchObject({ input: 10, output: 4, cacheRead: 3, cacheCreation: 1 })
      expect(s.points[1]).toMatchObject({ input: 0, output: 0 })
    })
  })

  describe("requestRateSeries", () => {
    it("reports count and per-second rate", () => {
      const s = requestRateSeries(spans, range, bucketMs)
      expect(s.points[0].count).toBe(2)
      expect(s.points[0].perSec).toBe(2) // 2 spans / 1s
    })
  })

  describe("errorRateSeries", () => {
    it("computes fraction, null for empty buckets", () => {
      const s = errorRateSeries(spans, range, bucketMs)
      expect(s.points[0]).toMatchObject({ errors: 1, total: 2, errorRate: 0.5 })
      expect(s.points[1].errorRate).toBeNull()
      expect(s.points[2].errorRate).toBe(0)
    })
  })

  describe("latencyPercentileSeries", () => {
    it("emits percentiles per bucket and null when empty", () => {
      const s = latencyPercentileSeries(spans, range, bucketMs)
      expect(s.points[0].p50).toBe(100) // median of [50,150]
      expect(s.points[1].p50).toBeNull()
      expect(s.points[2].p95).toBe(300)
    })
  })

  describe("windowKpis", () => {
    it("aggregates headline numbers", () => {
      const k = windowKpis(spans, range)
      expect(k.totalSpans).toBe(3)
      expect(k.totalCost).toBeCloseTo(0.08, 5)
      expect(k.errorRate).toBeCloseTo(1 / 3, 5)
      expect(k.p95LatencyMs).toBeGreaterThan(0)
    })

    it("handles an empty window", () => {
      const k = windowKpis([], range)
      expect(k).toMatchObject({ totalSpans: 0, totalCost: 0, errorRate: 0, cacheHitRate: 0 })
      expect(k.p95LatencyMs).toBe(0)
    })

    it("computes cache hit rate", () => {
      const s = [
        makeSpan({
          startTime: 100,
          usage: { inputTokens: 30, outputTokens: 0, cacheReadTokens: 10, cacheCreationTokens: 0 },
        }),
      ]
      const k = windowKpis(s, range)
      expect(k.cacheHitRate).toBeCloseTo(10 / 40, 5)
    })
  })
})
