import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { PluginManifest } from "@cognia/plugin-sdk"
import { descriptorToSource } from "@/lib/subscription/limits/descriptor/engine"
import type { Account, LimitsSourceContext } from "@/types/subscription"
import { OVERLAY_REGISTRY_CAPABILITIES } from "@/lib/plugin/contracts/capability-bridge-map"
import { getSubscriptionProvider } from "@/lib/subscription/core/provider-registry"
import { getAllProviders, getProviderConfig } from "@cognia/provider-types/provider"
import { collectModelOptions } from "@/lib/ai/model-options"
import { queryAccountLimits } from "@/lib/subscription/limits/runner"

// Only replace default I/O: integration queries inject their account and HTTP dependencies.
jest.mock("@/lib/subscription/core/transport", () => ({
  getAccount: jest.fn(),
  listPresets: jest.fn(),
  getProviderPreset: jest.fn(),
  authedRequest: jest.fn(),
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: () => ({ unlockedAccountId: "local-account" }) },
}))

// Host-owned contract fixtures deliberately live outside installable plugins.

describe("kimi plugin usage declaration", () => {
  const readManifest = () =>
    JSON.parse(
      readFileSync(join(__dirname, "../../../plugins/kimi-subscription/plugin.json"), "utf8")
    ) as PluginManifest
  test("declared usage resolves the matching region and extracts the documented quota", async () => {
    for (const provider of readManifest().subscriptionProviders ?? []) {
      const usage = provider.usage!
      const source = descriptorToSource({
        id: provider.id,
        match: { providerKey: provider.id },
        request: usage.request,
        extract: usage.extract,
      })
      let requestedUrl = ""
      let requestedHeaders: Record<string, string> | undefined
      const context: LimitsSourceContext = {
        provider: "cognia-kimi-subscription:" + provider.id,
        accountId: "account",
        accountLabel: "Account",
        providerKey: provider.id,
        token: "test-key",
        baseUrl: usage.baseUrl ?? provider.baseUrl,
        now: Date.parse("2026-10-18T12:00:00Z"),
        authedGet: async (url, headers) => {
          requestedUrl = url
          requestedHeaders = headers
          return JSON.stringify({
            usage: { limit: "100", used: "25", resetTime: "2026-10-18T13:00:00Z" },
          })
        },
      }
      const snapshot = await source.fetch(context)
      expect(requestedUrl).toBe(
        provider.id.endsWith("-intl")
          ? "https://api.kimi.ai/coding/v1/usages"
          : "https://api.kimi.com/coding/v1/usages"
      )
      expect(requestedHeaders?.Authorization).toBe("Bearer test-key")
      expect(snapshot?.meters.map((meter) => meter.id)).toEqual(["plan"])
      expect(snapshot?.meters[0]).toMatchObject({ usedPct: 25, resetAt: 1792328400000 })
    }
  })

  test("Kimi aggregate accepts remaining counters without guessing a quota period", async () => {
    const provider = readManifest().subscriptionProviders![0]
    const source = descriptorToSource({
      id: provider.id,
      match: { providerKey: provider.id },
      ...provider.usage!,
    })
    const snapshot = await source.fetch({
      provider: "cognia-kimi-subscription:kimi-code",
      accountId: "account",
      accountLabel: "Account",
      token: "test-key",
      baseUrl: provider.baseUrl,
      now: 0,
      authedGet: async () =>
        JSON.stringify({
          usage: { limit: "100", remaining: "40", resetTime: "2026-10-18T13:00:00Z" },
        }),
    })
    expect(snapshot?.meters[0]).toMatchObject({
      id: "plan",
      usedPct: 60,
      labelKey: "subscription.limits.meter.plan",
    })
  })
})

