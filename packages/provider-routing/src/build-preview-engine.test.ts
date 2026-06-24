// Coverage for the shared routing-engine factory — deps read the live
// in-memory stores + given settings; selection answers "what would the next
// send pick right now" with zero side effects.

import { buildRoutingEngine, buildRoutingEngineDeps } from "./build-preview-engine"
import {
  resetProviderRoutingRuntimeAdaptersForTesting,
  setProviderRoutingRuntimeAdapters,
} from "./runtime-adapters"
import type { CircuitBreakerStateValue } from "@cognia/provider-types/circuit-breaker"
import type { ProviderHealthMetrics } from "@cognia/provider-types/health-metrics"
import type { ModelMapping } from "@cognia/provider-types/model-mapping"
import type { UserProviderSettings } from "@cognia/provider-types/provider"

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

const health = (
  providerId: string,
  overrides: Partial<ProviderHealthMetrics> = {}
): ProviderHealthMetrics => ({
  providerId,
  totalRequests: 1,
  totalSuccesses: 1,
  totalErrors: 0,
  successRate: 1,
  latencyP50: 100,
  latencyP95: 100,
  latencyAvg: 100,
  totalCost: 0,
  uptimePercent: 1,
  lastRequestAt: 1,
  lastErrorAt: null,
  latencyTrend: [],
  errorRateTrend: [],
  ...overrides,
})

let providerHealth: Record<string, ProviderHealthMetrics | undefined>
let deploymentHealth: Record<string, ProviderHealthMetrics | undefined>
let providerCircuit: Record<string, CircuitBreakerStateValue>
let deploymentCircuit: Record<string, CircuitBreakerStateValue>
let todaySpend: Record<string, number>
let providerRate: Record<string, { rpm: number; tpm: number }>
let deploymentRate: Record<string, { rpm: number; tpm: number }>
let providerInFlight: Record<string, number>
let deploymentInFlight: Record<string, number>
let providerConfigs: Record<string, unknown>
let circuitEnabled: boolean
let circuitSettings: Record<string, unknown>
let configUpdates: Array<[string, unknown]>

beforeEach(() => {
  resetProviderRoutingRuntimeAdaptersForTesting()
  providerHealth = {}
  deploymentHealth = {}
  providerCircuit = {}
  deploymentCircuit = {}
  todaySpend = {}
  providerRate = {}
  deploymentRate = {}
  providerInFlight = {}
  deploymentInFlight = {}
  providerConfigs = {}
  circuitEnabled = false
  circuitSettings = {}
  configUpdates = []
  setProviderRoutingRuntimeAdapters({
    getHealthMetrics: (id) => providerHealth[id],
    getDeploymentHealth: (key) => deploymentHealth[key],
    getCircuitBreakerState: (id) => providerCircuit[id] ?? "closed",
    getDeploymentCircuitBreakerState: (key) => deploymentCircuit[key] ?? "closed",
    isCircuitBreakerAvailable: (id) => (providerCircuit[id] ?? "closed") !== "open",
    getTodaySpend: (id) => todaySpend[id] ?? 0,
    getRate: (id) => providerRate[id] ?? { rpm: 0, tpm: 0 },
    getDeploymentRate: (key) => deploymentRate[key] ?? { rpm: 0, tpm: 0 },
    getInFlight: (id) => providerInFlight[id] ?? 0,
    getDeploymentInFlight: (key) => deploymentInFlight[key] ?? 0,
    updateCircuitConfig: (providerId, config) => {
      configUpdates.push([providerId, config])
      providerConfigs[providerId] = config
    },
    setCircuitBreakerEnabled: (enabled) => {
      circuitEnabled = enabled
    },
    setCircuitBreakerSettings: (settings) => {
      circuitSettings = { ...circuitSettings, ...settings }
    },
  })
})

