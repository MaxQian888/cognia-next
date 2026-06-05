// Coverage for the shared routing-engine factory — deps read the live
// in-memory stores + given settings; selection answers "what would the next
// send pick right now" with zero side effects.

import { buildRoutingEngine, buildRoutingEngineDeps } from "./build-preview-engine"
import { useHealthMetricsStore } from "@/stores/settings/health-metrics-store"
import { useCircuitBreakerStore } from "@/stores/settings/circuit-breaker-store"
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"
import { useRateLimitStore } from "@/stores/settings/rate-limit-store"
import type { ModelMapping } from "@/types/provider/model-mapping"
import type { UserProviderSettings } from "@/types/provider/provider"

const mapping = (alias: string, providers: ModelMapping["providers"]): ModelMapping => ({
  id: `m-${alias}`,
  alias,
  providers,
  distribution: "priority",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
})

const ps = (id: string, enabled = true): UserProviderSettings =>
  ({ providerId: id, enabled, defaultModel: "" }) as UserProviderSettings

beforeEach(() => {
  useHealthMetricsStore.getState().resetAll()
  useCircuitBreakerStore.getState().resetAll()
  useProviderCostMirrorStore.getState().reset()
  useRateLimitStore.getState().reset()
})

describe("buildRoutingEngine", () => {
  it("resolves an alias through the live engine (quality = first entry)", () => {
    const engine = buildRoutingEngine({
      modelMappings: [
        mapping("fast", [
          { providerId: "groq", modelId: "llama-3.3-70b-versatile" },
          { providerId: "openai", modelId: "gpt-4o-mini" },
        ]),
      ],
      routingConfig: {
        strategy: "quality",
        allowPerRequestOverride: true,
        providerConstraints: [],
        requestTimeoutMs: 30000,
        maxFallbackAttempts: 3,
      },
      providerSettings: { groq: ps("groq"), openai: ps("openai") },
      customProviders: [],
    })
    const result = engine.selectProvider({ model: "fast" })
    expect(result?.providerId).toBe("groq")
    expect(result?.fallbackEntries).toHaveLength(1)
  })

  it("returns null for an unknown alias without provider/model fallthrough", () => {
    const engine = buildRoutingEngine({ modelMappings: [] })
    expect(engine.selectProvider({ model: "nope" })).toBeNull()
  })
})

describe("buildRoutingEngineDeps", () => {
  it("treats a provider with an explicit enabled:false as unavailable", () => {
    const deps = buildRoutingEngineDeps({
      providerSettings: { openai: ps("openai", false) },
      customProviders: [],
    })
    expect(deps.isProviderAvailable("openai")).toBe(false)
    expect(deps.isProviderAvailable("anthropic")).toBe(true)
  })

  it("treats an enabled custom provider as available", () => {
    const deps = buildRoutingEngineDeps({
      providerSettings: {},
      customProviders: [
        { id: "my-local", providerId: "my-local", enabled: true, defaultModel: "" },
      ] as never,
    })
    expect(deps.isProviderAvailable("my-local")).toBe(true)
  })

  it("reads today's spend from the cost mirror", () => {
    useProviderCostMirrorStore.getState().hydrate({ openai: 4.2 }, "2026-06-05")
    const deps = buildRoutingEngineDeps({})
    expect(deps.getTodaySpend?.("openai")).toBeCloseTo(4.2)
  })

  it("reads the trailing-minute rate from the rate store", () => {
    useRateLimitStore.getState().record("openai", 500, Date.now())
    const deps = buildRoutingEngineDeps({})
    expect(deps.getRate?.("openai").rpm).toBe(1)
  })

  it("resolves a usable context window (raw minus reserve, never negative)", () => {
    const deps = buildRoutingEngineDeps({})
    const win = deps.getContextWindow?.("openai", "gpt-4o")
    // gpt-4o: 128000 raw, 8000 reserve heuristic.
    expect(win).toBeGreaterThan(100000)
    expect(win).toBeLessThan(128000)
  })

  it("reports no-info health metrics for an unseen provider", () => {
    const deps = buildRoutingEngineDeps({})
    expect(deps.getHealthMetrics("never-seen")).toBeUndefined()
  })
})
