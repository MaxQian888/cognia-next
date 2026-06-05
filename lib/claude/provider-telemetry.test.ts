import { recordProviderOutcome } from "./provider-telemetry"
import { useHealthMetricsStore } from "@/stores/settings/health-metrics-store"
import { useCircuitBreakerStore } from "@/stores/settings/circuit-breaker-store"
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"

// Define the spy INSIDE the factory (hoisting/TDZ: the factory can run during
// top-level imports, before any outer const initializes). Real helpers like
// `localDayString` pass through so the mirror store keeps working.
jest.mock("@/lib/db/provider-cost-daily", () => ({
  ...jest.requireActual("@/lib/db/provider-cost-daily"),
  incrementProviderCost: jest.fn().mockResolvedValue(undefined),
}))

import { incrementProviderCost as incrementProviderCostImport } from "@/lib/db/provider-cost-daily"
const incrementProviderCost = incrementProviderCostImport as jest.Mock

/** Let the fire-and-forget dynamic import + .then chain settle. */
async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("recordProviderOutcome", () => {
  beforeEach(() => {
    useHealthMetricsStore.getState().resetAll()
    useCircuitBreakerStore.getState().resetAll()
    useCircuitBreakerStore.getState().setEnabled(true)
    useCircuitBreakerStore.getState().setSettings({ failureThreshold: 2 })
    useProviderCostMirrorStore.getState().reset()
    incrementProviderCost.mockClear()
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

  describe("durable cost rollup", () => {
    it("updates the cost mirror synchronously and writes the Dexie rollup on success", async () => {
      recordProviderOutcome({
        providerId: "openai",
        ok: true,
        latencyMs: 100,
        estimatedCostUsd: 0.05,
        modelId: "gpt-4o",
      })
      // Mirror update is synchronous (the engine reads it on the next send).
      expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBeCloseTo(0.05)
      await flushAsync()
      expect(incrementProviderCost).toHaveBeenCalledWith({
        providerId: "openai",
        modelId: "gpt-4o",
        costUsd: 0.05,
      })
    })

    it("does not write cost on failure", async () => {
      recordProviderOutcome({
        providerId: "openai",
        ok: false,
        latencyMs: 100,
        errorMessage: "boom",
        estimatedCostUsd: 0.05,
        modelId: "gpt-4o",
      })
      await flushAsync()
      expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBe(0)
      expect(incrementProviderCost).not.toHaveBeenCalled()
    })

    it("does not write cost without a modelId or with zero cost", async () => {
      recordProviderOutcome({
        providerId: "openai",
        ok: true,
        latencyMs: 10,
        estimatedCostUsd: 0.05,
      })
      recordProviderOutcome({ providerId: "openai", ok: true, latencyMs: 10, modelId: "gpt-4o" })
      recordProviderOutcome({
        providerId: "openai",
        ok: true,
        latencyMs: 10,
        estimatedCostUsd: 0,
        modelId: "gpt-4o",
      })
      await flushAsync()
      expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBe(0)
      expect(incrementProviderCost).not.toHaveBeenCalled()
    })
  })
})
