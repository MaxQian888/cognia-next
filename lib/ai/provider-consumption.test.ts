import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createOpenAI } from "@ai-sdk/openai"
import { createAlibaba } from "@ai-sdk/alibaba"
import { createXai } from "@ai-sdk/xai"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createFireworks } from "@ai-sdk/fireworks"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { getBuiltInProviderDefaultModel } from "@cognia/provider-types/built-in-provider-catalog"

import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  createFeatureProviderClient,
  createFeatureProviderModel,
  type ProviderSettingsSnapshot,
  type ResolvedProvider,
} from "./provider-consumption"

// Mock only the Anthropic factory so we can assert what settings (fetch /
// headers) reach the AI SDK client. The other create*() factories stay real,
// so the "builds a client for each protocol family" suite is unaffected.
jest.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: jest.fn((settings: unknown) => {
    const make = (id: string) => ({ __provider: "anthropic", id, settings })
    const fn = (id: string) => make(id)
    ;(fn as { chat?: unknown }).chat = (id: string) => make(id)
    return fn
  }),
}))

function makeEndpointFamilyFactory(provider: string) {
  return jest.fn((settings: unknown) => {
    const fn = Object.assign(
      jest.fn((id: string) => ({ __provider: provider, id, settings })),
      {
        chat: jest.fn((id: string) => ({ __provider: `${provider}.chat`, id, settings })),
        responses: jest.fn((id: string) => ({
          __provider: `${provider}.responses`,
          id,
          settings,
        })),
      }
    )
    return fn
  })
}

jest.mock("@ai-sdk/openai", () => ({
  createOpenAI: makeEndpointFamilyFactory("openai"),
}))

jest.mock("@ai-sdk/azure", () => ({
  createAzure: makeEndpointFamilyFactory("azure"),
}))

jest.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: makeEndpointFamilyFactory("amazon-bedrock"),
}))

jest.mock("@ai-sdk/alibaba", () => ({
  createAlibaba: makeEndpointFamilyFactory("alibaba"),
}))

jest.mock("@ai-sdk/xai", () => ({
  createXai: makeEndpointFamilyFactory("xai"),
}))

jest.mock("@ai-sdk/togetherai", () => ({
  createTogetherAI: makeEndpointFamilyFactory("togetherai"),
}))

jest.mock("@ai-sdk/fireworks", () => ({
  createFireworks: makeEndpointFamilyFactory("fireworks"),
}))

jest.mock("@ai-sdk/deepinfra", () => ({
  createDeepInfra: makeEndpointFamilyFactory("deepinfra"),
}))

describe("customHeaders → ResolvedProvider.headers", () => {
  it("carries a built-in provider's static headers into the resolution", () => {
    const snap = createProviderSettingsSnapshot({
      defaultProvider: "openai",
      providerSettings: {
        openai: { enabled: true, apiKey: "sk", customHeaders: { "x-tenant": "acme" } },
      },
      customProviders: undefined,
    })
    const res = resolveFeatureProvider(
      {
        featureId: "t",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "openai",
        fallbackMode: "none",
      },
      snap
    )
    expect(res.kind).toBe("resolved")
    if (res.kind === "resolved") expect(res.headers).toEqual({ "x-tenant": "acme" })
  })

  it("carries a custom provider's headers and omits the field when empty", () => {
    const snap = createProviderSettingsSnapshot({
      defaultProvider: "c1",
      providerSettings: undefined,
      customProviders: [
        {
          id: "c1",
          apiProtocol: "openai",
          baseURL: "https://gw.example/v1",
          apiKey: "k",
          defaultModel: "m",
          customHeaders: { "x-gw": "1" },
        },
        { id: "c2", apiProtocol: "openai", baseURL: "https://x", apiKey: "k", customHeaders: {} },
      ],
    })
    const withHeaders = resolveFeatureProvider(
      {
        featureId: "t",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "c1",
        fallbackMode: "none",
      },
      snap
    )
    expect(withHeaders.kind === "resolved" && withHeaders.headers).toEqual({ "x-gw": "1" })
    const without = resolveFeatureProvider(
      {
        featureId: "t",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "c2",
        fallbackMode: "none",
      },
      snap
    )
    expect(without.kind === "resolved" && "headers" in without).toBe(false)
  })
})

