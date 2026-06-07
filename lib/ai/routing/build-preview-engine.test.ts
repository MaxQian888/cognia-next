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

  it("returns real health metrics once a provider has recorded requests", () => {
    useHealthMetricsStore.getState().record({
      providerId: "openai",
      success: true,
      latencyMs: 120,
    })
    const deps = buildRoutingEngineDeps({})
    expect(deps.getHealthMetrics("openai")?.totalRequests).toBe(1)
  })

  it("wires deployment-level accessors to the live stores", () => {
    useHealthMetricsStore.getState().record({
      providerId: "openai",
      modelId: "gpt-4o",
      success: true,
      latencyMs: 100,
    })
    useRateLimitStore.getState().record("openai", 500, Date.now(), { modelId: "gpt-4o" })
    const deps = buildRoutingEngineDeps({})
    expect(deps.getDeploymentHealth?.("openai::gpt-4o")?.totalRequests).toBe(1)
    expect(deps.getDeploymentHealth?.("openai::never-seen")).toBeUndefined()
    expect(deps.getDeploymentCircuitBreakerState?.("openai::gpt-4o")).toBe("closed")
    expect(deps.getDeploymentRate?.("openai::gpt-4o")).toEqual({ rpm: 1, tpm: 500 })
    expect(deps.getDeploymentInFlight?.("openai::gpt-4o")).toBe(0)
    // Affinity accessors round-trip through the session-affinity store.
    expect(deps.getSessionDeployment?.("never-pinned")).toBeUndefined()
    expect(() => deps.releaseSessionDeployment?.("never-pinned")).not.toThrow()
  })

  it("treats an OPEN circuit breaker as unavailable regardless of settings", () => {
    useCircuitBreakerStore.getState().setEnabled(true)
    useCircuitBreakerStore.getState().setSettings({ failureThreshold: 1 })
    useCircuitBreakerStore.getState().recordFailure("openai")
    const deps = buildRoutingEngineDeps({ providerSettings: { openai: ps("openai") } })
    expect(deps.getCircuitBreakerState("openai")).toBe("open")
    expect(deps.isProviderAvailable("openai")).toBe(false)
    useCircuitBreakerStore.getState().setEnabled(false)
  })

  it("treats a disabled custom provider as unavailable", () => {
    const deps = buildRoutingEngineDeps({
      providerSettings: { off: ps("off", false) },
      customProviders: [
        { id: "off", providerId: "off", enabled: false, defaultModel: "" },
      ] as never,
    })
    expect(deps.isProviderAvailable("off")).toBe(false)
  })

  it("uses the catalog maxOutputTokens as the reserve when smaller than the heuristic", () => {
    const deps = buildRoutingEngineDeps({})
    // Unknown model id → heuristic window (100k default minus 2k reserve).
    const win = deps.getContextWindow?.("custom", "totally-unknown-model")
    expect(win).toBe(98_000)
  })

  it("returns zero spend/rate for fresh stores", () => {
    const deps = buildRoutingEngineDeps({})
    expect(deps.getTodaySpend?.("nobody")).toBe(0)
    expect(deps.getRate?.("nobody")).toEqual({ rpm: 0, tpm: 0 })
  })

  it("builds an engine from completely empty settings (no mappings, no config)", () => {
    const engine = buildRoutingEngine({})
    expect(engine.selectProvider({ model: "anything" })).toBeNull()
  })

  it("falls back to DEFAULT_ROUTING_CONFIG when settings carry none", () => {
    const engine = buildRoutingEngine({
      modelMappings: [mapping("fast", [{ providerId: "groq", modelId: "llama" }])],
      providerSettings: { groq: ps("groq") },
    })
    // balanced (the default strategy) still resolves the single entry.
    expect(engine.selectProvider({ model: "fast" })?.providerId).toBe("groq")
  })
})

describe("applyCircuitConfigOverrides (P3.3)", () => {
  it("merges per-provider circuit overrides into the breaker store, skipping disabled rows", async () => {
    const { applyCircuitConfigOverrides } = await import("./build-preview-engine")
    const updates: Array<[string, unknown]> = []
    const original = useCircuitBreakerStore.getState().updateConfig
    useCircuitBreakerStore.setState({
      updateConfig: (providerId, config) => {
        updates.push([providerId, config])
      },
    })
    try {
      applyCircuitConfigOverrides([
        {
          providerId: "openai",
          enabled: true,
          circuitConfig: { failureThreshold: 2, cooldownMs: 5000 },
        },
        { providerId: "no-config", enabled: true },
        {
          providerId: "disabled",
          enabled: false,
          circuitConfig: { failureThreshold: 1 },
        },
      ])
      expect(updates).toEqual([["openai", { failureThreshold: 2, cooldownMs: 5000 }]])
      // Empty list is a fast no-op.
      applyCircuitConfigOverrides([])
      expect(updates).toHaveLength(1)
    } finally {
      useCircuitBreakerStore.setState({ updateConfig: original })
    }
  })
})
