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

  describe("deployment granularity", () => {
    it("isolates metrics per deployment while rolling up to the provider", () => {
      const s = useHealthMetricsStore.getState()
      s.record({
        providerId: "openai",
        modelId: "gpt-4o",
        success: true,
        latencyMs: 100,
        timestamp: 1000,
      })
      s.record({
        providerId: "openai",
        modelId: "gpt-4o-mini",
        success: false,
        latencyMs: 300,
        timestamp: 1001,
        errorMessage: "500",
      })

      const big = useHealthMetricsStore.getState().getDeploymentMetrics("openai::gpt-4o")
      const small = useHealthMetricsStore.getState().getDeploymentMetrics("openai::gpt-4o-mini")
      expect(big.totalRequests).toBe(1)
      expect(big.totalErrors).toBe(0)
      expect(small.totalRequests).toBe(1)
      expect(small.totalErrors).toBe(1)
      expect(small.lastErrorMessage).toBe("500")
      expect(big.lastErrorMessage).toBeUndefined()

      const provider = useHealthMetricsStore.getState().getMetrics("openai")
      expect(provider.totalRequests).toBe(2)
      expect(provider.totalErrors).toBe(1)
      expect(provider.successRate).toBeCloseTo(0.5)
    })

    it("computes provider percentiles over the union of deployment latencies", () => {
      const s = useHealthMetricsStore.getState()
      // Same bucket window: deployment A has fast samples, B has slow ones.
      for (const l of [10, 20, 30]) {
        s.record({ providerId: "p", modelId: "fast", success: true, latencyMs: l, timestamp: 1000 })
      }
      for (const l of [1000, 2000, 3000]) {
        s.record({ providerId: "p", modelId: "slow", success: true, latencyMs: l, timestamp: 1000 })
      }
      const provider = useHealthMetricsStore.getState().getMetrics("p")
      // Union [10,20,30,1000,2000,3000] → nearest-rank p50 = 30 (idx round(0.5*5)=3 → 1000)
      expect(provider.latencyP50).toBe(1000)
      expect(provider.latencyAvg).toBeCloseTo((10 + 20 + 30 + 1000 + 2000 + 3000) / 6)
      // Per-deployment percentiles stay isolated.
      expect(useHealthMetricsStore.getState().getDeploymentMetrics("p::fast").latencyP95).toBe(30)
    })

    it("records without modelId land in the provider wildcard bucket", () => {
      const s = useHealthMetricsStore.getState()
      s.record({ providerId: "openai", success: true, latencyMs: 50, timestamp: 1000 })
      expect(useHealthMetricsStore.getState().listDeploymentKeys("openai")).toEqual(["openai::*"])
      expect(useHealthMetricsStore.getState().getMetrics("openai").totalRequests).toBe(1)
    })

    it("keyId creates a distinct deployment bucket", () => {
      const s = useHealthMetricsStore.getState()
      s.record({
        providerId: "openai",
        modelId: "gpt-4o",
        keyId: "k1",
        success: true,
        latencyMs: 1,
        timestamp: 1,
      })
      s.record({
        providerId: "openai",
        modelId: "gpt-4o",
        keyId: "k2",
        success: true,
        latencyMs: 1,
        timestamp: 1,
      })
      const keys = useHealthMetricsStore.getState().listDeploymentKeys("openai").sort()
      expect(keys).toEqual(["openai::gpt-4o::k1", "openai::gpt-4o::k2"])
      expect(useHealthMetricsStore.getState().getMetrics("openai").totalRequests).toBe(2)
    })

    it("getDeploymentMetrics returns an empty default for unknown keys", () => {
      const m = useHealthMetricsStore.getState().getDeploymentMetrics("ghost::model")
      expect(m.totalRequests).toBe(0)
      expect(m.providerId).toBe("ghost")
      expect(m.deploymentKey).toBe("ghost::model")
    })

    it("resetProvider clears every deployment of that provider", () => {
      const s = useHealthMetricsStore.getState()
      s.record({ providerId: "a", modelId: "m1", success: true, latencyMs: 1, timestamp: 1 })
      s.record({ providerId: "a", modelId: "m2", success: true, latencyMs: 1, timestamp: 1 })
      s.record({ providerId: "b", modelId: "m1", success: true, latencyMs: 1, timestamp: 1 })
      s.resetProvider("a")
      expect(useHealthMetricsStore.getState().listDeploymentKeys("a")).toEqual([])
      expect(useHealthMetricsStore.getState().listDeploymentKeys("b")).toEqual(["b::m1"])
    })

    it("falls back to the raw provider id when ids cannot be encoded", () => {
      const s = useHealthMetricsStore.getState()
      s.record({ providerId: "weird::id", modelId: "m", success: true, latencyMs: 1, timestamp: 1 })
      expect(useHealthMetricsStore.getState().getMetrics("weird::id").totalRequests).toBe(1)
      s.resetProvider("weird::id")
      expect(useHealthMetricsStore.getState().getMetrics("weird::id").totalRequests).toBe(0)
    })
  })
})
