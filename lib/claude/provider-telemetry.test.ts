import { recordProviderOutcome } from "./provider-telemetry"
import {
  __resetForTesting as resetAffinity,
  getSessionDeployment,
  pinSessionDeployment,
} from "@/lib/ai/routing/session-affinity-store"
import { useHealthMetricsStore } from "@/stores/settings/health-metrics-store"
import { useCircuitBreakerStore } from "@/stores/settings/circuit-breaker-store"
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"
import { useRateLimitStore } from "@/stores/settings/rate-limit-store"

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
    useRateLimitStore.getState().reset()
    resetAffinity()
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

  describe("deployment granularity", () => {
    it("routes outcomes into the modelId's deployment buckets", () => {
      recordProviderOutcome({
        providerId: "openai",
        ok: true,
        latencyMs: 100,
        modelId: "gpt-4o",
        tokensUsed: 500,
      })
      recordProviderOutcome({
        providerId: "openai",
        ok: false,
        latencyMs: 50,
        errorMessage: "500",
        modelId: "gpt-4o-mini",
      })
      recordProviderOutcome({
        providerId: "openai",
        ok: false,
        latencyMs: 50,
        errorMessage: "500",
        modelId: "gpt-4o-mini",
      })
      const health = useHealthMetricsStore.getState()
      expect(health.getDeploymentMetrics("openai::gpt-4o").totalErrors).toBe(0)
      expect(health.getDeploymentMetrics("openai::gpt-4o-mini").totalErrors).toBe(2)
      const cb = useCircuitBreakerStore.getState()
      expect(cb.getDeploymentState("openai::gpt-4o-mini")).toBe("open")
      expect(cb.getDeploymentState("openai::gpt-4o")).toBe("closed")
      expect(cb.getState("openai")).toBe("closed") // provider still routable
      expect(useRateLimitStore.getState().getDeploymentRate("openai::gpt-4o", Date.now()).tpm).toBe(
        500
      )
    })

    it("forwards Retry-After hints from the error text into the breaker", () => {
      for (let i = 0; i < 2; i++) {
        recordProviderOutcome({
          providerId: "openai",
          ok: false,
          latencyMs: 10,
          modelId: "gpt-4o",
          errorMessage: "429 rate limit exceeded, retry-after: 120",
        })
      }
      const b = useCircuitBreakerStore.getState().breakers["openai::gpt-4o"]
      expect(b.state.state).toBe("open")
      expect(b.state.dynamicCooldownMs).toBe(120_000)
    })
  })

  describe("session affinity", () => {
    it("pins the session to the serving deployment on success", () => {
      recordProviderOutcome({
        providerId: "openai",
        ok: true,
        latencyMs: 10,
        modelId: "gpt-4o",
        sessionId: "s1",
      })
      expect(getSessionDeployment("s1")).toBe("openai::gpt-4o")
    })

    it("releases the pin on a permanent failure", () => {
      pinSessionDeployment("s1", "openai::gpt-4o")
      recordProviderOutcome({
        providerId: "openai",
        ok: false,
        latencyMs: 10,
        modelId: "gpt-4o",
        errorMessage: "401 Unauthorized",
        sessionId: "s1",
      })
      expect(getSessionDeployment("s1")).toBeUndefined()
    })

    it("keeps the pin on a transient failure", () => {
      pinSessionDeployment("s1", "openai::gpt-4o")
      recordProviderOutcome({
        providerId: "openai",
        ok: false,
        latencyMs: 10,
        modelId: "gpt-4o",
        errorMessage: "HTTPError 429: rate_limit_error",
        sessionId: "s1",
      })
      expect(getSessionDeployment("s1")).toBe("openai::gpt-4o")
    })

    it("does not pin without a sessionId", () => {
      recordProviderOutcome({ providerId: "openai", ok: true, latencyMs: 10, modelId: "gpt-4o" })
      expect(getSessionDeployment("")).toBeUndefined()
    })
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