describe("zhipu plugin usage declaration", () => {
  const readManifest = () =>
    JSON.parse(
      readFileSync(join(__dirname, "../../../plugins/zhipu-subscription/plugin.json"), "utf8")
    ) as PluginManifest
  test("declared usage resolves the matching region and extracts the documented quota", async () => {
    for (const provider of readManifest().subscriptionProviders ?? []) {
      const usage = provider.usage!
      const source = descriptorToSource({
        id: provider.id,
        match: { providerKey: provider.id },
        request: usage.request,
        extract: usage.extract,
      })
      let requestedUrl = ""
      let requestedHeaders: Record<string, string> | undefined
      const context: LimitsSourceContext = {
        provider: "cognia-zhipu-subscription:" + provider.id,
        accountId: "account",
        accountLabel: "Account",
        providerKey: provider.id,
        token: "test-key",
        baseUrl: usage.baseUrl ?? provider.baseUrl,
        now: Date.parse("2026-10-18T12:00:00Z"),
        authedGet: async (url, headers) => {
          requestedUrl = url
          requestedHeaders = headers
          return JSON.stringify({
            data: {
              limits: [
                { unit: 6, percentage: 40, nextResetTime: 1792328400 },
                { unit: 3, percentage: 75, nextResetTime: 1792328400 },
              ],
            },
          })
        },
      }
      const snapshot = await source.fetch(context)
      expect(requestedUrl).toBe(
        provider.id.endsWith("-intl")
          ? "https://api.z.ai/api/monitor/usage/quota/limit"
          : "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
      )
      expect(requestedHeaders?.Authorization).toBe("test-key")
      expect(snapshot?.meters.map((meter) => meter.id)).toEqual(["session", "weekly"])
      expect(snapshot?.meters[0]).toMatchObject({ usedPct: 75, resetAt: 1792328400000 })
      expect(snapshot?.meters[1]).toMatchObject({ usedPct: 40, resetAt: 1792328400000 })
    }
  })
})

describe("minimax plugin usage declaration", () => {
  const readManifest = () =>
    JSON.parse(
      readFileSync(join(__dirname, "../../../plugins/minimax-subscription/plugin.json"), "utf8")
    ) as PluginManifest
  test("declared usage resolves the matching region and extracts the documented quota", async () => {
    for (const provider of readManifest().subscriptionProviders ?? []) {
      const usage = provider.usage!
      const source = descriptorToSource({
        id: provider.id,
        match: { providerKey: provider.id },
        request: usage.request,
        extract: usage.extract,
      })
      let requestedUrl = ""
      let requestedHeaders: Record<string, string> | undefined
      const context: LimitsSourceContext = {
        provider: "cognia-minimax-subscription:" + provider.id,
        accountId: "account",
        accountLabel: "Account",
        providerKey: provider.id,
        token: "test-key",
        baseUrl: usage.baseUrl ?? provider.baseUrl,
        now: Date.parse("2026-10-18T12:00:00Z"),
        authedGet: async (url, headers) => {
          requestedUrl = url
          requestedHeaders = headers
          return JSON.stringify({
            model_remains: [
              { model_name: "video", current_interval_remaining_percent: 5 },
              {
                model_name: "general",
                current_interval_remaining_percent: 67,
                current_weekly_remaining_percent: 80,
                end_time: 1792328400000,
                weekly_end_time: 1792328400000,
              },
            ],
          })
        },
      }
      const snapshot = await source.fetch(context)
      expect(requestedUrl).toBe(
        provider.id.endsWith("-intl")
          ? "https://www.minimax.io/v1/token_plan/remains"
          : "https://www.minimax.cn/v1/token_plan/remains"
      )
      expect(requestedHeaders?.Authorization).toBe("Bearer test-key")
      expect(snapshot?.meters.map((meter) => meter.id)).toEqual(["session", "weekly"])
      expect(snapshot?.meters[0]).toMatchObject({ usedPct: 33, resetAt: 1792328400000 })
      expect(snapshot?.meters[1]).toMatchObject({ usedPct: 20, resetAt: 1792328400000 })
    }
  })
})

