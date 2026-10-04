import type { SubscriptionProviderDefinition } from "@/types/subscription/provider-definition"

jest.mock("@/lib/subscription/core/provider-registry", () => ({
  listSubscriptionProviders: jest.fn(() => []),
}))

import { listSubscriptionProviders } from "@/lib/subscription/core/provider-registry"
import {
  filterCogniaGatewayModels,
  isCogniaGatewayModelCatalog,
  listCogniaGatewayModelOptions,
  listHostProfileGatewayModelOptions,
} from "./cognia-model-options"

const SECRET = "sk-live-do-not-leak"

const apiKeySubscription: SubscriptionProviderDefinition = {
  id: "kimi-sub",
  name: "Kimi subscription",
  authMode: "api-key",
  protocol: "anthropic",
  baseUrl: "https://kimi.example/v1",
  source: "builtin",
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    providerSettings: {
      openai: {
        providerId: "openai",
        enabled: true,
        apiKey: SECRET,
        baseURL: "https://proxy.example/v1",
        enabledModels: ["gpt-5.6"],
      },
      // Enabled but no credential: the gateway could not serve it.
      deepseek: { providerId: "deepseek", enabled: true, enabledModels: ["deepseek-chat"] },
      // Local, no key required.
      ollama: { providerId: "ollama", enabled: true, enabledModels: ["llama3"] },
      ...overrides,
    },
    customProviders: [],
  } as never
}

describe("filterCogniaGatewayModels", () => {
  it("keeps keyed, keyless-local and API-key subscription providers and drops uncredentialed ones", () => {
    const ids = filterCogniaGatewayModels({
      providerSettings: {
        ...(settings() as { providerSettings: Record<string, never> }).providerSettings,
        "kimi-sub": {
          providerId: "kimi-sub",
          enabled: true,
          enabledModels: ["kimi-k2"],
          apiProtocol: "anthropic",
        },
      } as never,
      customProviders: [],
      subscriptions: [apiKeySubscription],
    }).map((model) => `${model.providerId}/${model.modelId}`)
    expect(ids).toEqual(
      expect.arrayContaining(["openai/gpt-5.6", "ollama/llama3", "kimi-sub/kimi-k2"])
    )
    expect(ids).not.toContain("deepseek/deepseek-chat")
    // Anthropic is always enumerated by the catalog, and has no key here.
    expect(ids.some((id) => id.startsWith("anthropic/"))).toBe(false)
  })

  it("drops a model explicitly lacking tools or streaming, and a non-OpenAI/Anthropic protocol", () => {
    const ids = filterCogniaGatewayModels({
      providerSettings: {},
      customProviders: [
        {
          id: "custom-tools-off",
          name: "No tools",
          enabled: true,
          apiKey: SECRET,
          apiProtocol: "openai",
          models: ["a", "b"],
          customModelMetadata: { a: { supportsTools: false }, b: { supportsStreaming: false } },
        },
        {
          id: "custom-gemini",
          name: "Gemini proxy",
          enabled: true,
          apiKey: SECRET,
          apiProtocol: "gemini",
          models: ["g"],
        },
        {
          id: "custom-ok",
          name: "OK",
          enabled: true,
          apiKey: SECRET,
          apiProtocol: "openai",
          models: ["ok-1"],
        },
      ] as never,
      subscriptions: [],
    }).map((model) => `${model.providerId}/${model.modelId}`)
    expect(ids).toContain("custom-ok/ok-1")
    expect(ids).not.toContain("custom-gemini/g")
    expect(ids).not.toContain("custom-tools-off/a")
    expect(ids).not.toContain("custom-tools-off/b")
  })

  it("reads the subscription registry when no list is passed", () => {
    ;(listSubscriptionProviders as jest.Mock).mockReturnValueOnce([apiKeySubscription])
    const ids = filterCogniaGatewayModels({
      providerSettings: {
        "kimi-sub": { providerId: "kimi-sub", enabled: true, enabledModels: ["kimi-k2"] },
      } as never,
      customProviders: [],
    }).map((model) => model.providerId)
    expect(listSubscriptionProviders).toHaveBeenCalledWith([])
    expect(ids).toContain("kimi-sub")
  })
})