describe("createProviderSettingsSnapshot", () => {
  it("defaults missing inputs to empty collections", () => {
    const snap = createProviderSettingsSnapshot({
      defaultProvider: undefined,
      providerSettings: undefined,
      customProviders: undefined,
    })
    expect(snap).toEqual({ defaultProvider: undefined, providers: {}, customProviders: [] })
  })

  it("maps rich custom-provider rows and converts gemini → google protocol", () => {
    const snap = createProviderSettingsSnapshot({
      defaultProvider: "openai",
      providerSettings: { openai: { enabled: true, apiKey: "sk" } },
      customProviders: [
        { id: "c1", apiProtocol: "gemini", baseURL: "https://x", apiKey: "k", defaultModel: "m" },
      ],
    })
    expect(snap.defaultProvider).toBe("openai")
    expect(snap.providers.openai.apiKey).toBe("sk")
    expect(snap.customProviders[0]).toMatchObject({
      id: "c1",
      protocol: "google",
      baseURL: "https://x",
      apiKey: "k",
      defaultModel: "m",
    })
  })

  it("keeps an explicit protocol over the apiProtocol fallback", () => {
    const snap = createProviderSettingsSnapshot({
      defaultProvider: undefined,
      providerSettings: undefined,
      customProviders: [{ id: "c1", protocol: "anthropic", apiProtocol: "gemini", baseURL: "u" }],
    })
    expect(snap.customProviders[0].protocol).toBe("anthropic")
  })
})

describe("resolveFeatureProvider — explicit provider", () => {
  const snap: ProviderSettingsSnapshot = {
    defaultProvider: "openai",
    providers: {
      openai: { enabled: true, apiKey: "sk-openai", defaultModel: "gpt-4o-mini" },
      disabled: { enabled: false, apiKey: "x" },
      nokey: { enabled: true },
    },
    customProviders: [
      {
        id: "proxy",
        name: "Proxy",
        protocol: "openai",
        baseURL: "https://proxy.test",
        apiKey: "pk",
        defaultModel: "m",
      },
    ],
  }

  it("resolves a built-in provider with its protocol derived from the id", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "openai",
        fallbackMode: "none",
      },
      snap
    )
    expect(r.kind).toBe("resolved")
    const resolved = r as ResolvedProvider
    expect(resolved.protocol).toBe("openai")
    expect(resolved.apiKey).toBe("sk-openai")
    expect(resolved.model).toBe("gpt-4o-mini")
    expect(resolved.isCustomProvider).toBe(false)
  })

  it("forwards a built-in provider's apiFlavor onto the resolution", () => {
    const flavored: ProviderSettingsSnapshot = {
      defaultProvider: "openai",
      providers: {
        openai: { enabled: true, apiKey: "sk", defaultModel: "gpt-5", apiFlavor: "responses" },
      },
      customProviders: [],
    }
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "openai",
        fallbackMode: "none",
      },
      flavored
    ) as ResolvedProvider
    expect(r.kind).toBe("resolved")
    expect(r.apiFlavor).toBe("responses")
  })

  it("honors a built-in provider's apiProtocol override over the catalog-derived protocol", () => {
    const overridden: ProviderSettingsSnapshot = {
      defaultProvider: "deepseek",
      providers: {
        // deepseek's catalog protocol is "openai" — the user has pointed it
        // at a relay that actually speaks the native Anthropic format.
        deepseek: {
          enabled: true,
          apiKey: "sk-deepseek",
          baseURL: "https://relay.test",
          defaultModel: "deepseek-v4-flash",
          apiProtocol: "anthropic",
        },
      },
      customProviders: [],
    }
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "deepseek",
        fallbackMode: "none",
      },
      overridden
    ) as ResolvedProvider
    expect(r.kind).toBe("resolved")
    expect(r.protocol).toBe("anthropic")
  })

  it("forwards a custom provider's apiFlavor onto the resolution", () => {
    const flavored: ProviderSettingsSnapshot = {
      defaultProvider: "az",
      providers: {},
      customProviders: [
        {
          id: "az",
          name: "Azure-ish",
          protocol: "openai",
          apiFlavor: "responses",
          baseURL: "https://x.openai.azure.com",
          apiKey: "k",
          defaultModel: "gpt-5",
        },
      ],
    }
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "az",
        fallbackMode: "none",
      },
      flavored
    ) as ResolvedProvider
    expect(r.kind).toBe("resolved")
    expect(r.apiFlavor).toBe("responses")
  })

  it("resolves a custom provider and marks isCustomProvider", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "proxy",
        fallbackMode: "none",
      },
      snap
    )
    const resolved = r as ResolvedProvider
    expect(resolved.kind).toBe("resolved")
    expect(resolved.isCustomProvider).toBe(true)
    expect(resolved.baseURL).toBe("https://proxy.test")
  })

  it("reports an unconfigured provider", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "ghost",
        fallbackMode: "none",
      },
      snap
    )
    expect(r.kind).toBe("unresolved")
    if (r.kind !== "resolved") expect(r.nextAction).toBe("open_provider_settings")
  })

  it("reports a disabled provider", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "disabled",
        fallbackMode: "none",
      },
      snap
    )
    expect(r.kind).toBe("unresolved")
    if (r.kind !== "resolved") expect(r.nextAction).toBe("enable_provider")
  })

  it("reports a provider missing both key and base url", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "nokey",
        fallbackMode: "none",
      },
      snap
    )
    expect(r.kind).toBe("unresolved")
    if (r.kind !== "resolved") expect(r.nextAction).toBe("add_api_key")
  })
})