const subscriptionBridge = OVERLAY_REGISTRY_CAPABILITIES["subscription-provider"]
const pluginCases = [
  {
    vendor: "kimi",
    paygIds: ["moonshot"],
    usagePath: "/coding/v1/usages",
    usageOrigins: ["https://api.kimi.com", "https://api.kimi.ai"],
    fixture: { usage: { limit: "100", used: "25", resetTime: "2026-10-18T13:00:00Z" } },
    expectedMeters: [{ id: "plan", usedPct: 25, resetAt: 1792328400000 }],
  },
  {
    vendor: "zhipu",
    paygIds: ["zhipu", "glm4"],
    usagePath: "/api/monitor/usage/quota/limit",
    usageOrigins: ["https://open.bigmodel.cn", "https://api.z.ai"],
    fixture: {
      data: {
        limits: [
          { unit: 6, percentage: 40, nextResetTime: 1792328400 },
          { unit: 3, percentage: 75, nextResetTime: 1792328400 },
        ],
      },
    },
    expectedMeters: [
      { id: "session", usedPct: 75, resetAt: 1792328400000 },
      { id: "weekly", usedPct: 40, resetAt: 1792328400000 },
    ],
  },
  {
    vendor: "minimax",
    paygIds: ["minimax"],
    usagePath: "/v1/token_plan/remains",
    usageOrigins: ["https://www.minimax.cn", "https://www.minimax.io"],
    fixture: {
      model_remains: [
        { model_name: "video", current_interval_remaining_percent: 5 },
        {
          model_name: "general",
          current_interval_remaining_percent: 67,
          current_weekly_remaining_percent: 80,
          end_time: 1792328400000,
          weekly_end_time: 1792328400000,
        },
      ],
    },
    expectedMeters: [
      { id: "session", usedPct: 33, resetAt: 1792328400000 },
      { id: "weekly", usedPct: 20, resetAt: 1792328400000 },
    ],
  },
]

