import {
  DEFAULT_AUTO_ROUTER_SETTINGS,
  type ModelRoutingSelection,
  type RoutingPlan,
  type RoutingStats,
} from "./auto-router"

describe("DEFAULT_AUTO_ROUTER_SETTINGS", () => {
  it("keeps auto opt-in and defaults routed requests to reliability", () => {
    expect(DEFAULT_AUTO_ROUTER_SETTINGS).toMatchObject({
      enabled: false,
      routingMode: "rule-based",
      strategy: "reliability",
      showRoutingIndicator: true,
      allowOverride: true,
      enableCache: true,
      cacheTTL: 300,
      fallbackTier: "balanced",
      defaultSelection: "manual",
      dataPolicy: { locality: "any" },
      shadowMode: true,
    })
  })
})

describe("routing plan contract", () => {
  it("uses an explicit manual selection that cannot be confused with auto routing", () => {
    const selection: ModelRoutingSelection = {
      kind: "manual",
      providerId: "openai",
      modelId: "gpt-test",
    }
    const selected = {
      providerId: "openai",
      modelId: "gpt-test",
      deploymentId: "openai::gpt-test",
      reasonCodes: ["manual-override" as const],
    }
    const plan: RoutingPlan = {
      decisionId: "decision-1",
      surface: "chat",
      requested: selection,
      strategy: "reliability",
      selected,
      orderedCandidates: [selected],
      reasonCodes: ["manual-override"],
      rejected: [],
      replayPolicy: "pre-commit-only",
      createdAt: 1,
    }

    expect(plan.requested.kind).toBe("manual")
    expect(plan.orderedCandidates[0]).toBe(plan.selected)
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