describe("resolveFeatureProvider — local provider base URL defaults", () => {
  it("supplies the OpenAI-compatible /v1 default for a keyless built-in local provider", () => {
    const snap: ProviderSettingsSnapshot = {
      defaultProvider: undefined,
      providers: { ollama: { enabled: true, defaultModel: "llama3.2" } },
      customProviders: [],
    }
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "ollama",
        fallbackMode: "none",
      },
      snap
    )
    const resolved = r as ResolvedProvider
    expect(resolved.kind).toBe("resolved")
    expect(resolved.protocol).toBe("openai")
    expect(resolved.baseURL).toBe("http://localhost:11434/v1")
    expect(resolved.apiKey).toBeUndefined()
  })

  it("does not override an explicit local base URL", () => {
    const snap: ProviderSettingsSnapshot = {
      defaultProvider: undefined,
      providers: {
        lmstudio: { enabled: true, baseURL: "http://10.0.0.2:1234/v1", defaultModel: "m" },
      },
      customProviders: [],
    }
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "lmstudio",
        fallbackMode: "none",
      },
      snap
    )
    expect((r as ResolvedProvider).baseURL).toBe("http://10.0.0.2:1234/v1")
  })
})

describe("resolveFeatureProvider — built-in cloud aggregator base URL defaults", () => {
  it("supplies the catalog default base URL for an OpenRouter key with no base URL", () => {
    const snap: ProviderSettingsSnapshot = {
      defaultProvider: undefined,
      providers: { openrouter: { enabled: true, apiKey: "sk-or-v1-xxx", defaultModel: "free" } },
      customProviders: [],
    }
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "openrouter",
        fallbackMode: "none",
      },
      snap
    )
    const resolved = r as ResolvedProvider
    expect(resolved.kind).toBe("resolved")
    expect(resolved.protocol).toBe("openai")
    // Without the fallback the openai client defaults to api.openai.com and the
    // OpenRouter key is rejected by OpenAI — the bug this guards against.
    expect(resolved.baseURL).toBe("https://openrouter.ai/api/v1")
    expect(resolved.apiKey).toBe("sk-or-v1-xxx")
  })

  it("does not override an explicit user-set base URL for a built-in cloud provider", () => {
    const snap: ProviderSettingsSnapshot = {
      defaultProvider: undefined,
      providers: {
        openrouter: { enabled: true, apiKey: "sk-or-v1-xxx", baseURL: "https://proxy.test/v1" },
      },
      customProviders: [],
    }
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "openrouter",
        fallbackMode: "none",
      },
      snap
    )
    expect((r as ResolvedProvider).baseURL).toBe("https://proxy.test/v1")
  })
})

