import {
  __TESTING__,
  getMissingProviderTraceContextCount,
  recordProviderOutcome,
} from "./provider-telemetry"
import {
  __resetForTesting as resetAffinity,
  getSessionDeployment,
  pinSessionDeployment,
} from "@cognia/provider-routing/session-affinity-store"
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

// Spy on the agent-trace child-span emission while keeping the rest of the
// emitter real. Mock fn defined inside the factory (TDZ).
jest.mock("@cognia/agent-trace/emitter", () => ({
  ...jest.requireActual("@cognia/agent-trace/emitter"),
  emitFinishedSpan: jest.fn(),
}))
import { emitFinishedSpan as emitFinishedSpanImport } from "@cognia/agent-trace/emitter"
const emitFinishedSpan = emitFinishedSpanImport as jest.Mock

/** Let the fire-and-forget dynamic import + .then chain settle. */
async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("recordProviderOutcome", () => {
  it("counts and warns when a session outcome has no trace id", () => {
    __TESTING__.resetMissingTraceContextCount()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})

    recordProviderOutcome({
      providerId: "anthropic",
      ok: true,
      latencyMs: 10,
      sessionId: "session-without-trace",
    })

    expect(getMissingProviderTraceContextCount()).toBe(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("traceId"),
      expect.objectContaining({ providerId: "anthropic" })
    )
    warn.mockRestore()
  })

  beforeEach(() => {
    useHealthMetricsStore.getState().resetAll()
    useCircuitBreakerStore.getState().resetAll()
    useCircuitBreakerStore.getState().setEnabled(true)
    useCircuitBreakerStore.getState().setSettings({ failureThreshold: 2 })
    useProviderCostMirrorStore.getState().reset()
    useRateLimitStore.getState().reset()
    resetAffinity()
    incrementProviderCost.mockClear()
    emitFinishedSpan.mockClear()
    emitFinishedSpan.mockReset()
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

    it("prefers the structured retryAfterMs over the string-extracted one", () => {
      for (let i = 0; i < 2; i++) {
        recordProviderOutcome({
          providerId: "openai",
          ok: false,
          latencyMs: 10,
          modelId: "gpt-4o",
          // The text says 120s, but the real Retry-After header was 45s.
          errorMessage: "429 rate limit exceeded, retry-after: 120",
          httpStatus: 429,
          retryAfterMs: 45_000,
        })
      }
      const b = useCircuitBreakerStore.getState().breakers["openai::gpt-4o"]
      expect(b.state.state).toBe("open")
      expect(b.state.dynamicCooldownMs).toBe(45_000)
    })

    it("classifies off the real status when the message is unhelpful", () => {
      for (let i = 0; i < 2; i++) {
        recordProviderOutcome({
          providerId: "openai",
          ok: false,
          latencyMs: 10,
          modelId: "gpt-4o",
          errorMessage: "upstream connect error",
          httpStatus: 429,
          retryAfterMs: 30_000,
        })
      }
      const b = useCircuitBreakerStore.getState().breakers["openai::gpt-4o"]
      expect(b.state.state).toBe("open")
      expect(b.state.dynamicCooldownMs).toBe(30_000)
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

    it("estimates cost from the token breakdown when the SDK reports none", async () => {
      // Non-Anthropic turn: no estimatedCostUsd, but a priced model + tokens.
      recordProviderOutcome({
        providerId: "openai",
        ok: true,
        latencyMs: 100,
        modelId: "gpt-4o",
        inputTokens: 10_000,
        outputTokens: 5_000,
      })
      const spend = useProviderCostMirrorStore.getState().getTodaySpend("openai")
      expect(spend).toBeGreaterThan(0)
      // The same estimate also reaches the health-metrics cost rollup.
      expect(useHealthMetricsStore.getState().getMetrics("openai").totalCost).toBeCloseTo(spend)
      await flushAsync()
      expect(incrementProviderCost).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "openai", modelId: "gpt-4o" })
      )
    })

    it("prefers the SDK cost over the token estimate when both are present", async () => {
      recordProviderOutcome({
        providerId: "openai",
        ok: true,
        latencyMs: 100,
        estimatedCostUsd: 0.5,
        modelId: "gpt-4o",
        inputTokens: 10_000,
        outputTokens: 5_000,
      })
      // 0.5 is far above any token-estimate for these counts → SDK figure used.
      expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBeCloseTo(0.5)
    })

    it("stays unknown for a priced-less model even with tokens", async () => {
      recordProviderOutcome({
        providerId: "openai",
        ok: true,
        latencyMs: 100,
        modelId: "mystery-model-xyz",
        inputTokens: 10_000,
        outputTokens: 5_000,
      })
      await flushAsync()
      expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBe(0)
      expect(incrementProviderCost).not.toHaveBeenCalled()
    })
  })
})

