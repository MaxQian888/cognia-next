import type { AppSettings } from "@cognia/agent-config-types"
import type { ModelPricing } from "@cognia/provider-types/provider"
import {
  normalizeRouterFusionSettings,
  type RouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"

import type { RouteFactsHost } from "../chat/route-chat-turn"
import { routeUtilityCall, UTILITY_ACTION_ID, utilityFeatures } from "./utility-route"

const PRICES: Record<string, Partial<ModelPricing>> = {
  "openai::gpt-5-mini": { promptPer1M: 0.1, completionPer1M: 0.4 },
  "anthropic::claude-opus-5": { promptPer1M: 5, completionPer1M: 25 },
}

function makeHost(
  options: {
    settings?: Partial<RouterFusionSettings>
    available?: boolean
    local?: string[]
    aggregators?: string[]
    current?: AppSettings | undefined
  } = {}
) {
  let ids = 0
  const settings = normalizeRouterFusionSettings({ ...options.settings })
  const host: RouteFactsHost = {
    settings,
    engineDeps: {
      getCapabilities: () => ({ tools: true, vision: true }),
      getContextWindow: () => 200_000,
      isLocalProvider: (id) => (options.local ?? []).includes(id),
      getCircuitBreakerState: () => "closed",
      getDeploymentCircuitBreakerState: () => "closed",
      isProviderAvailable: () => options.available ?? true,
    },
    pricingOf: (providerId, modelId) => PRICES[`${providerId}::${modelId}`] ?? null,
    subscriptionCapable: (providerId) => providerId === "anthropic",
    isAggregator: (providerId) => (options.aggregators ?? []).includes(providerId),
    currentSettings: () =>
      "current" in options
        ? options.current
        : ({
            routerFusion: {
              ...settings,
              enabled: true,
              surfaces: { ...settings.surfaces, utilityLedger: true },
            },
          } as AppSettings),
    environment: "production",
    now: () => Date.UTC(2026, 8, 16),
    newId: () => `id-${++ids}`,
  }
  return host
}

function input(overrides: Partial<Parameters<typeof routeUtilityCall>[1]> = {}) {
  return {
    surface: "utilityLedger" as const,
    providerId: "openai",
    modelId: "gpt-5-mini",
    workspaceId: null,
    estimatedInputTokens: 400,
    ...overrides,
  }
}

describe("utilityFeatures", () => {
  it("labels a machine-built prompt as the cheapest thing the router can be asked", () => {
    const features = utilityFeatures()
    expect(features.tool_need).toBe("none")
    expect(features.ambiguity).toBe("low")
    expect(features.scope).toBe("single_item")
    expect(features.missing_information).toEqual([])
    // The shape is the contract's, not a hand-written literal.
    expect(typeof features.feature_version).toBe("string")
    expect(typeof features.schema_version).toBe("string")
  })
})

describe("routeUtilityCall", () => {
  it("[ACC:BUD-04] prices the deployment the feature already chose, under the economy action", () => {
    const route = routeUtilityCall(makeHost(), input())
    if (route.kind !== "routed") throw new Error(`refused: ${route.reasons.join(",")}`)
    expect(route.prepared.actionId).toBe(UTILITY_ACTION_ID)
    expect(route.prepared.deploymentId).toBe("openai::gpt-5-mini")
    expect(route.prepared.roleDeployments).toEqual({ solver: "openai::gpt-5-mini" })
    expect(route.prepared.reserveMicrousd).toBeGreaterThan(0)
    expect(route.prepared.priceKnown).toBe(true)
    expect(route.prepared.maxOutputTokens).toBeGreaterThan(0)
    expect(route.prepared.decision.reason_codes).toEqual(
      expect.arrayContaining(["selection:utility", "surface:utilityLedger"])
    )
  })

  it("keeps the caller's own output bound when it set one", () => {
    const route = routeUtilityCall(makeHost(), input({ maxOutputTokens: 64 }))
    if (route.kind !== "routed") throw new Error("refused")
    expect(route.prepared.maxOutputTokens).toBe(64)
  })

  it("holds the unknown-price reserve for a deployment with no audited rate card", () => {
    const route = routeUtilityCall(makeHost(), input({ modelId: "some-local-model" }))
    if (route.kind !== "routed") throw new Error(`refused: ${route.reasons.join(",")}`)
    expect(route.prepared.priceKnown).toBe(false)
    expect(route.prepared.reserveMicrousd).toBeGreaterThan(0)
  })

  it("[ACC:ROUTE-07] refuses a strict-budget call against a deployment with no audited price", () => {
    const route = routeUtilityCall(
      makeHost({ settings: { budgetMode: "strict" } }),
      input({ modelId: "some-local-model" })
    )
    expect(route.kind).toBe("refused")
    if (route.kind !== "refused") return
    expect(route.code).toBe("ROUTE_NO_SOLUTION")
    expect(route.reasons.length).toBeGreaterThan(0)
  })

  it("[ACC:SAFE-01] refuses to send restricted workspace data to an aggregator", () => {
    const host = makeHost({
      settings: { dataClassByWorkspaceId: { "ws-1": "restricted" } },
      aggregators: ["openai"],
    })
    const route = routeUtilityCall(host, input({ workspaceId: "ws-1" }))
    expect(route.kind).toBe("refused")
  })

  it("re-checks the live switch at reservation time, for its own surface", () => {
    const route = routeUtilityCall(makeHost(), input())
    if (route.kind !== "routed") throw new Error("refused")
    expect(route.prepared.liveRefusal("openai::gpt-5-mini")).toBeNull()

    // The chat switch being on says nothing about a utility call.
    const chatOnly = routeUtilityCall(
      makeHost({
        current: {
          routerFusion: { enabled: true, surfaces: { chat: true } },
        } as unknown as AppSettings,
      }),
      input()
    )
    if (chatOnly.kind !== "routed") throw new Error("refused")
    expect(chatOnly.prepared.liveRefusal("openai::gpt-5-mini")).toBe("ROUTER_FUSION_DISABLED")
  })

  it("[ACC:AUTH-07] refuses at reservation time once the provider is switched off", () => {
    const route = routeUtilityCall(makeHost({ available: false }), input())
    // An unavailable provider has no health, so there is nothing to route to.
    expect(route.kind).toBe("refused")
  })
})
