import {
  ProviderRoutingEngine,
  RoutingNoCandidatesError,
  type RoutingEngineDeps,
} from "./provider-routing-engine"
import {
  DEFAULT_ROUTING_CONFIG,
  type ModelMapping,
  type ModelMappingEntry,
  type ModelMappingRegistry,
  type RoutingConfig,
} from "@cognia/provider-types/model-mapping"
import type { ProviderHealthMetrics } from "@cognia/provider-types/health-metrics"
import type { CircuitBreakerStateValue } from "@cognia/provider-types/circuit-breaker"
import type { RoutingCandidateCapabilities } from "@cognia/provider-types/auto-router"
import { registerRoutingStrategy, unregisterRoutingStrategy } from "./strategy-registry"
import { registerDeploymentFilter, unregisterDeploymentFilter } from "./filter-registry"

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
  /** Deployment-level breaker states keyed by `providerId::modelId`. */
  deploymentCb?: Record<string, CircuitBreakerStateValue>
  unavailable?: Set<string>
  todaySpend?: Record<string, number>
  contextWindow?: Record<string, number>
  rate?: Record<string, { rpm: number; tpm: number }>
  /** Session → pinned deployment key (affinity filter). */
  pins?: Record<string, string>
  released?: string[]
  candidates?: ModelMappingEntry[]
  capabilities?: Record<string, RoutingCandidateCapabilities | undefined>
  localProviders?: Set<string>
  deploymentMetrics?: Record<string, ProviderHealthMetrics>
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
    ...(state.rate ? { getRate: (id) => state.rate?.[id] ?? { rpm: 0, tpm: 0 } } : {}),
    ...(state.deploymentCb
      ? { getDeploymentCircuitBreakerState: (key) => state.deploymentCb?.[key] ?? "closed" }
      : {}),
    ...(state.pins
      ? {
          getSessionDeployment: (sessionId) => state.pins?.[sessionId],
          releaseSessionDeployment: (sessionId) => state.released?.push(sessionId),
        }
      : {}),
    ...(state.candidates ? { listCandidates: () => state.candidates ?? [] } : {}),
    ...(state.capabilities
      ? {
          getCapabilities: (providerId, modelId) =>
            state.capabilities?.[`${providerId}:${modelId}`],
        }
      : {}),
    ...(state.localProviders
      ? { isLocalProvider: (providerId) => state.localProviders?.has(providerId) ?? false }
      : {}),
    ...(state.deploymentMetrics
      ? { getDeploymentHealth: (key) => state.deploymentMetrics?.[key] }
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

    it("throws RoutingNoCandidatesError when the alias matched but every entry is unavailable", () => {
      // Contract: `null` is reserved for the no-alias passthrough. An alias
      // that matched but emptied through the filter chain throws so callers
      // surface a clear error instead of passing the alias through as a
      // model id (which would fail downstream with a worse message).
      const reg = registry([mapping("fast", [entry("openai", "gpt-4o")])])
      const engine = new ProviderRoutingEngine(
        reg,
        DEFAULT_ROUTING_CONFIG,
        makeDeps({ unavailable: new Set(["openai"]) })
      )
      expect(() => engine.selectProvider({ model: "fast" })).toThrow(RoutingNoCandidatesError)
      expect(() => engine.selectProvider({ model: "fast" })).toThrow(/fast/)
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

    it("deprioritizes a provider at its RPM ceiling", () => {
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [{ providerId: "openai", maxRequestsPerMinute: 10, enabled: true }],
      }
      const engine = new ProviderRoutingEngine(
        reg,
        config,
        makeDeps({ rate: { openai: { rpm: 10, tpm: 0 } } })
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("anthropic")
    })

    it("deprioritizes a provider at its TPM ceiling", () => {
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [{ providerId: "openai", maxTokensPerMinute: 50_000, enabled: true }],
      }
      const engine = new ProviderRoutingEngine(
        reg,
        config,
        makeDeps({ rate: { openai: { rpm: 1, tpm: 60_000 } } })
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("anthropic")
    })

    it("keeps a provider under its rate ceiling", () => {
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [
          {
            providerId: "openai",
            maxRequestsPerMinute: 10,
            maxTokensPerMinute: 50_000,
            enabled: true,
          },
        ],
      }
      const engine = new ProviderRoutingEngine(
        reg,
        config,
        makeDeps({ rate: { openai: { rpm: 3, tpm: 1000 } } })
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("openai")
    })

    it("still selects a rate-limited provider when it is the only candidate (advisory)", () => {
      const solo = registry([mapping("solo", [entry("openai", "gpt-4o")])])
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [{ providerId: "openai", maxRequestsPerMinute: 5, enabled: true }],
      }
      const engine = new ProviderRoutingEngine(
        solo,
        config,
        makeDeps({ rate: { openai: { rpm: 99, tpm: 0 } } })
      )
      const result = engine.selectProvider({ model: "solo" })
      expect(result?.providerId).toBe("openai")
      // Rate limiting carries no warning (recovers within a minute).
      expect(result?.overBudgetWarning).toBeUndefined()
    })

    it("skips the rate check when the getRate dep is absent", () => {
      const config: RoutingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        strategy: "quality",
        providerConstraints: [{ providerId: "openai", maxRequestsPerMinute: 1, enabled: true }],
      }
      const engine = new ProviderRoutingEngine(reg, config, makeDeps())
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("openai")
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

  describe("deployment-level circuit breaker", () => {
    it("drops only the open deployment, not the whole provider", () => {
      const reg = registry([
        mapping("alias", [entry("openai", "gpt-4o"), entry("openai", "gpt-4o-mini")]),
      ])
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps({ deploymentCb: { "openai::gpt-4o": "open" } })
      )
      const result = engine.selectProvider({ model: "alias" })
      expect(result?.modelId).toBe("gpt-4o-mini")
    })

    it("falls back to the provider-level breaker when no deployment dep is wired", () => {
      const reg = registry([mapping("alias", [entry("openai", "gpt-4o"), entry("groq", "llama")])])
      const engine = new ProviderRoutingEngine(
        reg,
        DEFAULT_ROUTING_CONFIG,
        makeDeps({ cb: { openai: "open" } })
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("groq")
    })
  })

  describe("session affinity", () => {
    const reg = registry([
      mapping("alias", [
        entry("openai", "gpt-4o"),
        entry("groq", "llama"),
        entry("anthropic", "claude"),
      ]),
    ])

    it("a healthy pin wins selection and bypasses the strategy", () => {
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "cost" },
        makeDeps({
          pins: { s1: "groq::llama" },
          // cost strategy would pick anthropic, but the pin wins.
          pricing: { "openai:gpt-4o": 10, "groq:llama": 5, "anthropic:claude": 1 },
        })
      )
      const result = engine.selectProvider({ model: "alias", sessionId: "s1" })
      expect(result?.providerId).toBe("groq")
      expect(result?.reason).toContain("affinity")
      expect(result?.filterNotes?.affinityPinned).toBe("groq::llama")
      // Every other candidate stays in the fallback chain (soft pin).
      expect(result?.fallbackEntries).toHaveLength(2)
    })

    it("releases an unhealthy pin and falls back to the strategy", () => {
      const released: string[] = []
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps({
          pins: { s1: "groq::llama" },
          deploymentCb: { "groq::llama": "open" },
          released,
        })
      )
      const result = engine.selectProvider({ model: "alias", sessionId: "s1" })
      // Pin's deployment is open → released + circuit filter also drops it.
      expect(result?.providerId).toBe("openai")
      expect(released).toEqual(["s1"])
      expect(result?.filterNotes?.affinityPinned).toBeUndefined()
    })

    it("ignores pins targeting a deployment outside the alias pool", () => {
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps({ pins: { s1: "elsewhere::other-model" } })
      )
      const result = engine.selectProvider({ model: "alias", sessionId: "s1" })
      expect(result?.providerId).toBe("openai") // quality = first entry
    })

    it("is inert without a sessionId", () => {
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps({ pins: { s1: "groq::llama" } })
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("openai")
    })
  })

  describe("configurable filter chain", () => {
    it("an explicit filterChain replaces the default (circuit check removable)", () => {
      const reg = registry([mapping("alias", [entry("openai", "gpt-4o"), entry("groq", "llama")])])
      const engine = new ProviderRoutingEngine(
        reg,
        // Only the budget filter runs — the open breaker is never consulted.
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality", filterChain: ["budget"] },
        makeDeps({ cb: { openai: "open" } })
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("openai")
    })

    it("unknown filter ids in the chain are skipped", () => {
      const reg = registry([mapping("alias", [entry("openai", "gpt-4o"), entry("groq", "llama")])])
      const engine = new ProviderRoutingEngine(
        reg,
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality", filterChain: ["ghost", "circuit"] },
        makeDeps({ cb: { openai: "open" } })
      )
      expect(engine.selectProvider({ model: "alias" })?.providerId).toBe("groq")
    })

    it("reports which filters pruned candidates via filterNotes", () => {
      const reg = registry([mapping("alias", [entry("openai", "gpt-4o"), entry("groq", "llama")])])
      const engine = new ProviderRoutingEngine(
        reg,
        DEFAULT_ROUTING_CONFIG,
        makeDeps({ cb: { openai: "open" } })
      )
      const result = engine.selectProvider({ model: "alias" })
      expect(result?.filterNotes?.prunedBy).toEqual(["circuit"])
    })
  })

  describe("unified routing plan", () => {
    it("keeps a concrete model as a single-candidate manual override", async () => {
      const engine = new ProviderRoutingEngine(
        registry([mapping("gpt-test", [entry("groq", "other")])]),
        DEFAULT_ROUTING_CONFIG,
        makeDeps()
      )

      const plan = await engine.planRoute({
        surface: "chat",
        selection: { kind: "manual", providerId: "openai", modelId: "gpt-test" },
      })

      expect(plan.requested.kind).toBe("manual")
      expect(plan.selected).toMatchObject({
        providerId: "openai",
        modelId: "gpt-test",
        reasonCodes: ["manual-override"],
      })
      expect(plan.orderedCandidates).toHaveLength(1)
    })

    it("uses configured Auto thresholds and degrades to an enabled tier", async () => {
      const engine = new ProviderRoutingEngine(
        registry([
          mapping("fast", [entry("openai", "small")]),
          mapping("powerful", [entry("anthropic", "large")]),
        ]),
        { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
        makeDeps()
      )

      const hard = await engine.planRoute({
        surface: "chat",
        selection: { kind: "auto" },
        promptText:
          "```ts\nsolve()\n``` Analyze and prove this algorithm step by step, then optimize it.",
        candidateAliases: ["fast", "balanced", "powerful"],
        thresholds: { balanced: 0.1, powerful: 0.2 },
      })
      const moderateWithMissingMiddle = await engine.planRoute({
        surface: "chat",
        selection: { kind: "auto" },
        promptText: "`code` analyze",
        candidateAliases: ["fast", "balanced", "powerful"],
        thresholds: { balanced: 0.1, powerful: 0.9 },
      })

      expect(hard.selected).toMatchObject({ providerId: "anthropic", modelId: "large" })
      expect(moderateWithMissingMiddle.selected).toMatchObject({
        providerId: "openai",
        modelId: "small",
      })
    })

    it("fails a manual override that violates a declared hard capability", async () => {
      const engine = new ProviderRoutingEngine(
        registry([]),
        DEFAULT_ROUTING_CONFIG,
        makeDeps({ capabilities: { "openai:text": { vision: false } } })
      )

      await expect(
        engine.planRoute({
          surface: "chat",
          selection: { kind: "manual", providerId: "openai", modelId: "text" },
          requirements: { vision: true },
        })
      ).rejects.toBeInstanceOf(RoutingNoCandidatesError)
    })

    it("returns one ordered alias chain with the primary at index zero", async () => {
      const engine = new ProviderRoutingEngine(
        registry([
          mapping("fast", [
            entry("openai", "expensive"),
            entry("groq", "cheap"),
            entry("anthropic", "backup"),
          ]),
        ]),
        { ...DEFAULT_ROUTING_CONFIG, strategy: "cost" },
        makeDeps({
          pricing: {
            "openai:expensive": 20,
            "groq:cheap": 1,
            "anthropic:backup": 5,
          },
        })
      )

      const plan = await engine.planRoute({
        surface: "workflow",
        selection: { kind: "alias", alias: "fast" },
      })

      expect(plan.selected.providerId).toBe("groq")
      expect(plan.orderedCandidates.map((candidate) => candidate.providerId)).toEqual([
        "groq",
        "openai",
        "anthropic",
      ])
      expect(plan.orderedCandidates[0]).toBe(plan.selected)
      expect(plan.replayPolicy).toBe("pre-commit-only")
    })

    it.each(["chat", "gateway", "workflow", "council"] as const)(
      "keeps equivalent request ordering identical on the %s surface",
      async (surface) => {
        const engine = new ProviderRoutingEngine(
          registry([
            mapping("fast", [
              entry("openai", "primary"),
              entry("groq", "cheap"),
              entry("anthropic", "backup"),
            ]),
          ]),
          { ...DEFAULT_ROUTING_CONFIG, strategy: "cost" },
          makeDeps({
            pricing: {
              "openai:primary": 10,
              "groq:cheap": 1,
              "anthropic:backup": 5,
            },
          })
        )

        const plan = await engine.planRoute({
          surface,
          selection: { kind: "alias", alias: "fast" },
        })
        expect(
          plan.orderedCandidates.map(({ providerId, modelId }) => `${providerId}:${modelId}`)
        ).toEqual(["groq:cheap", "openai:primary", "anthropic:backup"])
      }
    )

    it("fails closed when a required capability is unknown and enforces local-only", async () => {
      const candidates = [
        entry("openai", "unknown"),
        entry("ollama", "vision"),
        entry("ollama", "text"),
      ]
      const engine = new ProviderRoutingEngine(
        registry([mapping("vision", candidates)]),
        DEFAULT_ROUTING_CONFIG,
        makeDeps({
          capabilities: {
            "openai:unknown": undefined,
            "ollama:vision": { vision: true, streaming: true, contextTokens: 32_000 },
            "ollama:text": { vision: false, streaming: true, contextTokens: 32_000 },
          },
          localProviders: new Set(["ollama"]),
        })
      )

      const plan = await engine.planRoute({
        surface: "chat",
        selection: { kind: "alias", alias: "vision" },
        requirements: { vision: true, streaming: true },
        dataPolicy: { locality: "local-only" },
      })

      expect(plan.orderedCandidates).toHaveLength(1)
      expect(plan.selected).toMatchObject({ providerId: "ollama", modelId: "vision" })
      expect(plan.rejected).toEqual(
        expect.arrayContaining([
          { reasonCode: "capability-required", count: 1 },
          { reasonCode: "data-policy", count: 1 },
        ])
      )
    })

    it("awaits asynchronous plugin strategies and falls back after the plugin budget", async () => {
      registerRoutingStrategy({
        id: "test:async",
        select: (entries) => entries[0] ?? null,
        selectAsync: async (entries) => entries[1] ?? null,
      })
      registerRoutingStrategy({
        id: "test:timeout",
        select: (entries) => entries[0] ?? null,
        selectAsync: () => new Promise(() => undefined),
      })
      const engine = new ProviderRoutingEngine(
        registry([mapping("alias", [entry("openai", "first"), entry("groq", "second")])]),
        { ...DEFAULT_ROUTING_CONFIG, pluginTimeoutMs: 5 },
        makeDeps()
      )

      try {
        const asyncPlan = await engine.planRoute({
          surface: "gateway",
          selection: { kind: "alias", alias: "alias" },
          strategy: "test:async",
          shadowMode: true,
        })
        expect(asyncPlan.selected.providerId).toBe("groq")
        expect(asyncPlan.shadowComparison).toEqual({
          differs: true,
          selected: { providerId: "openai", modelId: "first" },
        })

        const timedOutPlan = await engine.planRoute({
          surface: "gateway",
          selection: { kind: "alias", alias: "alias" },
          strategy: "test:timeout",
        })
        expect(timedOutPlan.selected.providerId).toBe("openai")
        expect(timedOutPlan.reasonCodes).toContain("plugin-timeout")
      } finally {
        unregisterRoutingStrategy("test:async")
        unregisterRoutingStrategy("test:timeout")
      }
    })

    it("awaits asynchronous plugin filters and reports timeout without dropping safe candidates", async () => {
      registerDeploymentFilter({
        id: "test:async-filter",
        filter: (candidates) => ({ candidates: [...candidates] }),
        filterAsync: async (candidates) => ({ candidates: candidates.slice(1) }),
      })
      registerDeploymentFilter({
        id: "test:timeout-filter",
        filter: (candidates) => ({ candidates: [...candidates] }),
        filterAsync: () => new Promise(() => undefined),
      })
      const engine = new ProviderRoutingEngine(
        registry([mapping("alias", [entry("openai", "first"), entry("groq", "second")])]),
        {
          ...DEFAULT_ROUTING_CONFIG,
          filterChain: ["test:async-filter", "test:timeout-filter"],
          pluginTimeoutMs: 5,
        },
        makeDeps()
      )

      try {
        const plan = await engine.planRoute({
          surface: "gateway",
          selection: { kind: "alias", alias: "alias" },
        })
        expect(plan.selected).toMatchObject({ providerId: "groq", modelId: "second" })
        expect(plan.filterNotes?.prunedBy).toEqual(["test:async-filter"])
        expect(plan.filterNotes?.filterErrors).toContainEqual({
          filterId: "test:timeout-filter",
          kind: "timeout",
        })
        expect(plan.reasonCodes).toContain("plugin-timeout")
      } finally {
        unregisterDeploymentFilter("test:async-filter")
        unregisterDeploymentFilter("test:timeout-filter")
      }
    })
  })
})
