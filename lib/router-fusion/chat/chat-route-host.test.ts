const liveSettings = { routerFusion: { enabled: true } }
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings: liveSettings }) },
}))

import type { AppSettings } from "@cognia/agent-config-types"
import type { RoutingEngineDeps } from "@cognia/provider-routing"

import { createChatRouteHost, runtimeEnvironment } from "./chat-route-host"

function deps(): RoutingEngineDeps {
  return {
    getHealthMetrics: () => undefined,
    getCircuitBreakerState: () => "closed",
    isProviderAvailable: () => true,
    getPricing: () => undefined,
  }
}

describe("createChatRouteHost", () => {
  const appSettings = {
    routerFusion: { enabled: true, budgetMode: "strict" },
    customProviders: [
      {
        id: "my-gateway",
        providerId: "my-gateway",
        isCustom: true,
        customName: "Gateway",
        customModelMetadata: { m1: { pricing: { promptPer1M: 3, completionPer1M: 9 } } },
      },
    ],
  } as unknown as AppSettings

  it("reads settings, pricing and planning from the app", async () => {
    const planRoute = jest.fn().mockResolvedValue({ selected: {} })
    const host = createChatRouteHost({ appSettings, engine: { planRoute }, engineDeps: deps() })
    expect(host.settings.enabled).toBe(true)
    expect(host.settings.budgetMode).toBe("strict")
    expect(host.pricingOf("my-gateway", "m1")).toMatchObject({ promptPer1M: 3, completionPer1M: 9 })
    await host.planRoute({ surface: "chat", selection: { kind: "auto" } })
    expect(planRoute).toHaveBeenCalledTimes(1)
    expect(host.currentSettings()).toBe(liveSettings)
    expect(host.environment).toBe(runtimeEnvironment())
    expect(host.newId()).not.toBe(host.newId())
  })

  it("knows which providers can be on a subscription and which cannot prove their destination", () => {
    const host = createChatRouteHost({
      appSettings,
      engine: { planRoute: jest.fn() },
      engineDeps: deps(),
    })
    expect(host.subscriptionCapable("anthropic")).toBe(true)
    expect(host.subscriptionCapable("codex")).toBe(true)
    expect(host.subscriptionCapable("openai")).toBe(false)
    expect(host.isAggregator("openrouter")).toBe(true)
    expect(host.isAggregator("my-gateway")).toBe(true)
    expect(host.isAggregator("openai")).toBe(false)
  })

  it("maps the build environment", () => {
    expect(runtimeEnvironment()).toBe("test")
  })
})