describe("resolveFeatureProvider — custom provider vs providerSettings shadow", () => {
  const customRow = {
    id: "gateway",
    name: "Gateway",
    protocol: "openai" as const,
    baseURL: "https://gateway.test/v1",
    apiKey: "gw-key",
    defaultModel: "gw-model",
  }
  const explicitArgs = {
    featureId: "f",
    routeProfile: "general-text" as const,
    selectionMode: "explicit-provider" as const,
    providerId: "gateway",
    fallbackMode: "none" as const,
  }

  it("custom row wins over a stale providerSettings shadow with blank fields", () => {
    // A parameter edit / legacy write can mint providerSettings["gateway"]
    // with empty strings — those must NOT blank out the real base URL, or an
    // openai-protocol turn silently falls back to api.openai.com.
    const snap: ProviderSettingsSnapshot = {
      defaultProvider: "gateway",
      providers: { gateway: { enabled: true, apiKey: "", baseURL: "", defaultModel: "" } },
      customProviders: [customRow],
    }
    const r = resolveFeatureProvider(explicitArgs, snap) as ResolvedProvider
    expect(r.kind).toBe("resolved")
    expect(r.baseURL).toBe("https://gateway.test/v1")
    expect(r.apiKey).toBe("gw-key")
    expect(r.model).toBe("gw-model")
    expect(r.isCustomProvider).toBe(true)
  })

  it("a disabled custom provider is skipped even when a shadow entry is enabled", () => {
    const snap: ProviderSettingsSnapshot = {
      defaultProvider: "gateway",
      providers: { gateway: { enabled: true, apiKey: "shadow-key" } },
      customProviders: [{ ...customRow, enabled: false }],
    }
    const r = resolveFeatureProvider(explicitArgs, snap)
    expect(r.kind).toBe("unresolved")
    if (r.kind !== "resolved") expect(r.nextAction).toBe("enable_provider")
  })

  it("a shadow entry's enabled:false does not disable the custom provider", () => {
    const snap: ProviderSettingsSnapshot = {
      defaultProvider: "gateway",
      providers: { gateway: { enabled: false } },
      customProviders: [customRow],
    }
    const r = resolveFeatureProvider(explicitArgs, snap) as ResolvedProvider
    expect(r.kind).toBe("resolved")
    expect(r.baseURL).toBe("https://gateway.test/v1")
  })

  it("treats a whitespace-only built-in base URL as unset and falls back to the catalog default", () => {
    const snap: ProviderSettingsSnapshot = {
      defaultProvider: "openrouter",
      providers: { openrouter: { enabled: true, apiKey: "sk-or-1", baseURL: "  " } },
      customProviders: [],
    }
    const r = resolveFeatureProvider(
      { ...explicitArgs, providerId: "openrouter" },
      snap
    ) as ResolvedProvider
    expect(r.kind).toBe("resolved")
    expect(r.baseURL).toBe("https://openrouter.ai/api/v1")
  })
})

