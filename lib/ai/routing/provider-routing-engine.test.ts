import { ProviderRoutingEngine, type RoutingEngineDeps } from "./provider-routing-engine"
import {
  DEFAULT_ROUTING_CONFIG,
  type ModelMapping,
  type ModelMappingEntry,
  type ModelMappingRegistry,
  type RoutingConfig,
} from "@/types/provider/model-mapping"
import type { ProviderHealthMetrics } from "@/types/provider/health-metrics"
import type { CircuitBreakerStateValue } from "@/types/provider/circuit-breaker"

function entry(
  providerId: string,
  modelId: string,
  extras: Partial<ModelMappingEntry> = {}
): ModelMappingEntry {
  return { providerId, modelId, ...extras }
}

function mapping(
  alias: string,
  providers: ModelMappingEntry[],
  extras: Partial<ModelMapping> = {}
): ModelMapping {
  return {
    id: `m-${alias}`,
    alias,
    providers,
    distribution: "priority",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...extras,
  }
}

function registry(mappings: ModelMapping[], enabled = true): ModelMappingRegistry {
  return { mappings, enabled }
}

interface DepsState {
  pricing?: Record<string, number>
  metrics?: Record<string, ProviderHealthMetrics>
  cb?: Record<string, CircuitBreakerStateValue>
  unavailable?: Set<string>
  todaySpend?: Record<string, number>
  contextWindow?: Record<string, number>
}

function makeDeps(state: DepsState = {}): RoutingEngineDeps {
  return {
    getHealthMetrics: (id) => state.metrics?.[id],
    getCircuitBreakerState: (id) => state.cb?.[id] ?? "closed",
    isProviderAvailable: (id) => !state.unavailable?.has(id),
    getPricing: (pid, mid) => state.pricing?.[`${pid}:${mid}`],
    ...(state.todaySpend ? { getTodaySpend: (id) => state.todaySpend?.[id] ?? 0 } : {}),
    ...(state.contextWindow
      ? { getContextWindow: (pid, mid) => state.contextWindow?.[`${pid}:${mid}`] ?? 100000 }
      : {}),
  }
}

function metric(
  providerId: string,
  partial: Partial<ProviderHealthMetrics> = {}
): ProviderHealthMetrics {
  return {
    providerId,
    totalRequests: 0,
    totalSuccesses: 0,
    totalErrors: 0,
    successRate: 1,
    latencyP50: 0,
    latencyP95: 0,
    latencyAvg: 0,
    totalCost: 0,
    uptimePercent: 1,
    lastRequestAt: null,
    lastErrorAt: null,
    latencyTrend: [],
    errorRateTrend: [],
    ...partial,
  }
}