describe("listCogniaGatewayModelOptions", () => {
  it("groups by provider and carries no secret or base URL", () => {
    const providers = listCogniaGatewayModelOptions({
      settings: settings(),
      subscriptions: [],
      accountIds: { openai: ["acct-1", ""], ollama: [] },
    })
    const openai = providers.find((provider) => provider.providerId === "openai")
    expect(openai).toMatchObject({
      providerName: expect.any(String),
      accountIds: ["acct-1"],
      models: [expect.objectContaining({ id: "gpt-5.6", name: expect.any(String) })],
    })
    expect(providers.find((provider) => provider.providerId === "ollama")).not.toHaveProperty(
      "accountIds"
    )
    const wire = JSON.stringify(providers)
    expect(wire).not.toContain(SECRET)
    expect(wire).not.toContain("proxy.example")
    expect(wire).not.toMatch(/apiKey|baseURL|baseUrl|headers/i)
  })

  it("copies only the declared capability facts", () => {
    const [openai] = listCogniaGatewayModelOptions({
      settings: settings({ ollama: { providerId: "ollama", enabled: false } }),
      subscriptions: [],
    })
    expect(Object.keys(openai!.models[0]!).sort()).toEqual(expect.arrayContaining(["id", "name"]))
    for (const key of Object.keys(openai!.models[0]!)) {
      expect([
        "id",
        "name",
        "contextLength",
        "supportsTools",
        "supportsVision",
        "supportsReasoning",
        "supportsStreaming",
      ]).toContain(key)
    }
  })

  it("returns nothing when no provider is eligible", () => {
    expect(
      listCogniaGatewayModelOptions({
        settings: { providerSettings: {}, customProviders: [] } as never,
        subscriptions: [],
      })
    ).toEqual([])
  })
})

describe("isCogniaGatewayModelCatalog", () => {
  it("accepts the two declared shapes", () => {
    expect(isCogniaGatewayModelCatalog({ supported: true, providers: [] })).toBe(true)
    expect(
      isCogniaGatewayModelCatalog({
        supported: true,
        providers: [{ providerId: "p", providerName: "P", models: [{ id: "m", name: "M" }] }],
      })
    ).toBe(true)
    expect(isCogniaGatewayModelCatalog({ supported: false, reason: "account-locked" })).toBe(true)
  })

  it("rejects an unknown reason or a malformed provider", () => {
    expect(isCogniaGatewayModelCatalog({ supported: false, reason: "nope" })).toBe(false)
    expect(isCogniaGatewayModelCatalog({ supported: true, providers: [{ providerId: 1 }] })).toBe(
      false
    )
    expect(isCogniaGatewayModelCatalog(null)).toBe(false)
  })
})

describe("listHostProfileGatewayModelOptions", () => {
  const docs = {
    providerProfiles: [
      { id: "acme", displayName: "Acme", deploymentRefs: ["acme-eu", "acme-us"] },
      { id: "solo", displayName: "Solo", deploymentRefs: ["solo-1"] },
    ],
    deploymentProfiles: [
      { id: "acme-eu", providerRef: "acme", models: [{ id: "a-1", displayName: "A One" }] },
      { id: "acme-us", providerRef: "acme", models: [{ id: "a-1" }] },
      { id: "solo-1", providerRef: "solo", models: [{ id: "s-1", displayName: "  " }] },
      { id: "off", providerRef: "solo", enabled: false, models: [{ id: "s-1" }] },
    ],
  }
  const provider = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    protocol: "openai",
    baseUrl: "https://upstream.example/v1",
    enabled: true,
    credentialPool: 1,
    models: [{ id: id.startsWith("acme") ? "a-1" : "s-1" }],
    ...over,
  })

  it("offers each servable deployment by its profile name, without any credential detail", () => {
    const options = listHostProfileGatewayModelOptions(docs, {
      snapshot: true,
      providers: [
        provider("acme-eu"),
        provider("acme-us", { protocol: "anthropic" }),
        provider("solo-1"),
      ],
    })
    expect(options).toEqual([
      {
        providerId: "acme-eu",
        providerName: "Acme (acme-eu)",
        models: [{ id: "a-1", name: "A One" }],
      },
      {
        providerId: "acme-us",
        providerName: "Acme (acme-us)",
        models: [{ id: "a-1", name: "a-1" }],
      },
      { providerId: "solo-1", providerName: "Solo", models: [{ id: "s-1", name: "s-1" }] },
    ])
    expect(JSON.stringify(options)).not.toContain("upstream.example")
  })

  it("drops what the Host gateway cannot serve to a task", () => {
    expect(
      listHostProfileGatewayModelOptions(docs, {
        snapshot: true,
        providers: [
          provider("solo-1", { credentialPool: 0 }),
          provider("acme-eu", { protocol: "gemini" }),
          provider("acme-us", { enabled: false }),
          provider("off"),
          provider("lonely", { models: [] }),
        ],
      })
    ).toEqual([])
  })

  it("answers nothing before the server has projected a snapshot", () => {
    expect(listHostProfileGatewayModelOptions(docs, { snapshot: false, providers: [] })).toEqual([])
    expect(listHostProfileGatewayModelOptions(null, null)).toEqual([])
  })

  it("falls back to the deployment id when no profile names it", () => {
    expect(
      listHostProfileGatewayModelOptions(undefined, {
        snapshot: true,
        providers: [provider("bare", { models: [{ id: "x" }, { id: "x" }] })],
      })
    ).toEqual([{ providerId: "bare", providerName: "bare", models: [{ id: "x", name: "x" }] }])
  })
})
