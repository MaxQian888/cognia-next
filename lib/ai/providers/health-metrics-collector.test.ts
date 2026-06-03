import { recordToBuckets, aggregate } from "./health-metrics-collector"
import {
  DEFAULT_HEALTH_METRICS_CONFIG,
  type HealthMetricsConfig,
  type SlidingWindowBucket,
} from "@/types/provider/health-metrics"

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