describe("resolveFeatureProvider — selection + fallback modes", () => {
  const snap: ProviderSettingsSnapshot = {
    defaultProvider: "google",
    providers: {
      google: { enabled: true, apiKey: "gk" },
      openai: { enabled: true, apiKey: "ok" },
      broken: { enabled: true },
    },
    customProviders: [],
  }

  it("'any' mode tries the default provider first", () => {
    const r = resolveFeatureProvider(
      { featureId: "f", routeProfile: "general-text", selectionMode: "any", fallbackMode: "none" },
      snap
    )
    expect((r as ResolvedProvider).providerId).toBe("google")
  })

  it("skips media-only providers when resolving a general-text fallback", () => {
    const withMediaFirst: ProviderSettingsSnapshot = {
      defaultProvider: undefined,
      providers: {
        fal: { enabled: true, apiKey: "fal-key" },
        openai: { enabled: true, apiKey: "openai-key" },
      },
      customProviders: [],
    }

    const r = resolveFeatureProvider(
      { featureId: "f", routeProfile: "general-text", selectionMode: "any", fallbackMode: "none" },
      withMediaFirst
    )

    expect(r).toMatchObject({ kind: "resolved", providerId: "openai" })
  })

  it("'supported-providers' walks the supplied list", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "supported-providers",
        supportedProviders: ["broken", "openai"],
        fallbackMode: "none",
      },
      snap
    )
    expect((r as ResolvedProvider).providerId).toBe("openai")
  })

  it("ordered fallback appends the configured fallback chain", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "broken",
        fallbackMode: "ordered",
        fallbackProviderOrder: ["openai"],
      },
      snap
    )
    expect((r as ResolvedProvider).providerId).toBe("openai")
  })

  it("first-eligible fallback scans all configured providers", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "broken",
        fallbackMode: "first-eligible",
      },
      snap
    )
    expect((r as ResolvedProvider).kind).toBe("resolved")
  })

  it("'any' mode can settle on a custom provider when nothing else is configured", () => {
    const onlyCustom: ProviderSettingsSnapshot = {
      defaultProvider: undefined,
      providers: {},
      customProviders: [
        {
          id: "gw",
          name: "GW",
          protocol: "openai",
          baseURL: "https://gw.test/v1",
          apiKey: "k",
          defaultModel: "m",
        },
      ],
    }
    const r = resolveFeatureProvider(
      { featureId: "f", routeProfile: "general-text", selectionMode: "any", fallbackMode: "none" },
      onlyCustom
    ) as ResolvedProvider
    expect(r.kind).toBe("resolved")
    expect(r.providerId).toBe("gw")
    expect(r.isCustomProvider).toBe(true)
  })

  it("first-eligible fallback also scans custom providers", () => {
    const onlyCustom: ProviderSettingsSnapshot = {
      defaultProvider: undefined,
      providers: { broken: { enabled: true } },
      customProviders: [
        {
          id: "gw",
          name: "GW",
          protocol: "openai",
          baseURL: "https://gw.test/v1",
          apiKey: "k",
        },
      ],
    }
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "broken",
        fallbackMode: "first-eligible",
      },
      onlyCustom
    ) as ResolvedProvider
    expect(r.kind).toBe("resolved")
    expect(r.providerId).toBe("gw")
  })

  it("returns the last failure reason when no candidate resolves", () => {
    const empty: ProviderSettingsSnapshot = {
      defaultProvider: undefined,
      providers: {},
      customProviders: [],
    }
    const r = resolveFeatureProvider(
      { featureId: "f", routeProfile: "general-text", selectionMode: "any", fallbackMode: "none" },
      empty
    )
    expect(r.kind).toBe("unresolved")
  })
})

