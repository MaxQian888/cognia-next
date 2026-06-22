import { DEFAULT_AUTO_ROUTER_SETTINGS, type RoutingStats } from "./auto-router"

describe("DEFAULT_AUTO_ROUTER_SETTINGS", () => {
  it("enables balanced rule-based routing with cache and override support", () => {
    expect(DEFAULT_AUTO_ROUTER_SETTINGS).toMatchObject({
      enabled: true,
      routingMode: "rule-based",
      strategy: "balanced",
      showRoutingIndicator: true,
      allowOverride: true,
      enableCache: true,
      cacheTTL: 300,
      fallbackTier: "balanced",
    })
  })
})

describe("RoutingStats contract", () => {
  it("supports per-tier, per-provider, and per-category counters", () => {
    const stats: RoutingStats = {
      totalRequests: 1,
      byTier: { fast: 1, balanced: 0, powerful: 0, reasoning: 0 },
      byProvider: { openai: 1 },
      byCategory: {
        general: 1,
        coding: 0,
        analysis: 0,
        creative: 0,
        research: 0,
        conversation: 0,
        math: 0,
        translation: 0,
        summarization: 0,
      },
      avgLatency: 12,
      cacheHitRate: 0,
      estimatedCostSaved: 0,
    }

    expect(stats.byTier.fast).toBe(1)
    expect(stats.byCategory.general).toBe(1)
  })
})
