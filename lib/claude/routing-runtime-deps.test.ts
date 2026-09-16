/**
 * Regression coverage for the routing runtime-adapter bridge. The defect this
 * guards against: telemetry/settings are written to the live stores every turn
 * but the engine read inert defaults because nothing installed these adapters
 * (the `75de5d7a` refactor). Each getter here MUST reflect a live store mutation.
 */

import { buildRoutingRuntimeAdapters } from "./routing-runtime-deps"
import { useHealthMetricsStore } from "@/stores/settings/health-metrics-store"
import { useCircuitBreakerStore } from "@/stores/settings/circuit-breaker-store"
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"
import { useRateLimitStore } from "@/stores/settings/rate-limit-store"
import { useInFlightStore } from "@/stores/settings/in-flight-store"
import { useSettingsStore } from "@/stores/settings"
import {
  pinSessionDeployment,
  __resetForTesting as resetAffinity,
} from "@cognia/provider-routing/session-affinity-store"
import { deploymentKeyOf } from "@cognia/provider-types/deployment"

jest.mock("@/lib/db/tool-routes", () => ({
  listEnabledToolRoutes: jest.fn(async () => [
    { id: "r1", kind: "tool", refId: "t", utterances: [] },
  ]),
  cacheToolRouteEmbeddings: jest.fn(async () => {}),
}))
jest.mock("@cognia/provider-embedding/embedding", () => ({
  generateEmbeddings: jest.fn(async (texts: string[]) => ({
    embeddings: texts.map(() => [1, 0]),
  })),
}))
jest.mock("@/lib/ai/routing/difficulty-judge", () => ({
  judgeDifficulty: jest.fn(async () => ({ tier: "fast" })),
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: jest.fn(() => ({ complete: jest.fn() })),
}))

import { listEnabledToolRoutes, cacheToolRouteEmbeddings } from "@/lib/db/tool-routes"
import { judgeDifficulty } from "@/lib/ai/routing/difficulty-judge"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"

const deployKey = (providerId: string, modelId: string) =>
  deploymentKeyOf({ providerId, modelId }) as string

beforeEach(() => {
  useHealthMetricsStore.getState().resetAll()
  useCircuitBreakerStore.getState().resetAll()
  useCircuitBreakerStore.getState().setEnabled(false)
  useProviderCostMirrorStore.getState().reset()
  useRateLimitStore.getState().reset()
  useInFlightStore.getState().__resetForTesting()
  resetAffinity()
  useSettingsStore.setState({ settings: undefined } as never)
  jest.clearAllMocks()
})

describe("buildRoutingRuntimeAdapters — health telemetry", () => {
  it("returns undefined for a never-recorded provider/deployment (no-info contract)", () => {
    const a = buildRoutingRuntimeAdapters()
    expect(a.getHealthMetrics!("openai")).toBeUndefined()
    expect(a.getDeploymentHealth!(deployKey("openai", "gpt-4o"))).toBeUndefined()
  })

  it("reflects recorded provider + deployment metrics", () => {
    useHealthMetricsStore.getState().record({
      providerId: "openai",
      modelId: "gpt-4o",
      success: true,
      latencyMs: 100,
    })
    const a = buildRoutingRuntimeAdapters()
    expect(a.getHealthMetrics!("openai")?.totalRequests).toBe(1)
    expect(a.getDeploymentHealth!(deployKey("openai", "gpt-4o"))?.totalRequests).toBe(1)
  })
})

describe("buildRoutingRuntimeAdapters — circuit breaker", () => {
  it("delegates state + availability reads to the store", () => {
    const a = buildRoutingRuntimeAdapters()
    expect(a.getCircuitBreakerState!("openai")).toBe("closed")
    expect(a.isCircuitBreakerAvailable!("openai")).toBe(true)
    expect(a.getDeploymentCircuitBreakerState!(deployKey("openai", "gpt-4o"))).toBe("closed")
  })

  it("forwards the config sink into the store", () => {
    const a = buildRoutingRuntimeAdapters()
    a.setCircuitBreakerEnabled!(true)
    a.setCircuitBreakerSettings!({ failureThreshold: 7 })
    a.updateCircuitConfig!("openai", { cooldownMs: 1234 })
    const store = useCircuitBreakerStore.getState()
    expect(store.enabled).toBe(true)
    expect(store.settings.failureThreshold).toBe(7)
    expect(store.providerConfigs.openai).toEqual({ cooldownMs: 1234 })
  })
})

describe("buildRoutingRuntimeAdapters — spend / rate / in-flight", () => {
  it("reads today-spend from the cost mirror", () => {
    useProviderCostMirrorStore.getState().addCost("openai", 2.5)
    expect(buildRoutingRuntimeAdapters().getTodaySpend!("openai")).toBeCloseTo(2.5)
  })

  it("reads provider + deployment rate windows", () => {
    useRateLimitStore.getState().record("openai", 50, Date.now(), { modelId: "gpt-4o" })
    const a = buildRoutingRuntimeAdapters()
    expect(a.getRate!("openai").rpm).toBeGreaterThanOrEqual(1)
    expect(a.getDeploymentRate!(deployKey("openai", "gpt-4o")).rpm).toBeGreaterThanOrEqual(1)
  })

  it("reads provider + deployment in-flight counts", () => {
    useInFlightStore.getState().begin("s1", "openai", { modelId: "gpt-4o" })
    const a = buildRoutingRuntimeAdapters()
    expect(a.getInFlight!("openai")).toBe(1)
    expect(a.getDeploymentInFlight!(deployKey("openai", "gpt-4o"))).toBe(1)
  })
})

