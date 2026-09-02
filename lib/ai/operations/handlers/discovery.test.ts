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
jest.mock("@/lib/claude/feature-call", () => ({ discoverBedrockModelsViaSidecar: jest.fn() }))
const featureCall = jest.requireMock("@/lib/claude/feature-call") as {
  discoverBedrockModelsViaSidecar: jest.Mock
}
jest.mock("./http", () => ({ providerRequest: jest.fn() }))
const http = jest.requireMock("./http") as { providerRequest: jest.Mock }

import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import { DISCOVERY_HANDLERS, listProviderModels, modelsGetHandler } from "./discovery"

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
  beforeEach(() => jest.clearAllMocks())

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
    expect(output.source).toBe("remote")
    expect(output.remoteLastFetchedAt).toBe(5)
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
    expect(output.source).toBe("catalog")
  })

  it("uses the vendor lister before the protocol one, and honours remote: false", async () => {
    discovery.discoverOpenRouterModels.mockResolvedValueOnce([{ id: "or/x" }])
    const output = await listProviderModels({
      provider: resolved("openrouter", "openai"),
      settings,
    })
    expect(discovery.discoverOpenRouterModels).toHaveBeenCalledWith("k")
    expect(discovery.discoverOpenAICompatibleModels).not.toHaveBeenCalled()
    expect(output.models.map((model) => model.id)).toContain("or/x")

    await listProviderModels({
      provider: resolved("openrouter", "openai"),
      settings,
      remote: false,
    })
    expect(discovery.discoverOpenRouterModels).toHaveBeenCalledTimes(1)
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
    expect(output.model).toMatchObject({ id: "curated-1", source: "user-curated" })
    await expect(modelsGetHandler.handler(ctx("missing"))).rejects.toMatchObject({
      failure: { code: "model-unavailable" },
    })
  })
})
