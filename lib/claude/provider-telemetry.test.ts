import { recordProviderOutcome } from "./provider-telemetry"
import { useHealthMetricsStore } from "@/stores/settings/health-metrics-store"
import { useCircuitBreakerStore } from "@/stores/settings/circuit-breaker-store"

describe("recordProviderOutcome", () => {
  beforeEach(() => {
    useHealthMetricsStore.getState().resetAll()
    useCircuitBreakerStore.getState().resetAll()
    useCircuitBreakerStore.getState().setEnabled(true)
    useCircuitBreakerStore.getState().setSettings({ failureThreshold: 2 })
  })

  it("records a success into health metrics and the breaker", () => {
    recordProviderOutcome({
      providerId: "openai",
      ok: true,
      latencyMs: 120,
      estimatedCostUsd: 0.01,
    })
    const m = useHealthMetricsStore.getState().getMetrics("openai")
    expect(m.totalRequests).toBe(1)
    expect(m.totalSuccesses).toBe(1)
    expect(m.totalCost).toBeCloseTo(0.01)
    expect(useCircuitBreakerStore.getState().getState("openai")).toBe("closed")
  })

  it("trips the breaker after repeated failures", () => {
    recordProviderOutcome({ providerId: "openai", ok: false, latencyMs: 50, errorMessage: "500" })
    expect(useCircuitBreakerStore.getState().getState("openai")).toBe("closed")
    recordProviderOutcome({ providerId: "openai", ok: false, latencyMs: 50, errorMessage: "500" })
    expect(useCircuitBreakerStore.getState().getState("openai")).toBe("open")
    const m = useHealthMetricsStore.getState().getMetrics("openai")
    expect(m.totalErrors).toBe(2)
    expect(m.lastErrorMessage).toBe("500")
  })

  it("ignores an empty provider id", () => {
    recordProviderOutcome({ providerId: "", ok: true, latencyMs: 10 })
    expect(useHealthMetricsStore.getState().getDashboardData().global.totalRequests).toBe(0)
  })

  it("clamps a negative/NaN latency to 0", () => {
    recordProviderOutcome({ providerId: "p", ok: true, latencyMs: Number.NaN })
    expect(useHealthMetricsStore.getState().getMetrics("p").latencyAvg).toBe(0)
  })
})