describe("ProviderRoutingEngine", () => {
  describe("override paths", () => {
    it("returns force override directly without consulting the registry", () => {
      const engine = new ProviderRoutingEngine(registry([]), DEFAULT_ROUTING_CONFIG, makeDeps())
      const result = engine.selectProvider({
        override: { forceProvider: "openai", forceModel: "gpt-4o" },
      })
      expect(result).toEqual({
        providerId: "openai",
        modelId: "gpt-4o",
        strategy: DEFAULT_ROUTING_CONFIG.strategy,
        fromAlias: false,
        fallbackEntries: [],
        reason: "Force override",
      })
    })

    it("uses override.modelAlias to drive resolution", () => {
      const reg = registry([
        mapping("fast", [entry("groq", "llama"), entry("openai", "gpt-4o-mini")]),
      ])
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "balanced" },
        makeDeps()
      )
      const result = engine.selectProvider({
        override: { modelAlias: "fast", strategy: "quality" },
      })
      expect(result).not.toBeNull()
      expect(result?.fromAlias).toBe(true)
      expect(result?.alias).toBe("fast")
      // quality = first entry
      expect(result?.providerId).toBe("groq")
      expect(result?.strategy).toBe("quality")
    })
  })

  describe("alias resolution -> direct fallthrough", () => {
    it("falls through to direct provider:model when the alias does not match", () => {
      const reg = registry([mapping("fast", [entry("groq", "llama")])])
      const engine = new ProviderRoutingEngine(reg, DEFAULT_ROUTING_CONFIG, makeDeps())
      const result = engine.selectProvider({ provider: "openai", model: "gpt-4o" })
      // 'gpt-4o' isn't an alias, so it should fall through.
      expect(result).toEqual({
        providerId: "openai",
        modelId: "gpt-4o",
        strategy: DEFAULT_ROUTING_CONFIG.strategy,
        fromAlias: false,
        fallbackEntries: [],
        reason: "Direct provider:model specification",
      })
    })

    it("returns null when neither alias nor direct provider:model is supplied", () => {
      const engine = new ProviderRoutingEngine(registry([]), DEFAULT_ROUTING_CONFIG, makeDeps())
      expect(engine.selectProvider({})).toBeNull()
    })

    it("returns null when alias resolves but no entries are available", () => {
      const reg = registry([mapping("fast", [entry("openai", "gpt-4o")])])
      const engine = new ProviderRoutingEngine(
        reg,
        DEFAULT_ROUTING_CONFIG,
        makeDeps({ unavailable: new Set(["openai"]) })
      )
      expect(engine.selectProvider({ model: "fast" })).toBeNull()
    })

    it("skips entries with an open circuit breaker", () => {
      const reg = registry([mapping("fast", [entry("openai", "gpt-4o"), entry("groq", "llama")])])
      const engine = new ProviderRoutingEngine(
        reg,
        DEFAULT_ROUTING_CONFIG,
        makeDeps({ cb: { openai: "open" } })
      )
      const result = engine.selectProvider({ model: "fast" })
      expect(result?.providerId).toBe("groq")
    })
  })

  describe("strategies", () => {
    const entries: ModelMappingEntry[] = [
      entry("openai", "gpt-4o"),
      entry("anthropic", "claude"),
      entry("groq", "llama"),
    ]
    const reg = registry([mapping("alias", entries)])

    function engineFor(strategy: RoutingConfig["strategy"], state?: DepsState) {
      return new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy },
        makeDeps(state)
      )
    }

    it("quality picks the first entry in the chain", () => {
      const result = engineFor("quality").selectProvider({ model: "alias" })
      expect(result?.providerId).toBe("openai")
      expect(result?.fallbackEntries.map((e) => e.providerId)).toEqual(["anthropic", "groq"])
    })

    it("cost picks the cheapest entry by getPricing", () => {
      const result = engineFor("cost", {
        pricing: {
          "openai:gpt-4o": 5,
          "anthropic:claude": 8,
          "groq:llama": 0.5,
        },
      }).selectProvider({ model: "alias" })
      expect(result?.providerId).toBe("groq")
    })

    it("cost falls back to the first entry when no pricing is known", () => {
      const result = engineFor("cost").selectProvider({ model: "alias" })
      expect(result?.providerId).toBe("openai")
    })

    it("speed picks the lowest latencyP50", () => {
      const result = engineFor("speed", {
        metrics: {
          openai: metric("openai", { latencyP50: 1200 }),
          anthropic: metric("anthropic", { latencyP50: 400 }),
          groq: metric("groq", { latencyP50: 100 }),
        },
      }).selectProvider({ model: "alias" })
      expect(result?.providerId).toBe("groq")
    })

    it("speed falls back to first entry when no latency data exists", () => {
      const result = engineFor("speed").selectProvider({ model: "alias" })
      expect(result?.providerId).toBe("openai")
    })

    it("balanced combines success rate, latency, and cost", () => {
      // Groq has the cheapest pricing AND fastest latency AND best success rate.
      const result = engineFor("balanced", {
        pricing: {
          "openai:gpt-4o": 30,
          "anthropic:claude": 25,
          "groq:llama": 1,
        },
        metrics: {
          openai: metric("openai", { successRate: 0.7, latencyP50: 5000 }),
          anthropic: metric("anthropic", { successRate: 0.8, latencyP50: 3000 }),
          groq: metric("groq", { successRate: 0.99, latencyP50: 200 }),
        },
      }).selectProvider({ model: "alias" })
      expect(result?.providerId).toBe("groq")
    })

    it("adaptive penalizes recent errors", () => {
      const now = Date.now()
      const result = engineFor("adaptive", {
        metrics: {
          openai: metric("openai", {
            successRate: 0.99,
            latencyP50: 100,
            lastErrorAt: now - 1000, // very recent error
          }),
          anthropic: metric("anthropic", {
            successRate: 0.95,
            latencyP50: 200,
            lastErrorAt: null,
          }),
          groq: metric("groq", {
            successRate: 0.9,
            latencyP50: 300,
            lastErrorAt: now - 1_000_000, // long ago
          }),
        },
      }).selectProvider({ model: "alias" })
      // openai has the best raw scores but the recent error penalty knocks it
      // out — anthropic should win because it has no error history.
      expect(result?.providerId).toBe("anthropic")
    })

    it("adaptive falls back to neutral scores when no metrics exist", () => {
      const result = engineFor("adaptive").selectProvider({ model: "alias" })
      // Without metrics every entry scores the same, so the first one wins by tie-break.
      expect(result?.providerId).toBe("openai")
    })

    it("returns the only entry when there is just one candidate", () => {
      const single = registry([mapping("solo", [entry("openai", "gpt-4o")])])
      const engine = new ProviderRoutingEngine(single, DEFAULT_ROUTING_CONFIG, makeDeps())
      expect(engine.selectProvider({ model: "solo" })?.providerId).toBe("openai")
    })

    it("treats unknown strategy values as quality (first entry)", () => {
      const engine = new ProviderRoutingEngine(
        reg,
        // Cast to bypass the union — the engine must still cope with unknown values.
        { ...DEFAULT_ROUTING_CONFIG, strategy: "weird" as unknown as RoutingConfig["strategy"] },
        makeDeps()
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("openai")
    })
  })

  describe("entry condition filtering (maxCostPer1M / maxLatencyMs)", () => {
    it("filters an entry whose price exceeds its maxCostPer1M condition", () => {
      const reg = registry([
        mapping("alias", [
          entry("openai", "gpt-4o", { conditions: { maxCostPer1M: 5 } }),
          entry("groq", "llama"),
        ]),
      ])
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps({ pricing: { "openai:gpt-4o": 10, "groq:llama": 1 } })
      )
      const result = engine.selectProvider({ model: "alias" })
      expect(result?.providerId).toBe("groq")
    })

    it("keeps an entry whose price is within its maxCostPer1M condition", () => {
      const reg = registry([
        mapping("alias", [
          entry("openai", "gpt-4o", { conditions: { maxCostPer1M: 5 } }),
          entry("groq", "llama"),
        ]),
      ])
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps({ pricing: { "openai:gpt-4o": 3 } })
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("openai")
    })

    it("filters an entry whose recent p50 latency exceeds maxLatencyMs", () => {
      const reg = registry([
        mapping("alias", [
          entry("openai", "gpt-4o", { conditions: { maxLatencyMs: 1000 } }),
          entry("groq", "llama"),
        ]),
      ])
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps({ metrics: { openai: metric("openai", { latencyP50: 2000 }) } })
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("groq")
    })

    it("keeps a latency-conditioned entry when no latency data exists (no-info passthrough)", () => {
      const reg = registry([
        mapping("alias", [
          entry("openai", "gpt-4o", { conditions: { maxLatencyMs: 1000 } }),
          entry("groq", "llama"),
        ]),
      ])
      // latencyP50: 0 means "no data yet" — the condition must not fire.
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps({ metrics: { openai: metric("openai", { latencyP50: 0 }) } })
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("openai")
    })

    it("keeps a cost-conditioned entry when pricing is unknown (no-info passthrough)", () => {
      const reg = registry([
        mapping("alias", [entry("openai", "gpt-4o", { conditions: { maxCostPer1M: 5 } })]),
      ])
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps()
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("openai")
    })

    it("returns null when conditions filter out every entry and no direct fallthrough exists", () => {
      const reg = registry([
        mapping("alias", [
          entry("openai", "gpt-4o", { conditions: { maxCostPer1M: 1 } }),
          entry("anthropic", "claude", { conditions: { maxCostPer1M: 1 } }),
        ]),
      ])
      const engine = new ProviderRoutingEngine(
        reg,
        DEFAULT_ROUTING_CONFIG,
        makeDeps({ pricing: { "openai:gpt-4o": 10, "anthropic:claude": 10 } })
      )
      expect(engine.selectProvider({ model: "alias" })).toBeNull()
    })
  })

  describe("context-window pre-check", () => {
    const reg = registry([
      mapping("alias", [entry("openai", "small"), entry("anthropic", "large")]),
    ])

    it("deprioritizes entries whose window cannot fit the estimated input", () => {
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps({ contextWindow: { "openai:small": 8000, "anthropic:large": 200000 } })
      )
      const result = engine.selectProvider({ model: "alias", estimatedInputTokens: 50000 })
      expect(result?.providerId).toBe("anthropic")
    })

    it("keeps the normal strategy order when everything fits", () => {
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps({ contextWindow: { "openai:small": 8000, "anthropic:large": 200000 } })
      )
      const result = engine.selectProvider({ model: "alias", estimatedInputTokens: 1000 })
      expect(result?.providerId).toBe("openai")
    })

    it("falls back to the largest-window entry when nothing fits (never dead-ends)", () => {
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps({ contextWindow: { "openai:small": 8000, "anthropic:large": 200000 } })
      )
      const result = engine.selectProvider({ model: "alias", estimatedInputTokens: 500000 })
      expect(result?.providerId).toBe("anthropic")
      expect(result?.reason).toContain("context window")
      // The smaller-window entry remains in the fallback chain.
      expect(result?.fallbackEntries.map((e) => e.providerId)).toEqual(["openai"])
    })

    it("skips the check entirely without an estimate or without the dep", () => {
      const withDep = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps({ contextWindow: { "openai:small": 8000, "anthropic:large": 200000 } })
      )
      expect(withDep.selectProvider({ model: "alias" })?.providerId).toBe("openai")

      const withoutDep = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps()
      )
      expect(
        withoutDep.selectProvider({ model: "alias", estimatedInputTokens: 500000 })?.providerId
      ).toBe("openai")
    })
  })

  describe("provider constraints", () => {
    const entries = [entry("openai", "gpt-4o"), entry("anthropic", "claude")]
    const reg = registry([mapping("alias", entries)])

    it("filters providers whose total cost has hit the daily budget", () => {
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [{ providerId: "openai", dailyCostBudget: 5, enabled: true }],
      }
      const engine = new ProviderRoutingEngine(
        reg,
        config,
        makeDeps({
          metrics: { openai: metric("openai", { totalCost: 10 }) },
        })
      )
      const result = engine.selectProvider({ model: "alias" })
      expect(result?.providerId).toBe("anthropic")
    })

    it("ignores disabled constraints", () => {
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [{ providerId: "openai", dailyCostBudget: 5, enabled: false }],
      }
      const engine = new ProviderRoutingEngine(
        reg,
        config,
        makeDeps({ metrics: { openai: metric("openai", { totalCost: 10 }) } })
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("openai")
    })

    it("ignores constraints whose providerId does not match any candidate entry", () => {
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [{ providerId: "groq", dailyCostBudget: 0.01, enabled: true }],
      }
      const engine = new ProviderRoutingEngine(
        reg,
        config,
        makeDeps({
          metrics: { openai: metric("openai", { totalCost: 100 }) },
        })
      )
      // openai has no constraint -> survives despite high totalCost.
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("openai")
    })

    it("keeps a constrained provider when no metrics are available", () => {
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [{ providerId: "openai", dailyCostBudget: 5, enabled: true }],
      }
      // No metrics at all — the engine cannot prove the budget was hit, so the
      // entry must survive.
      const engine = new ProviderRoutingEngine(reg, config, makeDeps())
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("openai")
    })

    it("falls back to the unconstrained candidates when constraints empty the set", () => {
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [
          { providerId: "openai", dailyCostBudget: 1, enabled: true },
          { providerId: "anthropic", dailyCostBudget: 1, enabled: true },
        ],
      }
      const engine = new ProviderRoutingEngine(
        reg,
        config,
        makeDeps({
          metrics: {
            openai: metric("openai", { totalCost: 10 }),
            anthropic: metric("anthropic", { totalCost: 10 }),
          },
        })
      )
      // Both blown the budget, so the engine must keep the original list rather than
      // returning null.
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("openai")
    })

    it("prefers the durable today-spend mirror over health metrics for budgets", () => {
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [{ providerId: "openai", dailyCostBudget: 5, enabled: true }],
      }
      const engine = new ProviderRoutingEngine(
        reg,
        config,
        makeDeps({
          // Mirror says 10 USD today (over budget) even though the in-memory
          // session metrics saw nothing — e.g. right after a reload.
          todaySpend: { openai: 10 },
          metrics: { openai: metric("openai", { totalCost: 0 }) },
        })
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("anthropic")
    })

    it("flags overBudgetWarning when the sole candidate is over budget", () => {
      const solo = registry([mapping("solo", [entry("openai", "gpt-4o")])])
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [{ providerId: "openai", dailyCostBudget: 5, enabled: true }],
      }
      const engine = new ProviderRoutingEngine(
        solo,
        config,
        makeDeps({ todaySpend: { openai: 7.5 } })
      )
      const result = engine.selectProvider({ model: "solo" })
      // Advisory semantics: still selected, but the warning rides along.
      expect(result?.providerId).toBe("openai")
      expect(result?.overBudgetWarning).toEqual({ providerId: "openai", spend: 7.5, budget: 5 })
    })

    it("does not flag a warning when an under-budget alternative was chosen", () => {
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [{ providerId: "openai", dailyCostBudget: 5, enabled: true }],
      }
      const engine = new ProviderRoutingEngine(
        reg,
        config,
        makeDeps({ todaySpend: { openai: 10 } })
      )
      const result = engine.selectProvider({ model: "alias" })
      expect(result?.providerId).toBe("anthropic")
      expect(result?.overBudgetWarning).toBeUndefined()
    })
  })
})