describe("buildRoutingRuntimeAdapters — session affinity", () => {
  it("reads and releases session pins", () => {
    pinSessionDeployment("s1", deployKey("openai", "gpt-4o"))
    const a = buildRoutingRuntimeAdapters()
    expect(a.getSessionDeployment!("s1")).toBe(deployKey("openai", "gpt-4o"))
    a.releaseSessionDeployment!("s1")
    expect(a.getSessionDeployment!("s1")).toBeUndefined()
  })
})

describe("buildRoutingRuntimeAdapters — difficulty settings", () => {
  it("returns undefined when unset and the configured block when present", () => {
    expect(buildRoutingRuntimeAdapters().getDifficultyRoutingSettings!()).toBeUndefined()
    const difficultyRouting = {
      enabled: true,
      threshold: 0.4,
      strongModel: { providerId: "anthropic", modelId: "claude-opus-4-8" },
      weakModel: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    }
    useSettingsStore.setState({ settings: { difficultyRouting } } as never)
    expect(buildRoutingRuntimeAdapters().getDifficultyRoutingSettings!()).toEqual(difficultyRouting)
  })
})

describe("buildRoutingRuntimeAdapters — Auto policy", () => {
  it("returns undefined when no autoRouting settings exist", () => {
    expect(buildRoutingRuntimeAdapters().getAutoRoutingPolicy!()).toBeUndefined()
    useSettingsStore.setState({ settings: {} } as never)
    expect(buildRoutingRuntimeAdapters().getAutoRoutingPolicy!()).toBeUndefined()
  })

  it("maps the persisted autoRouting block, cost cap kept in cents", () => {
    useSettingsStore.setState({
      settings: {
        autoRouting: {
          preferredProviders: ["groq"],
          excludedProviders: ["openai"],
          maxCostPerRequest: 25,
          categoryAliases: { coding: "code-tier" },
        },
      },
    } as never)
    expect(buildRoutingRuntimeAdapters().getAutoRoutingPolicy!()).toEqual({
      preferredProviders: ["groq"],
      excludedProviders: ["openai"],
      maxCostPerRequestCents: 25,
      categoryAliases: { coding: "code-tier" },
    })
  })
})

describe("buildRoutingRuntimeAdapters — difficulty judge wiring", () => {
  const judgeInput = {
    promptText: "anything",
    deterministicScore: 0.5,
    deterministicTier: "fast" as const,
    signalsOnly: {
      length: 0,
      code: 0,
      keywords: 0,
      structure: 0,
      attachments: 0,
      threadDepth: 0,
      tools: 0,
      effortFloor: 0,
    },
  }

  it("pins the judge to the configured router model", async () => {
    useSettingsStore.setState({
      settings: {
        autoRouting: {
          routerModel: { provider: "openai", model: "gpt-4o-mini", priority: 1 },
        },
      },
    } as never)
    await buildRoutingRuntimeAdapters().judgeDifficulty!(judgeInput)
    expect(buildUtilityLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: "routing-difficulty-judge",
        override: { providerOverride: "openai", model: "gpt-4o-mini" },
      })
    )
  })

  it("passes no override when no router model is configured", async () => {
    useSettingsStore.setState({ settings: { autoRouting: {} } } as never)
    await buildRoutingRuntimeAdapters().judgeDifficulty!(judgeInput)
    const args = jest.mocked(buildUtilityLlmClient).mock.calls.at(-1)?.[0]
    expect(args).not.toHaveProperty("override")
  })

  it("sizes the verdict cache from settings — disabled means zero TTL", async () => {
    useSettingsStore.setState({
      settings: { autoRouting: { enableCache: false, cacheTTL: 60 } },
    } as never)
    await buildRoutingRuntimeAdapters().judgeDifficulty!(judgeInput)
    expect(judgeDifficulty).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ cacheTtlMs: 0 })
    )

    useSettingsStore.setState({
      settings: { autoRouting: { enableCache: true, cacheTTL: 60 } },
    } as never)
    await buildRoutingRuntimeAdapters().judgeDifficulty!(judgeInput)
    expect(judgeDifficulty).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ cacheTtlMs: 60_000 })
    )
  })

  it("defaults to five minutes when no TTL is configured and forwards judge timeoutMs", async () => {
    useSettingsStore.setState({
      settings: { autoRouting: { judge: { enabled: true, timeoutMs: 250 } } },
    } as never)
    await buildRoutingRuntimeAdapters().judgeDifficulty!(judgeInput)
    expect(judgeDifficulty).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ cacheTtlMs: 300_000, timeoutMs: 250 })
    )
  })
})

describe("buildRoutingRuntimeAdapters — semantic tool router deps", () => {
  it("wires listRoutes, embed and cacheRouteEmbeddings", async () => {
    const deps = buildRoutingRuntimeAdapters().semanticToolRouterDeps!
    expect(await deps.listRoutes()).toHaveLength(1)
    expect(listEnabledToolRoutes).toHaveBeenCalled()

    const embeddings = await deps.embed(["a", "b"], {
      provider: "transformersjs",
      model: "Xenova/all-MiniLM-L6-v2",
    })
    expect(embeddings).toEqual([
      [1, 0],
      [1, 0],
    ])

    await deps.cacheRouteEmbeddings("r1", [[1, 0]], "Xenova/all-MiniLM-L6-v2")
    expect(cacheToolRouteEmbeddings).toHaveBeenCalledWith("r1", [[1, 0]], "Xenova/all-MiniLM-L6-v2")
  })
})
