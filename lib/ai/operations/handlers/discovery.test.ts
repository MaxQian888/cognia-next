/** @jest-environment node */
jest.mock("@cognia/provider-core/providers/model-discovery", () => ({
  ...jest.requireActual("@cognia/provider-core/providers/model-discovery"),
  discoverOpenRouterModels: jest.fn(),
  discoverCLIProxyAPIModels: jest.fn(),
  discoverLocalProviderModels: jest.fn(),
  discoverOpenAICompatibleModels: jest.fn(),
}))
const discovery = jest.requireMock("@cognia/provider-core/providers/model-discovery") as {
  discoverOpenRouterModels: jest.Mock
  discoverCLIProxyAPIModels: jest.Mock
  discoverLocalProviderModels: jest.Mock
  discoverOpenAICompatibleModels: jest.Mock
}
jest.mock("@cognia/provider-core/providers/models-dev-sync", () => ({
  getCatalogModelsForProvider: jest.fn(() => []),
}))
jest.mock("@/lib/claude/feature-call", () => ({ discoverBedrockModelsViaSidecar: jest.fn() }))
const featureCall = jest.requireMock("@/lib/claude/feature-call") as {
  discoverBedrockModelsViaSidecar: jest.Mock
}
jest.mock("./http", () => ({ providerRequest: jest.fn() }))
const http = jest.requireMock("./http") as { providerRequest: jest.Mock }
jest.mock("@/lib/subscription/core/provider-registry", () => ({
  getSubscriptionProvider: jest.fn(),
}))
const subscriptions = jest.requireMock("@/lib/subscription/core/provider-registry") as {
  getSubscriptionProvider: jest.Mock
}
jest.mock("../persistence", () => ({
  providerOperationPersistence: {
    readInventory: jest.fn(async () => undefined),
    writeInventory: jest.fn(async () => undefined),
    writeSnapshots: jest.fn(async () => undefined),
  },
}))
const persistence = (
  jest.requireMock("../persistence") as {
    providerOperationPersistence: { readInventory: jest.Mock; writeInventory: jest.Mock }
  }
).providerOperationPersistence

import { modelsGetOutput, modelsListOutput } from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import {
  DISCOVERY_HANDLERS,
  dominantSourceOf,
  listProviderModels,
  getProviderModel,
  modelsGetHandler,
} from "./discovery"

const settings = { defaultProvider: undefined, providers: {}, customProviders: [] }
function resolved(
  providerId: string,
  protocol: ResolvedProvider["protocol"],
  extra: Partial<ResolvedProvider> = {}
): ResolvedProvider {
  return {
    kind: "resolved",
    providerId,
    protocol,
    apiKey: "k",
    baseURL: "https://host.example/v1",
    model: undefined,
    isCustomProvider: false,
    useProxy: false,
    ...extra,
  }
}
const registry = new ProviderOperationHandlerRegistry()
for (const handler of DISCOVERY_HANDLERS) registry.register(handler)

