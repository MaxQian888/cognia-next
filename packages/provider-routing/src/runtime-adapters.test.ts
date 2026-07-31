import {
  getModelContextLimits,
  getModelMaxTokens,
  getProviderRoutingRuntimeAdapters,
  resetProviderRoutingRuntimeAdaptersForTesting,
  setProviderRoutingRuntimeAdapters,
} from "./runtime-adapters"

describe("provider-routing runtime adapters", () => {
  afterEach(() => {
    resetProviderRoutingRuntimeAdaptersForTesting()
  })

  it("provides safe defaults when the host has not wired live stores", () => {
    const runtime = getProviderRoutingRuntimeAdapters()

    expect(runtime.getHealthMetrics("openai")).toBeUndefined()
    expect(runtime.getCircuitBreakerState("openai")).toBe("closed")
    expect(runtime.isCircuitBreakerAvailable("openai")).toBe(true)
    expect(runtime.getTodaySpend("openai")).toBe(0)
    expect(runtime.getRate("openai")).toEqual({ rpm: 0, tpm: 0 })
    expect(runtime.getInFlight("openai")).toBe(0)
  })

  it("forwards calls through injected live-store adapters", () => {
    setProviderRoutingRuntimeAdapters({
      getHealthMetrics: (providerId) =>
        providerId === "openai"
          ? ({
              providerId,
              totalRequests: 1,
              successRate: 1,
              averageLatency: 100,
              latencyP50: 100,
              latencyP95: 100,
              errorRate: 0,
              totalCost: 0,
              lastUpdated: 1,
            } as never)
          : undefined,
      getCircuitBreakerState: () => "open",
      isCircuitBreakerAvailable: () => false,
      getTodaySpend: () => 4.2,
      getRate: () => ({ rpm: 2, tpm: 100 }),
      getInFlight: () => 3,
    })

    const runtime = getProviderRoutingRuntimeAdapters()

    expect(runtime.getHealthMetrics("openai")?.totalRequests).toBe(1)
    expect(runtime.getCircuitBreakerState("openai")).toBe("open")
    expect(runtime.isCircuitBreakerAvailable("openai")).toBe(false)
    expect(runtime.getTodaySpend("openai")).toBe(4.2)
    expect(runtime.getRate("openai")).toEqual({ rpm: 2, tpm: 100 })
    expect(runtime.getInFlight("openai")).toBe(3)
  })

  it("keeps model context limit helpers package-local", () => {
    expect(getModelMaxTokens("gpt-4o")).toBe(128000)
    expect(getModelContextLimits("unknown-model")).toEqual({
      maxTokens: 100000,
      reserveTokens: 2000,
    })
  })
})