describe("recordProviderOutcome — agent-trace provider child span", () => {
  beforeEach(() => {
    useHealthMetricsStore.getState().resetAll()
    useCircuitBreakerStore.getState().resetAll()
    useProviderCostMirrorStore.getState().reset()
    useRateLimitStore.getState().reset()
    resetAffinity()
    emitFinishedSpan.mockReset()
  })

  it("does NOT emit a span when no traceId is threaded (back-compat)", () => {
    recordProviderOutcome({
      providerId: "anthropic",
      ok: true,
      latencyMs: 100,
      modelId: "claude-opus-4-8",
      sessionId: "s1",
    })
    expect(emitFinishedSpan).not.toHaveBeenCalled()
  })

  it("does NOT emit a span when traceId is present but sessionId is missing", () => {
    recordProviderOutcome({
      providerId: "anthropic",
      ok: true,
      latencyMs: 100,
      modelId: "claude-opus-4-8",
      traceId: "a".repeat(32),
      parentSpanId: "b".repeat(16),
    })
    expect(emitFinishedSpan).not.toHaveBeenCalled()
  })

  it("emits exactly one child span nested under the root with usage + cost on success", () => {
    recordProviderOutcome({
      providerId: "anthropic",
      ok: true,
      latencyMs: 240,
      estimatedCostUsd: 0.012,
      modelId: "claude-opus-4-8",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 50,
      sessionId: "s1",
      traceId: "a".repeat(32),
      parentSpanId: "b".repeat(16),
      surface: "chat",
    })
    expect(emitFinishedSpan).toHaveBeenCalledTimes(1)
    expect(emitFinishedSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "a".repeat(32),
        parentSpanId: "b".repeat(16),
        operationName: "chat",
        providerName: "anthropic",
        sessionId: "s1",
        surface: "chat",
        requestModel: "claude-opus-4-8",
        responseModel: "claude-opus-4-8",
        durationMs: 240,
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationTokens: 50,
          cacheReadTokens: 200,
        },
        costUsdEstimate: 0.012,
        metadata: { providerId: "anthropic" },
      })
    )
    const span = emitFinishedSpan.mock.calls[0][0]
    expect(span.errorType).toBeUndefined()
  })

  it("buckets a non-anthropic provider to openai with the true id in metadata", () => {
    recordProviderOutcome({
      providerId: "openai",
      ok: true,
      latencyMs: 50,
      modelId: "gpt-4o",
      sessionId: "s1",
      traceId: "a".repeat(32),
      parentSpanId: "b".repeat(16),
    })
    expect(emitFinishedSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: "openai",
        surface: "chat",
        metadata: { providerId: "openai" },
      })
    )
  })

  it("maps a failure to errorType/errorMessage on the span", () => {
    recordProviderOutcome({
      providerId: "anthropic",
      ok: false,
      latencyMs: 0,
      errorMessage: "overloaded",
      modelId: "claude-opus-4-8",
      sessionId: "s1",
      traceId: "a".repeat(32),
      parentSpanId: "b".repeat(16),
    })
    expect(emitFinishedSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "provider_error",
        errorMessage: "overloaded",
      })
    )
  })

  it("does not throw when span emission fails", () => {
    emitFinishedSpan.mockImplementation(() => {
      throw new Error("emitter boom")
    })
    expect(() =>
      recordProviderOutcome({
        providerId: "anthropic",
        ok: true,
        latencyMs: 100,
        modelId: "claude-opus-4-8",
        sessionId: "s1",
        traceId: "a".repeat(32),
        parentSpanId: "b".repeat(16),
      })
    ).not.toThrow()
  })
})