describe("createFeatureProviderClient / createFeatureProviderModel", () => {
  beforeEach(() => {
    ;(createOpenAI as jest.Mock).mockClear()
    ;(createAzure as jest.Mock).mockClear()
    ;(createAmazonBedrock as jest.Mock).mockClear()
    ;(createAlibaba as jest.Mock).mockClear()
    ;(createXai as jest.Mock).mockClear()
    ;(createTogetherAI as jest.Mock).mockClear()
    ;(createFireworks as jest.Mock).mockClear()
    ;(createDeepInfra as jest.Mock).mockClear()
  })

  const base = {
    providerId: "p",
    apiKey: "k",
    baseURL: undefined,
    isCustomProvider: false,
    useProxy: false,
  }

  it("builds a client for each protocol family", () => {
    for (const protocol of [
      "openai",
      "anthropic",
      "google",
      "mistral",
      "cohere",
      "azure",
    ] as const) {
      const client = createFeatureProviderClient({ ...base, protocol })
      expect(client).toBeDefined()
    }
  })

  it("uses the native Alibaba AI SDK provider for Qwen", () => {
    createFeatureProviderClient({
      ...base,
      providerId: "qwen",
      protocol: "openai",
      apiKey: "dashscope-key",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    })

    expect(createAlibaba).toHaveBeenCalledWith({
      apiKey: "dashscope-key",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    })
    expect(createOpenAI).not.toHaveBeenCalled()
  })

  it.each([
    ["xai", createXai],
    ["togetherai", createTogetherAI],
    ["fireworks", createFireworks],
    ["deepinfra", createDeepInfra],
  ] as const)("uses the native %s AI SDK provider for chat", (providerId, factory) => {
    createFeatureProviderClient({
      ...base,
      providerId,
      protocol: "openai",
      apiKey: `${providerId}-key`,
      baseURL: `https://${providerId}.example/v1`,
    })

    expect(factory).toHaveBeenCalledWith({
      apiKey: `${providerId}-key`,
      baseURL: `https://${providerId}.example/v1`,
    })
    expect(createOpenAI).not.toHaveBeenCalled()
  })

  it("builds Bedrock clients for API-key and explicit-IAM modes", () => {
    createFeatureProviderClient({
      ...base,
      protocol: "bedrock",
      bedrock: { authMode: "api-key", region: "us-east-1", apiKey: "bedrock-key" },
    })
    createFeatureProviderClient({
      ...base,
      apiKey: undefined,
      protocol: "bedrock",
      bedrock: {
        authMode: "iam",
        region: "eu-west-1",
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "secret",
        sessionToken: "session",
      },
    })

    expect(createAmazonBedrock).toHaveBeenNthCalledWith(1, {
      apiKey: "bedrock-key",
      region: "us-east-1",
    })
    expect(createAmazonBedrock).toHaveBeenNthCalledWith(2, {
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "session",
      region: "eu-west-1",
    })
  })

  it("builds a sidecar LanguageModelV3 proxy for the AWS default credential chain", () => {
    const model = createFeatureProviderModel({
      kind: "resolved",
      providerId: "bedrock",
      protocol: "bedrock",
      apiKey: undefined,
      baseURL: undefined,
      model: "us.amazon.nova-lite-v1:0",
      bedrock: {
        authMode: "default-chain",
        region: "us-east-1",
        profile: "engineering",
      },
      isCustomProvider: false,
      useProxy: false,
    }) as { specificationVersion?: string; provider?: string }

    expect(model.specificationVersion).toBe("v3")
    expect(model.provider).toBe("amazon-bedrock.sidecar")
    expect(createAmazonBedrock).not.toHaveBeenCalled()
  })

  it("builds a model handle from a resolved provider, backfilling a default model", () => {
    const resolved: ResolvedProvider = {
      kind: "resolved",
      providerId: "openai",
      protocol: "openai",
      apiKey: "k",
      baseURL: undefined,
      model: undefined,
      isCustomProvider: false,
      useProxy: false,
    }
    const model = createFeatureProviderModel(resolved) as { id?: string }
    expect(model.id).toBe(getBuiltInProviderDefaultModel("openai"))
  })

  it("builds an anthropic model handle for an explicit model id", () => {
    const resolved: ResolvedProvider = {
      kind: "resolved",
      providerId: "anthropic",
      protocol: "anthropic",
      apiKey: "k",
      baseURL: undefined,
      model: "claude-sonnet-4-6",
      isCustomProvider: false,
      useProxy: false,
    }
    expect(createFeatureProviderModel(resolved)).toBeDefined()
  })

  it("routes OpenAI-compatible gateways to Chat Completions by default", () => {
    const model = createFeatureProviderModel({
      kind: "resolved",
      providerId: "openrouter",
      protocol: "openai",
      apiKey: "sk-or-v1",
      baseURL: "https://openrouter.ai/api/v1",
      model: "openrouter/auto",
      isCustomProvider: false,
      useProxy: false,
    }) as { __provider?: string; id?: string }
    expect(model.__provider).toBe("openai.chat")
    expect(model.id).toBe("openrouter/auto")
  })

  it("honors apiFlavor when building an OpenAI-compatible feature model", () => {
    const model = createFeatureProviderModel({
      kind: "resolved",
      providerId: "openai",
      protocol: "openai",
      apiFlavor: "responses",
      apiKey: "sk-test",
      baseURL: "https://gateway.example/v1",
      model: "gpt-4o",
      isCustomProvider: false,
      useProxy: false,
    }) as { __provider?: string }
    expect(model.__provider).toBe("openai.responses")
  })

  it("routes Codex feature models through Responses on the ChatGPT backend", () => {
    const model = createFeatureProviderModel({
      kind: "resolved",
      providerId: "codex",
      protocol: "openai",
      apiKey: "chatgpt-bearer",
      baseURL: "https://chatgpt.com/backend-api/codex",
      model: "gpt-5.2-codex",
      isCustomProvider: false,
      useProxy: false,
    }) as { __provider?: string }
    expect(model.__provider).toBe("openai.responses")
  })

  it("routes Azure feature models with the shared endpoint-family decision", () => {
    const auto = createFeatureProviderModel({
      kind: "resolved",
      providerId: "azure",
      protocol: "azure",
      apiKey: "sk-azure",
      baseURL: "https://x.openai.azure.com",
      model: "gpt-5",
      isCustomProvider: false,
      useProxy: false,
    }) as { __provider?: string }
    const responses = createFeatureProviderModel({
      kind: "resolved",
      providerId: "azure",
      protocol: "azure",
      apiFlavor: "responses",
      apiKey: "sk-azure",
      baseURL: "https://x.openai.azure.com",
      model: "gpt-5",
      isCustomProvider: false,
      useProxy: false,
    }) as { __provider?: string }
    expect(auto.__provider).toBe("azure.chat")
    expect(responses.__provider).toBe("azure.responses")
  })
})

