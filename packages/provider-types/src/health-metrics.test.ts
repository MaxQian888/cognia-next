import {
  DEFAULT_HEALTH_METRICS_CONFIG,
  EMPTY_PROVIDER_HEALTH_METRICS,
  type HealthDashboardData,
} from "./health-metrics"

describe("EMPTY_PROVIDER_HEALTH_METRICS", () => {
  it("represents a healthy empty baseline", () => {
    expect(EMPTY_PROVIDER_HEALTH_METRICS).toMatchObject({
      totalRequests: 0,
      totalSuccesses: 0,
      totalErrors: 0,
      successRate: 1,
      uptimePercent: 1,
      lastRequestAt: null,
      lastErrorAt: null,
      latencyTrend: [],
      errorRateTrend: [],
    })
  })
})

describe("DEFAULT_HEALTH_METRICS_CONFIG", () => {
  it("keeps a five-minute sliding window at one-minute buckets", () => {
    expect(DEFAULT_HEALTH_METRICS_CONFIG).toEqual({
      bucketDurationMs: 60000,
      bucketCount: 5,
      maxLatenciesPerBucket: 100,
    })
  })
})

describe("HealthDashboardData contract", () => {
  it("combines provider and global aggregates", () => {
    const data: HealthDashboardData = {
      providers: {
        openai: { providerId: "openai", ...EMPTY_PROVIDER_HEALTH_METRICS },
      },
      global: { totalRequests: 0, totalCost: 0, avgLatency: 0, overallSuccessRate: 1 },
      lastRefreshAt: 1,
    }

    expect(data.providers.openai.successRate).toBe(1)
    expect(data.global.overallSuccessRate).toBe(1)
  })
})