afterEach(() => {
  resetProviderRoutingRuntimeAdaptersForTesting()
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
    todaySpend.openai = 4.2
    const deps = buildRoutingEngineDeps({})
    expect(deps.getTodaySpend?.("openai")).toBeCloseTo(4.2)
  })

  it("reads the trailing-minute rate from the rate store", () => {
    providerRate.openai = { rpm: 1, tpm: 500 }
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
    providerHealth.openai = health("openai", { latencyP50: 120 })
    const deps = buildRoutingEngineDeps({})
    expect(deps.getHealthMetrics("openai")?.totalRequests).toBe(1)
  })

  it("wires deployment-level accessors to the live stores", () => {
    deploymentHealth["openai::gpt-4o"] = health("openai")
    deploymentRate["openai::gpt-4o"] = { rpm: 1, tpm: 500 }
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
    providerCircuit.openai = "open"
    const deps = buildRoutingEngineDeps({ providerSettings: { openai: ps("openai") } })
    expect(deps.getCircuitBreakerState("openai")).toBe("open")
    expect(deps.isProviderAvailable("openai")).toBe(false)
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
    expect(configUpdates).toEqual([["openai", { failureThreshold: 2, cooldownMs: 5000 }]])
    // Empty list is a fast no-op.
    applyCircuitConfigOverrides([])
    expect(configUpdates).toHaveLength(1)
  })
})

describe("applyCircuitBreakerSettings", () => {
  const baseConfig = {
    strategy: "balanced" as const,
    allowPerRequestOverride: true,
    providerConstraints: [],
    requestTimeoutMs: 30000,
    maxFallbackAttempts: 3,
  }

  it("hydrates global enable + defaults from the persisted block", async () => {
    const { applyCircuitBreakerSettings } = await import("./build-preview-engine")
    applyCircuitBreakerSettings({
      ...baseConfig,
      circuitBreaker: { enabled: true, failureThreshold: 2, failureRateThreshold: 0.4 },
    })
    expect(circuitEnabled).toBe(true)
    expect(circuitSettings.failureThreshold).toBe(2)
    expect(circuitSettings.failureRateThreshold).toBe(0.4)
    // Disable flows through too.
    applyCircuitBreakerSettings({ ...baseConfig, circuitBreaker: { enabled: false } })
    expect(circuitEnabled).toBe(false)
  })

  it("ships enabled with conservative thresholds in DEFAULT_ROUTING_CONFIG", async () => {
    const { applyCircuitBreakerSettings } = await import("./build-preview-engine")
    const { DEFAULT_ROUTING_CONFIG } = await import("@cognia/provider-types/model-mapping")
    expect(DEFAULT_ROUTING_CONFIG.circuitBreaker).toBeDefined()
    expect(DEFAULT_ROUTING_CONFIG.circuitBreaker?.enabled).toBe(true)
    expect(DEFAULT_ROUTING_CONFIG.circuitBreaker?.failureRateThreshold).toBe(0.5)
    expect(DEFAULT_ROUTING_CONFIG.circuitBreaker?.minRequestVolume).toBe(10)
    circuitEnabled = false
    applyCircuitBreakerSettings(DEFAULT_ROUTING_CONFIG)
    expect(circuitEnabled).toBe(true)
  })

  it("leaves the store untouched when no circuitBreaker block is persisted", async () => {
    const { applyCircuitBreakerSettings } = await import("./build-preview-engine")
    circuitEnabled = true
    applyCircuitBreakerSettings(baseConfig)
    expect(circuitEnabled).toBe(true)
  })

  it("still applies per-provider constraint overrides", async () => {
    const { applyCircuitBreakerSettings } = await import("./build-preview-engine")
    applyCircuitBreakerSettings({
      ...baseConfig,
      circuitBreaker: { enabled: true },
      providerConstraints: [
        { providerId: "openai", enabled: true, circuitConfig: { failureThreshold: 1 } },
      ],
    })
    expect(providerConfigs.openai).toEqual({ failureThreshold: 1 })
  })
})
