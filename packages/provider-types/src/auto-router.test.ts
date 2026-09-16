import {
  DEFAULT_AUTO_ROUTER_SETTINGS,
  TASK_CATEGORIES,
  type ModelRoutingSelection,
  type RoutingPlan,
  type RoutingStats,
  type TaskCategory,
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
      defaultSelection: "manual",
      dataPolicy: { locality: "any" },
      candidateAliases: ["fast", "balanced", "powerful"],
      categoryAliases: {},
      shadowMode: true,
    })
  })

  it("defaults to no fallback tier retry", () => {
    // Absent by design: a tier retry only runs after the ladder already found
    // no viable candidate, so defaulting to a ladder alias adds nothing.
    expect(DEFAULT_AUTO_ROUTER_SETTINGS.fallbackTier).toBeUndefined()
  })
})

describe("TASK_CATEGORIES", () => {
  it("lists every TaskCategory exactly once", () => {
    // Pinned to the union: a category added to TaskCategory without updating
    // this list breaks the settings UI's category-alias rows silently.
    const expected: TaskCategory[] = [
      "general",
      "coding",
      "analysis",
      "creative",
      "research",
      "conversation",
      "math",
      "translation",
      "summarization",
    ]
    expect([...TASK_CATEGORIES].sort()).toEqual([...expected].sort())
    expect(new Set(TASK_CATEGORIES).size).toBe(TASK_CATEGORIES.length)
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