describe.each(pluginCases)(
  "$vendor plugin host integration",
  ({ vendor, paygIds, fixture, usageOrigins, usagePath, expectedMeters }) => {
    const pluginId = "cognia-" + vendor + "-subscription"
    const readActualManifest = () =>
      JSON.parse(
        readFileSync(
          join(__dirname, "../../../plugins/" + vendor + "-subscription/plugin.json"),
          "utf8"
        )
      ) as PluginManifest
    afterEach(() => subscriptionBridge.unregisterAllByPlugin(pluginId))

    test("bridge registration reaches account setup and model selectors without changing PAYG providers", () => {
      const manifest = readActualManifest()
      const entries = manifest.subscriptionProviders!
      const paygBefore = Object.fromEntries(
        paygIds.map((id) => [id, JSON.parse(JSON.stringify(getProviderConfig(id)))])
      )
      const settings = Object.fromEntries(
        entries.map((entry) => {
          const providerId = pluginId + ":" + entry.id
          expect(getSubscriptionProvider(providerId)).toBeUndefined()
          return [providerId, { providerId, enabled: true, defaultModel: "" }]
        })
      )
      for (const entry of entries) subscriptionBridge.registerEntry({ ...entry }, { pluginId })
      const catalog = getAllProviders()
      const options = collectModelOptions(settings, [], new Set())
      for (const entry of entries) {
        const providerId = pluginId + ":" + entry.id
        const modelIds = entry.models.map((model) => (typeof model === "string" ? model : model.id))
        const definition = getSubscriptionProvider(providerId)!
        expect(definition).toMatchObject({
          id: providerId,
          source: "plugin",
          pluginId,
          billingMode: "subscription",
          brandId: vendor,
          authMode: "api-key",
          relatedProviderIds: paygIds,
          usage: entry.usage,
        })
        expect(definition.usage).not.toBe(entry.usage)
        expect(definition.models).toEqual(modelIds)
        expect(catalog[providerId]).toMatchObject({
          id: providerId,
          protocol: entry.protocol,
          defaultBaseURL: entry.baseUrl,
          defaultModel: modelIds[0],
        })
        expect(catalog[providerId].models.map((model) => model.id)).toEqual(modelIds)
        expect(
          options
            .filter((option) => option.providerId === providerId)
            .map((option) => option.modelId)
        ).toEqual(modelIds)
      }
      for (const id of paygIds) expect(getProviderConfig(id)).toEqual(paygBefore[id])
      expect(subscriptionBridge.unregisterAllByPlugin(pluginId)).toBe(entries.length)
      for (const entry of entries) {
        const providerId = pluginId + ":" + entry.id
        expect(getSubscriptionProvider(providerId)).toBeUndefined()
        expect(getAllProviders()[providerId]).toBeUndefined()
        expect(
          collectModelOptions(settings, [], new Set()).some(
            (option) => option.providerId === providerId
          )
        ).toBe(false)
      }
      for (const id of paygIds) expect(getProviderConfig(id)).toEqual(paygBefore[id])
    })

    test.each([false, true])(
      "actual account quota uses declared endpoint with legacy relay overrides: %s",
      async (legacyOverride) => {
        const manifest = readActualManifest()
        for (const entry of manifest.subscriptionProviders!)
          subscriptionBridge.registerEntry({ ...entry }, { pluginId })
        for (const entry of manifest.subscriptionProviders!) {
          const providerId = pluginId + ":" + entry.id
          const account: Account = {
            id: "plan-account",
            label: "My subscription",
            createdAtMs: 0,
            lastUsedAtMs: 0,
            ...(legacyOverride ? { presetId: "old-relay" } : {}),
            credential: {
              provider: "api-key",
              providerId,
              accessToken: "subscription-key",
              storedAtMs: 0,
              ...(legacyOverride ? { baseUrl: "https://legacy-relay.example/standard-api" } : {}),
            },
          }
          const accountBefore = structuredClone(account)
          const getAccount = jest.fn(async () => account)
          const listPresets = jest.fn(async () =>
            legacyOverride
              ? [
                  {
                    id: "old-relay",
                    label: "Legacy relay",
                    baseUrl: "https://legacy-relay.example/standard-api",
                    extraHeaders: { Authorization: "PAYG-key" },
                  },
                ]
              : []
          )
          const getProviderPreset = jest.fn(async () => null)
          const authedGet = jest.fn(async () => JSON.stringify(fixture))
          const deps = {
            getAccount,
            listPresets,
            getProviderPreset,
            authedGet,
            getLocalAccountId: () => "local-account",
            now: () => Date.parse("2026-10-18T12:00:00Z"),
          }
          const result = await queryAccountLimits(providerId, account.id, deps)
          expect(getAccount).toHaveBeenCalledWith(providerId, account.id)
          expect(listPresets).not.toHaveBeenCalled()
          expect(getProviderPreset).not.toHaveBeenCalled()
          expect(authedGet).toHaveBeenCalledTimes(1)
          expect(authedGet).toHaveBeenCalledWith(
            usageOrigins[entry.id.endsWith("-intl") ? 1 : 0] + usagePath,
            {
              Accept: "application/json",
              Authorization: vendor === "zhipu" ? "subscription-key" : "Bearer subscription-key",
            }
          )
          expect(result).toMatchObject({
            provider: providerId,
            accountId: account.id,
            accountLabel: account.label,
            meters: expectedMeters,
          })
          expect(account).toEqual(accountBefore)
        }
        subscriptionBridge.unregisterAllByPlugin(pluginId)
        const authedGet = jest.fn(async () => JSON.stringify(fixture))
        expect(
          await queryAccountLimits(
            pluginId + ":" + manifest.subscriptionProviders![0].id,
            "plan-account",
            { authedGet, getLocalAccountId: () => "local-account" }
          )
        ).toBeNull()
        expect(authedGet).not.toHaveBeenCalled()
      }
    )
  }
)
