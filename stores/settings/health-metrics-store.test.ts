import { useHealthMetricsStore } from "./health-metrics-store"

describe("useHealthMetricsStore", () => {
  beforeEach(() => {
    useHealthMetricsStore.getState().resetAll()
  })

  it("returns an empty healthy default for an unknown provider", () => {
    const m = useHealthMetricsStore.getState().getMetrics("ghost")
    expect(m.providerId).toBe("ghost")
    expect(m.totalRequests).toBe(0)
    expect(m.successRate).toBe(1)
  })

  it("aggregates recorded samples and tracks last error", () => {
    const s = useHealthMetricsStore.getState()
    s.record({ providerId: "openai", success: true, latencyMs: 100, timestamp: 1000 })
    s.record({
      providerId: "openai",
      success: false,
      latencyMs: 500,
      timestamp: 1001,
      errorMessage: "429",
    })
    const m = useHealthMetricsStore.getState().getMetrics("openai")
    expect(m.totalRequests).toBe(2)
    expect(m.totalErrors).toBe(1)
    expect(m.successRate).toBeCloseTo(0.5)
    expect(m.lastErrorMessage).toBe("429")
    expect(m.lastRequestAt).toBe(1001)
  })

  it("getDashboardData rolls up across providers", () => {
    const s = useHealthMetricsStore.getState()
    s.record({
      providerId: "a",
      success: true,
      latencyMs: 100,
      timestamp: 1,
      estimatedCostUsd: 0.01,
    })
    s.record({
      providerId: "b",
      success: true,
      latencyMs: 300,
      timestamp: 1,
      estimatedCostUsd: 0.02,
    })
    const d = useHealthMetricsStore.getState().getDashboardData()
    expect(d.global.totalRequests).toBe(2)
    expect(d.global.totalCost).toBeCloseTo(0.03)
    expect(d.global.overallSuccessRate).toBe(1)
  })

  it("resetProvider clears a single provider only", () => {
    const s = useHealthMetricsStore.getState()
    s.record({ providerId: "a", success: true, latencyMs: 1, timestamp: 1 })
    s.record({ providerId: "b", success: true, latencyMs: 1, timestamp: 1 })
    s.resetProvider("a")
    expect(useHealthMetricsStore.getState().getMetrics("a").totalRequests).toBe(0)
    expect(useHealthMetricsStore.getState().getMetrics("b").totalRequests).toBe(1)
  })
})