describe("models.list", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    subscriptions.getSubscriptionProvider.mockReturnValue(undefined)
  })

  it("layers the live openai-compatible listing over the catalog for a vendor with a models endpoint", async () => {
    discovery.discoverOpenAICompatibleModels.mockResolvedValueOnce([{ id: "live-1", name: "Live" }])
    const output = await listProviderModels({
      provider: resolved("groq", "openai"),
      settings,
      now: 5,
    })
    expect(discovery.discoverOpenAICompatibleModels).toHaveBeenCalledWith({
      baseURL: "https://host.example/v1",
      apiKey: "k",
    })
    expect(modelsListOutput.parse(output)).toMatchObject({
      source: "remote-discovered",
      freshness: "fresh",
      fetchedAt: 5,
    })
    expect(
      output.models.some((model) => model.id === "live-1" && model.source === "remote-discovered")
    ).toBe(true)
    expect(registry.resolve("models.list", "groq", "openai")?.support).toBe("native")
  })

  it("never calls out for a built-in whose facts say there is no models endpoint", async () => {
    const output = await listProviderModels({
      provider: resolved("deepseek-anthropic", "anthropic"),
      settings,
    })
    expect(http.providerRequest).not.toHaveBeenCalled()
    expect(output.freshness).toBe("static")
    expect(output.source).toBe("catalog-static")
  })

  it("uses the vendor lister before the protocol one", async () => {
    discovery.discoverOpenRouterModels.mockResolvedValueOnce([{ id: "or/x" }])
    const output = await listProviderModels({
      provider: resolved("openrouter", "openai"),
      settings,
    })
    expect(discovery.discoverOpenRouterModels).toHaveBeenCalledWith("k")
    expect(discovery.discoverOpenAICompatibleModels).not.toHaveBeenCalled()
    expect(output.models.map((model) => model.id)).toContain("or/x")
  })

  it("lists anthropic and google over their own wires", async () => {
    http.providerRequest.mockResolvedValueOnce({
      json: { data: [{ id: "claude-x", display_name: "Claude X" }] },
    })
    const anthropic = await listProviderModels({
      provider: resolved("anthropic", "anthropic"),
      settings,
    })
    expect(anthropic.models.find((model) => model.id === "claude-x")?.name).toBe("Claude X")

    http.providerRequest.mockResolvedValueOnce({
      json: {
        models: [
          {
            name: "models/gemini-a",
            displayName: "A",
            inputTokenLimit: 10,
            supportedGenerationMethods: ["generateContent"],
          },
          { name: "models/embed-b", supportedGenerationMethods: ["embedContent"] },
        ],
      },
    })
    const google = await listProviderModels({ provider: resolved("google", "google"), settings })
    expect(google.models.map((model) => model.id)).toContain("gemini-a")
    expect(google.models.map((model) => model.id)).not.toContain("embed-b")
  })

  it("routes local vendors and bedrock to their discovery services", async () => {
    discovery.discoverLocalProviderModels.mockResolvedValueOnce([{ id: "llama" }])
    await listProviderModels({
      provider: resolved("ollama", "openai", { baseURL: "http://localhost:11434" }),
      settings,
    })
    expect(discovery.discoverLocalProviderModels).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434"
    )

    featureCall.discoverBedrockModelsViaSidecar.mockResolvedValueOnce([
      { id: "b1", supportsVision: true },
    ])
    const bedrock = await listProviderModels({
      provider: resolved("bedrock", "bedrock", {
        apiKey: undefined,
        bedrock: { authMode: "default-chain", region: "us-east-1" } as never,
      }),
      settings,
    })
    expect(featureCall.discoverBedrockModelsViaSidecar).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "bedrock",
        bedrockAuthMode: "default-chain",
        region: "us-east-1",
      }),
      undefined
    )
    expect(bedrock.models.find((model) => model.id === "b1")?.supportsVision).toBe(true)
  })

  it("reuses a fresh stored listing only under the same account, and records a failed listing", async () => {
    const provider = resolved("groq", "openai")
    const stored = {
      id: "deployment:groq-main",
      deploymentRef: "groq-main",
      providerRef: "groq",
      status: "healthy" as const,
      checkedAt: 100,
      availableUpstreamIds: ["stored-1"],
      accountRef: "other-account",
      models: [{ id: "stored-1" }],
      source: "remote-discovered" as const,
      freshness: "fresh" as const,
      expiresAt: 1_000,
    }
    persistence.readInventory.mockResolvedValueOnce(stored)
    discovery.discoverOpenAICompatibleModels.mockResolvedValueOnce([{ id: "live-1" }])
    const refetched = await listProviderModels({
      provider,
      settings,
      deploymentRef: "groq-main",
      now: 500,
    })
    expect(refetched.freshness).toBe("fresh")
    expect(persistence.writeInventory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "deployment:groq-main",
        status: "healthy",
        availableUpstreamIds: ["live-1"],
        expiresAt: 500 + 60 * 60 * 1000,
      })
    )
    const written = persistence.writeInventory.mock.calls.at(-1)?.[0]
    expect(written.accountRef).not.toBe("other-account")

    persistence.readInventory.mockResolvedValueOnce({ ...stored, accountRef: written.accountRef })
    const cached = await listProviderModels({
      provider,
      settings,
      deploymentRef: "groq-main",
      now: 500,
    })
    expect(cached.freshness).toBe("stale")
    expect(cached.source).toBe("remote-discovered")
    expect(cached.fetchedAt).toBe(100)
    expect(cached.models.map((model) => model.id)).toContain("stored-1")
    expect(discovery.discoverOpenAICompatibleModels).toHaveBeenCalledTimes(1)

    discovery.discoverOpenAICompatibleModels.mockResolvedValueOnce([{ id: "live-2" }])
    await listProviderModels({
      provider,
      settings,
      deploymentRef: "groq-main",
      now: 500,
      refresh: true,
    })
    expect(persistence.readInventory).toHaveBeenCalledTimes(2)
    expect(discovery.discoverOpenAICompatibleModels).toHaveBeenCalledTimes(2)

    persistence.readInventory.mockResolvedValueOnce({
      ...stored,
      accountRef: written.accountRef,
      expiresAt: 400,
    })
    discovery.discoverOpenAICompatibleModels.mockRejectedValueOnce(new Error("upstream down"))
    await expect(
      listProviderModels({ provider, settings, deploymentRef: "groq-main", now: 500 })
    ).rejects.toThrow("upstream down")
    expect(persistence.writeInventory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "unavailable",
        normalizedError: "upstream down",
        availableUpstreamIds: [],
      })
    )
  })

  it("names the highest-authority layer as the listing source", () => {
    const model = (mergedSources: string[]) => ({ id: "m", mergedSources }) as never
    expect(dominantSourceOf([model(["catalog-static"])], true)).toBe("remote-discovered")
    expect(dominantSourceOf([model(["catalog-static", "user-curated"])], false)).toBe(
      "user-curated"
    )
    expect(dominantSourceOf([model(["catalog-static", "models-dev"])], false)).toBe("models-dev")
    expect(dominantSourceOf([model(["catalog-static"])], false)).toBe("catalog-static")
  })

  it("merges a custom provider's curated models and answers models.get from the same listing", async () => {
    discovery.discoverOpenAICompatibleModels.mockResolvedValue([])
    const custom = resolved("my-relay", "openai", { isCustomProvider: true })
    const customSettings = {
      ...settings,
      customProviders: [
        { id: "my-relay", name: "Relay", models: [{ id: "curated-1", name: "Curated" }] },
      ],
    }
    const ctx = (model: string) => ({
      descriptor: getProviderOperationDescriptor("models.get")!,
      provider: custom,
      settings: customSettings,
      request: {
        operationId: "models.get" as const,
        scopes: ["provider:read" as const],
        surface: "sidecar" as const,
        input: { model },
      },
    })
    const output = await modelsGetHandler.handler(ctx("curated-1"))
    expect(modelsGetOutput.parse(output).model).toMatchObject({
      id: "curated-1",
      source: "user-curated",
    })
    await expect(modelsGetHandler.handler(ctx("missing"))).resolves.toMatchObject({ model: null })
  })

  const pluginDefinition = (modelApi?: { list: boolean; retrieve?: boolean }) => ({
    id: "example:models",
    source: "plugin",
    modelApi,
    models: ["declared"],
    modelMetadata: [{ id: "declared", supportsVision: true }],
  })
  const pluginProvider = () => resolved("example:models", "openai")

  it.each([undefined, { list: false }])(
    "uses plugin declarations without speculative requests (%j)",
    async (modelApi) => {
      subscriptions.getSubscriptionProvider.mockReturnValue(pluginDefinition(modelApi))
      const output = await listProviderModels({
        provider: pluginProvider(),
        settings,
        refresh: true,
      })
      expect(output).toMatchObject({
        freshness: "static",
        models: [{ id: "declared", supportsVision: true }],
      })
      expect(http.providerRequest).not.toHaveBeenCalled()
      expect(discovery.discoverOpenAICompatibleModels).not.toHaveBeenCalled()
    }
  )

  it("fetches plugin models through the authenticated HTTP helper and retains metadata", async () => {
    subscriptions.getSubscriptionProvider.mockReturnValue(pluginDefinition({ list: true }))
    const signal = new AbortController().signal
    http.providerRequest.mockResolvedValueOnce({
      json: {
        data: [
          { id: "declared", name: "Real name", context_length: 262144, supports_tools: false },
          { id: "live", supports_reasoning: true, max_output_tokens: 0 },
        ],
      },
    })
    const output = await listProviderModels({ provider: pluginProvider(), settings, signal })
    expect(http.providerRequest).toHaveBeenCalledWith(pluginProvider(), { path: "models", signal })
    expect(output.models[0]).toMatchObject({
      name: "Real name",
      contextLength: 262144,
      supportsVision: true,
      supportsTools: false,
    })
    expect(output.models[1]).toMatchObject({ supportsReasoning: true, maxOutputTokens: 0 })
  })

  it("fetches all Anthropic pages and parses documented model capabilities", async () => {
    subscriptions.getSubscriptionProvider.mockReturnValue(pluginDefinition({ list: true }))
    http.providerRequest
      .mockResolvedValueOnce({
        json: {
          data: [
            {
              id: "a/b",
              display_name: "A",
              max_input_tokens: 100,
              max_tokens: 0,
              capabilities: { image_input: { supported: false }, thinking: { supported: true } },
            },
          ],
          has_more: true,
          last_id: "a/b",
        },
      })
      .mockResolvedValueOnce({ json: { data: [{ id: "b" }], has_more: false } })
    const output = await listProviderModels({
      provider: resolved("example:models", "anthropic"),
      settings,
    })
    expect(http.providerRequest.mock.calls[1][1].path).toBe("models?after_id=a%2Fb")
    expect(output.models.find((model) => model.id === "a/b")).toMatchObject({
      contextLength: 100,
      maxOutputTokens: 0,
      supportsVision: false,
      supportsReasoning: true,
    })
    expect(output.models.map((model) => model.id)).toContain("b")
  })

  it.each([
    { data: [], has_more: true, last_id: "a" },
    { data: [{ id: "a" }], has_more: "yes", last_id: "a" },
    { data: [{ id: "a" }], has_more: true },
    { data: [{ name: "missing-id" }], has_more: false },
    { data: "invalid" },
  ])("rejects malformed model pages (%j)", async (json) => {
    http.providerRequest.mockResolvedValueOnce({ json })
    await expect(
      listProviderModels({ provider: resolved("anthropic", "anthropic"), settings })
    ).rejects.toThrow()
  })

  it("rejects repeated pagination cursors", async () => {
    http.providerRequest.mockResolvedValue({
      json: { data: [{ id: "a" }], has_more: true, last_id: "a" },
    })
    await expect(
      listProviderModels({ provider: resolved("anthropic", "anthropic"), settings })
    ).rejects.toThrow("pagination")
    expect(http.providerRequest).toHaveBeenCalledTimes(2)
  })

  it("does not reuse an inventory after endpoint or protocol changes", async () => {
    subscriptions.getSubscriptionProvider.mockReturnValue(pluginDefinition({ list: true }))
    http.providerRequest.mockResolvedValue({ json: { data: [{ id: "live" }] } })
    await listProviderModels({ provider: pluginProvider(), settings, now: 1 })
    const stored = persistence.writeInventory.mock.calls.at(-1)![0]
    persistence.readInventory.mockResolvedValueOnce(stored)
    await listProviderModels({
      provider: { ...pluginProvider(), baseURL: "https://other.example/v1" },
      settings,
      now: 2,
    })
    persistence.readInventory.mockResolvedValueOnce(stored)
    await listProviderModels({
      provider: { ...pluginProvider(), protocol: "anthropic" },
      settings,
      now: 2,
    })
    expect(http.providerRequest).toHaveBeenCalledTimes(3)
  })

  it("discards results from a disabled plugin without writing inventory", async () => {
    subscriptions.getSubscriptionProvider.mockReturnValue(pluginDefinition({ list: true }))
    http.providerRequest.mockImplementationOnce(async () => {
      subscriptions.getSubscriptionProvider.mockReturnValue(undefined)
      return { json: { data: [{ id: "late" }] } }
    })
    await expect(listProviderModels({ provider: pluginProvider(), settings })).rejects.toThrow(
      "no longer active"
    )
    expect(persistence.writeInventory).not.toHaveBeenCalled()
  })

  it("does not reject an unrelated namespaced provider without a subscription contribution", async () => {
    discovery.discoverOpenAICompatibleModels.mockResolvedValueOnce([{ id: "ordinary" }])
    const output = await listProviderModels({
      provider: resolved("ordinary:provider", "openai"),
      settings,
    })
    expect(output.models.map((model) => model.id)).toContain("ordinary")
  })

  it("propagates cancellation without caching the canceled result", async () => {
    subscriptions.getSubscriptionProvider.mockReturnValue(pluginDefinition({ list: true }))
    const controller = new AbortController()
    http.providerRequest.mockImplementationOnce(async () => {
      controller.abort()
      return { json: { data: [] } }
    })
    await expect(
      listProviderModels({ provider: pluginProvider(), settings, signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(persistence.writeInventory).not.toHaveBeenCalled()
  })

  it("retrieves a model by escaped identifier when the plugin declares the endpoint", async () => {
    subscriptions.getSubscriptionProvider.mockReturnValue(
      pluginDefinition({ list: true, retrieve: true })
    )
    http.providerRequest.mockResolvedValueOnce({
      json: { id: "canonical", name: "Canonical", context_length: 200 },
    })
    const output = await modelsGetHandler.handler({
      descriptor: getProviderOperationDescriptor("models.get")!,
      provider: pluginProvider(),
      settings,
      request: {
        operationId: "models.get",
        scopes: ["provider:read"],
        surface: "sidecar",
        input: { model: "vendor/model?alias" },
      },
    })
    expect(http.providerRequest.mock.calls[0][1].path).toBe("models/vendor%2Fmodel%3Falias")
    expect(output).toMatchObject({
      model: { id: "canonical", contextLength: 200 },
      freshness: "fresh",
    })
  })

  it("derives model details from plugin metadata when retrieval is unavailable", async () => {
    subscriptions.getSubscriptionProvider.mockReturnValue(pluginDefinition())
    const output = await modelsGetHandler.handler({
      descriptor: getProviderOperationDescriptor("models.get")!,
      provider: pluginProvider(),
      settings,
      request: {
        operationId: "models.get",
        scopes: ["provider:read"],
        surface: "sidecar",
        input: { model: "declared" },
      },
    })
    expect(output).toMatchObject({
      model: { id: "declared", supportsVision: true },
      freshness: "static",
    })
    expect(http.providerRequest).not.toHaveBeenCalled()
  })

  it("uses explicitly supplied custom subscription metadata without probing undeclared endpoints", async () => {
    const provider = resolved("custom-preview", "anthropic", { isCustomProvider: true })
    const subscription = {
      id: provider.providerId,
      name: "Custom",
      source: "custom" as const,
      authMode: "api-key" as const,
      models: ["m"],
      modelMetadata: [{ id: "m", contextLength: 100, supportsReasoning: true }],
      modelApi: { list: false },
    }
    expect(await listProviderModels({ provider, settings, subscription })).toMatchObject({
      freshness: "static",
      models: [{ id: "m", contextLength: 100, supportsReasoning: true }],
    })
    expect(await getProviderModel({ provider, settings, subscription, model: "m" })).toMatchObject({
      freshness: "static",
      model: { id: "m", contextLength: 100 },
    })
    expect(http.providerRequest).not.toHaveBeenCalled()
  })

  it("uses opted-in custom list and detail endpoints with account-specific metadata priority", async () => {
    const provider = resolved("custom-preview", "openai", { isCustomProvider: true })
    const subscription = {
      id: provider.providerId,
      name: "Custom",
      source: "custom" as const,
      authMode: "api-key" as const,
      models: ["m"],
      modelMetadata: [
        { id: "m", contextLength: 1000000, supportsVision: true, supportsReasoning: true },
      ],
      modelApi: { list: true, retrieve: true },
    }
    http.providerRequest.mockResolvedValueOnce({
      json: { data: [{ id: "m", context_length: 256000, supports_vision: false }] },
    })
    const listed = await listProviderModels({
      provider,
      settings: {
        ...settings,
        customProviders: [
          {
            id: provider.providerId,
            name: "Custom",
            models: [{ id: "m", contextLength: 1000000 }],
          },
        ],
      },
      subscription,
      refresh: true,
    })
    expect(listed.models[0]).toMatchObject({
      contextLength: 256000,
      supportsVision: false,
      supportsReasoning: true,
      source: "remote-discovered",
    })
    http.providerRequest.mockResolvedValueOnce({
      json: { id: "m", max_output_tokens: 0, supports_reasoning: false },
    })
    expect(await getProviderModel({ provider, settings, subscription, model: "m" })).toMatchObject({
      freshness: "fresh",
      model: { maxOutputTokens: 0, supportsReasoning: false },
    })
    expect(http.providerRequest.mock.calls[1][1].path).toBe("models/m")
  })

  it("rejects a mismatched explicit subscription before fetching", async () => {
    const subscription = {
      id: "other",
      name: "Other",
      source: "custom" as const,
      authMode: "api-key" as const,
    }
    await expect(
      listProviderModels({ provider: pluginProvider(), settings, subscription })
    ).rejects.toThrow("does not match")
    await expect(
      getProviderModel({ provider: pluginProvider(), settings, subscription, model: "m" })
    ).rejects.toThrow("does not match")
    expect(http.providerRequest).not.toHaveBeenCalled()
  })

  it("rejects a stale explicitly supplied plugin definition", async () => {
    const subscription = {
      ...pluginDefinition({ list: true }),
      name: "Plugin",
      source: "plugin" as const,
      authMode: "api-key" as const,
    }
    await expect(
      listProviderModels({ provider: pluginProvider(), settings, subscription })
    ).rejects.toThrow("no longer active")
    expect(http.providerRequest).not.toHaveBeenCalled()
  })

  it("honors stored custom subscription declarations through ordinary model operations", async () => {
    const provider = resolved("saved-custom", "anthropic", { isCustomProvider: true })
    const customSettings = {
      ...settings,
      customProviders: [
        {
          id: provider.providerId,
          name: "Saved",
          protocol: "anthropic" as const,
          models: [{ id: "saved", contextLength: 200000, supportsVision: false }],
          subscription: { modelApi: { list: false } },
        },
      ],
    }
    const listed = await listProviderModels({ provider, settings: customSettings })
    expect(listed).toMatchObject({
      freshness: "static",
      models: [{ id: "saved", contextLength: 200000, supportsVision: false }],
    })
    expect(http.providerRequest).not.toHaveBeenCalled()
    const context = {
      descriptor: getProviderOperationDescriptor("models.get")!,
      provider,
      settings: customSettings,
      request: {
        operationId: "models.get" as const,
        scopes: ["provider:read" as const],
        surface: "sidecar" as const,
        input: { model: "saved" },
      },
    }
    expect(await modelsGetHandler.handler(context)).toMatchObject({
      model: { id: "saved", contextLength: 200000 },
      freshness: "static",
    })
    http.providerRequest.mockResolvedValueOnce({
      json: {
        id: "saved",
        max_input_tokens: 100000,
        capabilities: { image_input: { supported: true } },
      },
    })
    expect(
      await modelsGetHandler.handler({
        ...context,
        settings: {
          ...customSettings,
          customProviders: [
            {
              ...customSettings.customProviders[0],
              subscription: { modelApi: { list: true, retrieve: true } },
            },
          ],
        },
      })
    ).toMatchObject({
      model: { id: "saved", contextLength: 100000, supportsVision: true },
      freshness: "fresh",
    })
    expect(http.providerRequest.mock.calls[0][1].path).toBe("models/saved")
  })

  it("rejects unsupported custom subscription protocols without a speculative request", async () => {
    await expect(
      listProviderModels({
        provider: resolved("custom", "google", { isCustomProvider: true }),
        settings: {
          ...settings,
          customProviders: [
            {
              id: "custom",
              name: "Invalid",
              protocol: "google",
              subscription: { modelApi: { list: true } },
            },
          ],
        },
      })
    ).rejects.toThrow("invalid model API")
    expect(http.providerRequest).not.toHaveBeenCalled()
  })
})
