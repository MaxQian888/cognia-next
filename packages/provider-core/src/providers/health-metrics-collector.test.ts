import { recordToBuckets, aggregate, mergeBucketLists } from "./health-metrics-collector"
import {
  type HealthMetricsConfig,
  type SlidingWindowBucket,
} from "@cognia/provider-types/health-metrics"

const config: HealthMetricsConfig = {
  bucketDurationMs: 1000,
  bucketCount: 3,
  maxLatenciesPerBucket: 5,
}

describe("recordToBuckets", () => {
  it("folds requests into the bucket for their timestamp", () => {
    let b: SlidingWindowBucket[] = []
    b = recordToBuckets(b, { providerId: "p", success: true, latencyMs: 100 }, config, 500)
    b = recordToBuckets(b, { providerId: "p", success: false, latencyMs: 300 }, config, 700)
    expect(b).toHaveLength(1)
    expect(b[0].requestCount).toBe(2)
    expect(b[0].successCount).toBe(1)
    expect(b[0].errorCount).toBe(1)
    expect(b[0].latencySum).toBe(400)
    expect(b[0].latencies).toEqual([100, 300])
  })

  it("creates separate buckets per window and prunes aged-out ones", () => {
    let b: SlidingWindowBucket[] = []
    b = recordToBuckets(
      b,
      { providerId: "p", success: true, latencyMs: 1, timestamp: 0 },
      config,
      0
    )
    b = recordToBuckets(
      b,
      { providerId: "p", success: true, latencyMs: 1, timestamp: 1000 },
      config,
      1000
    )
    b = recordToBuckets(
      b,
      { providerId: "p", success: true, latencyMs: 1, timestamp: 2000 },
      config,
      2000
    )
    // 3 buckets retained (count=3).
    expect(b.map((x) => x.timestamp)).toEqual([0, 1000, 2000])
    // A 4th window prunes the oldest (cutoff keeps last 3).
    b = recordToBuckets(
      b,
      { providerId: "p", success: true, latencyMs: 1, timestamp: 3000 },
      config,
      3000
    )
    expect(b.map((x) => x.timestamp)).toEqual([1000, 2000, 3000])
  })

  it("caps stored latencies per bucket but keeps counting", () => {
    let b: SlidingWindowBucket[] = []
    for (let i = 0; i < 8; i++) {
      b = recordToBuckets(b, { providerId: "p", success: true, latencyMs: i }, config, 100)
    }
    expect(b[0].requestCount).toBe(8)
    expect(b[0].latencies).toHaveLength(5) // maxLatenciesPerBucket
  })
})

describe("aggregate", () => {
  it("computes rates, percentiles and trends", () => {
    let b: SlidingWindowBucket[] = []
    const lat = [10, 20, 30, 40, 100]
    for (const l of lat) {
      b = recordToBuckets(b, { providerId: "p", success: l !== 100, latencyMs: l }, config, 100)
    }
    const m = aggregate("p", b, { lastRequestAt: 100 })
    expect(m.totalRequests).toBe(5)
    expect(m.totalSuccesses).toBe(4)
    expect(m.totalErrors).toBe(1)
    expect(m.successRate).toBeCloseTo(0.8)
    expect(m.latencyAvg).toBeCloseTo(40)
    expect(m.latencyP50).toBe(30)
    expect(m.latencyP95).toBe(100)
    expect(m.lastRequestAt).toBe(100)
    expect(m.latencyTrend).toHaveLength(1)
  })

  it("returns a healthy default for an empty window", () => {
    const m = aggregate("p", [])
    expect(m.totalRequests).toBe(0)
    expect(m.successRate).toBe(1)
    expect(m.latencyP50).toBe(0)
    expect(m.lastRequestAt).toBeNull()
  })

  it("carries the last error message when supplied", () => {
    const m = aggregate("p", [], { lastErrorAt: 9, lastErrorMessage: "429" })
    expect(m.lastErrorAt).toBe(9)
    expect(m.lastErrorMessage).toBe("429")
  })
})

describe("mergeBucketLists", () => {
  function bucket(timestamp: number, latencies: number[], errors = 0): SlidingWindowBucket {
    return {
      timestamp,
      requestCount: latencies.length,
      successCount: latencies.length - errors,
      errorCount: errors,
      latencySum: latencies.reduce((a, b) => a + b, 0),
      latencies,
      costSum: latencies.length * 0.01,
    }
  }

  it("sums same-timestamp buckets and concatenates raw latencies", () => {
    const merged = mergeBucketLists([[bucket(0, [10, 20], 1)], [bucket(0, [1000])]])
    expect(merged).toHaveLength(1)
    expect(merged[0].requestCount).toBe(3)
    expect(merged[0].successCount).toBe(2)
    expect(merged[0].errorCount).toBe(1)
    expect(merged[0].latencySum).toBe(1030)
    expect(merged[0].latencies.sort((a, b) => a - b)).toEqual([10, 20, 1000])
    expect(merged[0].costSum).toBeCloseTo(0.03)
  })

  it("keeps distinct windows separate and time-sorted", () => {
    const merged = mergeBucketLists([[bucket(2000, [5])], [bucket(0, [1]), bucket(1000, [2])]])
    expect(merged.map((b) => b.timestamp)).toEqual([0, 1000, 2000])
  })

  it("recomputed percentiles cover the union (never averaged)", () => {
    const merged = mergeBucketLists([[bucket(0, [10, 20, 30])], [bucket(0, [1000, 2000, 3000])]])
    const m = aggregate("p", merged)
    // Nearest-rank over union [10,20,30,1000,2000,3000]: idx round(0.5*5)=3 → 1000.
    expect(m.latencyP50).toBe(1000)
    expect(m.latencyP95).toBe(3000)
  })

  it("does not mutate its inputs", () => {
    const a = bucket(0, [10])
    const before = JSON.parse(JSON.stringify(a))
    mergeBucketLists([[a], [bucket(0, [20])]])
    expect(a).toEqual(before)
  })

  it("returns an empty list for no inputs", () => {
    expect(mergeBucketLists([])).toEqual([])
  })
})