describe("provider client fetch/headers seam (standalone BYOK)", () => {
  beforeEach(() => (createAnthropic as jest.Mock).mockClear())

  const anthropicBase = {
    providerId: "anthropic",
    apiKey: "k",
    baseURL: undefined,
    protocol: "anthropic" as const,
    isCustomProvider: false,
    useProxy: false,
  }
  const lastSettings = () =>
    (createAnthropic as jest.Mock).mock.calls.at(-1)?.[0] as
      { fetch?: unknown; headers?: unknown } | undefined

  it("threads custom fetch + headers into the AI SDK provider settings", () => {
    const customFetch = (() => undefined) as unknown as typeof globalThis.fetch
    createFeatureProviderClient({
      ...anthropicBase,
      fetch: customFetch,
      headers: { "anthropic-dangerous-direct-browser-access": "true" },
    })
    expect(lastSettings()?.fetch).toBe(customFetch)
    expect(lastSettings()?.headers).toEqual({
      "anthropic-dangerous-direct-browser-access": "true",
    })
  })

  it("omits fetch/headers by default (back-compat — global fetch)", () => {
    createFeatureProviderClient(anthropicBase)
    expect(lastSettings()?.fetch).toBeUndefined()
    expect(lastSettings()?.headers).toBeUndefined()
  })

  it("createFeatureProviderModel forwards transport fetch/headers", () => {
    const customFetch = (() => undefined) as unknown as typeof globalThis.fetch
    createFeatureProviderModel(
      {
        kind: "resolved",
        providerId: "anthropic",
        protocol: "anthropic",
        apiKey: "k",
        baseURL: undefined,
        model: "claude-sonnet-4-6",
        isCustomProvider: false,
        useProxy: false,
      },
      { fetch: customFetch, headers: { "x-test": "1" } }
    )
    expect(lastSettings()?.fetch).toBe(customFetch)
    expect(lastSettings()?.headers).toEqual({ "x-test": "1" })
  })
})
