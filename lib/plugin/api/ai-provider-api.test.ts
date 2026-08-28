/**
 * Tests for AI Provider Plugin API
 */

import { streamText } from "ai"
import { createFeatureProviderModel, resolveFeatureProvider } from "@/lib/ai/provider-consumption"
import { generateEmbeddings } from "@cognia/vector/embedding"
import {
  createAIProviderAPI,
  getCustomAIProviders,
  clearCustomAIProviders,
  clearCustomAIProvidersByPlugin,
} from "./ai-provider-api"
import { initializePluginPermissions } from "./permission-api"
import {
  __resetPluginHostRuntimesForTesting,
  disableAmbientHostRuntime,
  registerSessionHostRuntime,
} from "@/lib/plugin/runtime/host-runtime"
import {
  getProtocolAdapter,
  getCodeAdapterExecutor,
  __resetProtocolAdaptersForTesting,
} from "@cognia/provider-core/providers/protocol-adapter-registry"
import type { AIProviderDefinition, AIChatChunk, AIChatMessage } from "@/types/plugin/plugin"
import type { CodeAdapterChunk } from "@/types/plugin/plugin-protocol-adapter"

// Mock the settings store
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: {
    getState: jest.fn(() => ({
      defaultProvider: "openai",
      providerSettings: {
        openai: {
          providerId: "openai",
          apiKey: "sk-openai",
          enabled: true,
          defaultModel: "gpt-4o",
        },
      },
      customProviders: {},
    })),
  },
}))

jest.mock("ai", () => ({
  streamText: jest.fn(),
}))

jest.mock("@cognia/vector/embedding", () => ({
  generateEmbeddings: jest.fn(),
}))

jest.mock("@/lib/ai/provider-consumption", () => ({
  createProviderSettingsSnapshot: jest.fn((input) => input),
  resolveFeatureProvider: jest.fn(),
  createFeatureProviderModel: jest.fn(),
}))

const mockStreamText = streamText as jest.MockedFunction<typeof streamText>
const mockGenerateEmbeddings = generateEmbeddings as jest.MockedFunction<typeof generateEmbeddings>
const mockResolveFeatureProvider = resolveFeatureProvider as jest.MockedFunction<
  typeof resolveFeatureProvider
>
const mockCreateFeatureProviderModel = createFeatureProviderModel as jest.MockedFunction<
  typeof createFeatureProviderModel
>

async function collectChunks(iterable: AsyncIterable<AIChatChunk>): Promise<AIChatChunk[]> {
  const chunks: AIChatChunk[] = []
  for await (const chunk of iterable) {
    chunks.push(chunk)
  }
  return chunks
}

describe("AI Provider API", () => {
  const testPluginId = "test-plugin"

  beforeEach(() => {
    // Clear custom providers before each test
    clearCustomAIProviders()
    __resetProtocolAdaptersForTesting()
    jest.clearAllMocks()

    mockResolveFeatureProvider.mockReturnValue({
      kind: "resolved",
      featureId: "plugin-ai-provider-fallback",
      routeProfile: "general-text",
      providerId: "openai",
      model: "gpt-4o",
      apiKey: "sk-openai",
      baseURL: "https://api.openai.com/v1",
      protocol: "openai",
      isCustomProvider: false,
      executionMode: "direct-model",
      useProxy: false,
      attemptedProviderIds: ["openai"],
      fallbackProviderIds: [],
    })
    mockCreateFeatureProviderModel.mockReturnValue({ id: "built-in-chat-model" } as never)
    mockStreamText.mockReturnValue({
      textStream: (async function* () {
        yield "Hello"
        yield " from built-in"
      })(),
    } as never)
    mockGenerateEmbeddings.mockResolvedValue({
      embeddings: [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ],
      model: "text-embedding-3-small",
      provider: "openai",
    })
  })

  describe("createAIProviderAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createAIProviderAPI(testPluginId)

      expect(api).toBeDefined()
      expect(typeof api.registerProvider).toBe("function")
      expect(typeof api.getAvailableModels).toBe("function")
      expect(typeof api.getProviderModels).toBe("function")
      expect(typeof api.chat).toBe("function")
      expect(typeof api.embed).toBe("function")
      expect(typeof api.getDefaultModel).toBe("function")
      expect(typeof api.getDefaultProvider).toBe("function")
    })
  })

  describe("registerProvider", () => {
    it("should register a custom AI provider", () => {
      const api = createAIProviderAPI(testPluginId)

      const provider: AIProviderDefinition = {
        id: "custom-provider",
        name: "Custom Provider",
        description: "Test provider description",
        models: [
          {
            id: "custom-model",
            name: "Custom Model",
            provider: "custom-provider",
            contextLength: 4096,
            capabilities: ["chat"],
          },
        ],
        chat: async function* () {
          yield { content: "test" }
        },
      }

      const unregister = api.registerProvider(provider)

      expect(typeof unregister).toBe("function")

      const providers = getCustomAIProviders()
      expect(providers.length).toBe(1)
      expect(providers[0].name).toBe("Custom Provider")
    })

    it("should prefix provider ID with plugin ID", () => {
      const api = createAIProviderAPI(testPluginId)

      const provider: AIProviderDefinition = {
        id: "my-provider",
        name: "My Provider",
        description: "Test provider",
        models: [],
        chat: async function* () {
          yield { content: "test" }
        },
      }

      api.registerProvider(provider)

      const providers = getCustomAIProviders()
      expect(providers[0].id).toBe(`${testPluginId}:my-provider`)
    })

    it("should unregister provider when cleanup function is called", () => {
      const api = createAIProviderAPI(testPluginId)

      const provider: AIProviderDefinition = {
        id: "temp-provider",
        name: "Temp Provider",
        description: "Temp provider",
        models: [],
        chat: async function* () {
          yield { content: "test" }
        },
      }

      const unregister = api.registerProvider(provider)
      expect(getCustomAIProviders().length).toBe(1)

      unregister()
      expect(getCustomAIProviders().length).toBe(0)
    })

    it("registers a renderer code protocol adapter so the provider routes through chat() (not protocol:openai)", () => {
      const api = createAIProviderAPI(testPluginId)
      const id = `${testPluginId}:llm-provider`
      const unregister = api.registerProvider({
        id: "llm-provider",
        name: "LLM Provider",
        description: "",
        models: [],
        chat: async function* () {
          yield { content: "hi" }
        },
      })
      // A namespaced code protocol adapter + a renderer executor are registered,
      // so build-options resolves {kind:"code"} and the agent send invokes chat().
      expect(getProtocolAdapter(id)?.spec).toEqual({ kind: "code" })
      expect(getCodeAdapterExecutor(id)).toBeDefined()
      // Cleanup drops both.
      unregister()
      expect(getProtocolAdapter(id)).toBeUndefined()
      expect(getCodeAdapterExecutor(id)).toBeUndefined()
    })

    it("bridges the provider chat() stream into CodeAdapterChunks (text-delta + finish + usage)", async () => {
      const api = createAIProviderAPI(testPluginId)
      const id = `${testPluginId}:stream-provider`
      api.registerProvider({
        id: "stream-provider",
        name: "Stream Provider",
        description: "",
        models: [],
        chat: async function* () {
          yield { content: "Hello" }
          yield {
            content: " world",
            finishReason: "stop",
            usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
          }
        },
      })
      const factory = getCodeAdapterExecutor(id)!
      const adapter = await factory({ adapterId: id, pluginId: testPluginId })
      const chunks: CodeAdapterChunk[] = []
      for await (const c of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        modelParams: { temperature: 0.5 },
        credentials: {},
      })) {
        chunks.push(c)
      }
      expect(chunks).toEqual([
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " world" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        },
      ])
    })

    it("maps AI SDK modelParams into plugin chat options for code adapters", async () => {
      const api = createAIProviderAPI(testPluginId)
      const id = `${testPluginId}:options-provider`
      let capturedOptions: unknown
      api.registerProvider({
        id: "options-provider",
        name: "Options Provider",
        description: "",
        models: [],
        chat: async function* (_messages, options) {
          capturedOptions = options
          yield { content: "ok" }
        },
      })

      const factory = getCodeAdapterExecutor(id)!
      const adapter = await factory({ adapterId: id, pluginId: testPluginId })
      for await (const _chunk of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        modelParams: {
          temperature: 0.2,
          maxOutputTokens: 128,
          topP: 0.8,
          stopSequences: ["</done>"],
        },
        credentials: {},
      })) {
        // drain
      }

      expect(capturedOptions).toEqual({
        model: "m",
        temperature: 0.2,
        maxTokens: 128,
        topP: 0.8,
        stop: ["</done>"],
      })
    })
  })

  describe("getAvailableModels", () => {
    it("should return models from custom providers", () => {
      const api = createAIProviderAPI(testPluginId)

      const provider: AIProviderDefinition = {
        id: "provider-1",
        name: "Provider 1",
        description: "Provider 1 description",
        models: [
          {
            id: "model-a",
            name: "Model A",
            provider: "provider-1",
            contextLength: 4096,
            capabilities: ["chat"],
          },
          {
            id: "model-b",
            name: "Model B",
            provider: "provider-1",
            contextLength: 8192,
            capabilities: ["chat"],
          },
        ],
        chat: async function* () {
          yield { content: "test" }
        },
      }

      api.registerProvider(provider)

      const models = api.getAvailableModels()
      expect(models.length).toBe(2)
      expect(models[0].id).toBe("model-a")
      expect(models[1].id).toBe("model-b")
    })

    it("should return empty array when no providers registered", () => {
      const api = createAIProviderAPI(testPluginId)

      const models = api.getAvailableModels()
      expect(models).toEqual([])
    })
  })

  describe("getProviderModels", () => {
    it("should return models for a specific provider", () => {
      const api = createAIProviderAPI(testPluginId)

      const provider: AIProviderDefinition = {
        id: "specific-provider",
        name: "Specific Provider",
        description: "Specific provider description",
        models: [
          {
            id: "specific-model",
            name: "Specific Model",
            provider: "specific-provider",
            contextLength: 4096,
            capabilities: ["chat"],
          },
        ],
        chat: async function* () {
          yield { content: "test" }
        },
      }

      api.registerProvider(provider)

      const models = api.getProviderModels(`${testPluginId}:specific-provider`)
      expect(models.length).toBe(1)
      expect(models[0].id).toBe("specific-model")
    })

    it("should return empty array for non-existent provider", () => {
      const api = createAIProviderAPI(testPluginId)

      const models = api.getProviderModels("non-existent")
      expect(models).toEqual([])
    })
  })

  describe("chat", () => {
    it("should fallback to the configured built-in provider when no custom provider matches", async () => {
      const api = createAIProviderAPI(testPluginId)

      const messages: AIChatMessage[] = [{ role: "user", content: "Hello" }]

      const chunks = await collectChunks(api.chat(messages))

      expect(chunks.map((chunk) => chunk.content)).toEqual(["Hello", " from built-in"])
      expect(mockCreateFeatureProviderModel).toHaveBeenCalled()
      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { id: "built-in-chat-model" },
          messages,
        })
      )
    })

    it("should use custom provider when model matches", async () => {
      const api = createAIProviderAPI(testPluginId)

      const provider: AIProviderDefinition = {
        id: "chat-provider",
        name: "Chat Provider",
        description: "Chat provider description",
        models: [
          {
            id: "chat-model",
            name: "Chat Model",
            provider: "chat-provider",
            contextLength: 4096,
            capabilities: ["chat"],
          },
        ],
        chat: async function* () {
          yield { content: "Hello from custom provider!" }
          yield { content: " More content", finishReason: "stop" }
        },
      }

      api.registerProvider(provider)

      const messages: AIChatMessage[] = [{ role: "user", content: "Hello" }]

      const chunks = await collectChunks(api.chat(messages, { model: "chat-model" }))

      expect(chunks.length).toBe(2)
      expect(chunks[0].content).toBe("Hello from custom provider!")
      expect(mockStreamText).not.toHaveBeenCalled()
    })

    it("hoists a leading system message out of messages into instructions", async () => {
      // AI SDK 7 rejects `{ role: "system" }` inside `messages`, and plugin
      // histories routinely lead with one.
      const api = createAIProviderAPI(testPluginId)

      await collectChunks(
        api.chat([
          { role: "system", content: "You are terse." },
          { role: "user", content: "Hello" },
        ])
      )

      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: [{ role: "system", content: "You are terse." }],
          messages: [{ role: "user", content: "Hello" }],
        })
      )
      expect(mockStreamText.mock.calls[0][0]).not.toHaveProperty("allowSystemInMessages")
    })

    it("keeps a mid-history system message in place and opts it back in", async () => {
      const api = createAIProviderAPI(testPluginId)

      await collectChunks(
        api.chat([
          { role: "user", content: "Hello" },
          { role: "system", content: "Switch to bullet points." },
        ])
      )

      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: "user", content: "Hello" },
            { role: "system", content: "Switch to bullet points." },
          ],
          allowSystemInMessages: true,
        })
      )
    })

    it("maps the plugin-facing maxTokens onto the AI SDK maxOutputTokens option", async () => {
      // `maxTokens` has not been an AI SDK option since v5 — the cap used to be
      // silently dropped, leaving plugin output unbounded.
      const api = createAIProviderAPI(testPluginId)

      await collectChunks(api.chat([{ role: "user", content: "Hello" }], { maxTokens: 256 }))

      expect(mockStreamText).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 256 }))
      expect(mockStreamText.mock.calls[0][0]).not.toHaveProperty("maxTokens")
    })

    it("forwards the remaining sampling options under their AI SDK names", async () => {
      const api = createAIProviderAPI(testPluginId)

      await collectChunks(
        api.chat([{ role: "user", content: "Hello" }], {
          temperature: 0.3,
          topP: 0.9,
          stop: ["</end>"],
        })
      )

      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.3,
          topP: 0.9,
          stopSequences: ["</end>"],
        })
      )
    })

    it("omits sampling options the caller did not set", async () => {
      const api = createAIProviderAPI(testPluginId)

      await collectChunks(api.chat([{ role: "user", content: "Hello" }], { stop: [] }))

      const call = mockStreamText.mock.calls[0][0]
      expect(call).not.toHaveProperty("temperature")
      expect(call).not.toHaveProperty("topP")
      expect(call).not.toHaveProperty("stopSequences")
      expect(call).not.toHaveProperty("maxOutputTokens")
    })

    it("should forward an abort signal to the underlying stream", async () => {
      const api = createAIProviderAPI(testPluginId)
      const controller = new AbortController()

      await collectChunks(
        api.chat([{ role: "user", content: "Hello" }], { signal: controller.signal })
      )

      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({ abortSignal: controller.signal })
      )
    })

    it("should surface end-of-stream token usage on a trailing chunk", async () => {
      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          yield "Hi"
        })(),
        usage: Promise.resolve({ inputTokens: 12, outputTokens: 4, totalTokens: 16 }),
      } as never)

      const api = createAIProviderAPI(testPluginId)
      const chunks = await collectChunks(api.chat([{ role: "user", content: "Hello" }]))

      const usageChunk = chunks.find((c) => c.usage)
      expect(usageChunk?.usage).toEqual({
        promptTokens: 12,
        completionTokens: 4,
        totalTokens: 16,
      })
    })

    it("should not emit a usage chunk when the provider reports none", async () => {
      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          yield "Hi"
        })(),
        // no usage promise — mirrors providers that don't report counts
      } as never)

      const api = createAIProviderAPI(testPluginId)
      const chunks = await collectChunks(api.chat([{ role: "user", content: "Hello" }]))

      expect(chunks.every((c) => c.usage === undefined)).toBe(true)
      expect(chunks.map((c) => c.content)).toEqual(["Hi"])
    })

    it("should throw a structured NO_PROVIDER_AVAILABLE error when built-in fallback is unavailable", async () => {
      mockResolveFeatureProvider.mockReturnValue({
        kind: "blocked",
        featureId: "plugin-ai-provider-fallback",
        routeProfile: "general-text",
        providerId: "openai",
        code: "missing_credential",
        reason: "Add an API key before using this provider at runtime.",
        nextAction: "add_api_key",
        attemptedProviderIds: ["openai"],
        fallbackProviderIds: [],
        supportedProviderIds: ["openai"],
      })

      const api = createAIProviderAPI(testPluginId)

      await expect(
        collectChunks(api.chat([{ role: "user", content: "Hello" }]))
      ).rejects.toMatchObject({
        code: "NO_PROVIDER_AVAILABLE",
        suggestion: expect.stringContaining("API key"),
      })
    })
  })

  describe("embed", () => {
    it("should fallback to the configured built-in embedding provider when no custom embed provider exists", async () => {
      const api = createAIProviderAPI(testPluginId)

      const result = await api.embed(["text1", "text2"])

      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ])
      expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
        ["text1", "text2"],
        expect.objectContaining({ provider: "openai", model: "text-embedding-3-small" }),
        "sk-openai"
      )
    })

    it("should use custom provider embedding function when available", async () => {
      const api = createAIProviderAPI(testPluginId)

      const provider: AIProviderDefinition = {
        id: "embed-provider",
        name: "Embed Provider",
        description: "Embed provider description",
        models: [],
        chat: async function* () {
          yield { content: "test" }
        },
        embed: async (texts: string[]) => {
          return texts.map(() => [0.1, 0.2, 0.3])
        },
      }

      api.registerProvider(provider)

      const result = await api.embed(["text1", "text2"])

      expect(result.length).toBe(2)
      expect(result[0]).toEqual([0.1, 0.2, 0.3])
      expect(mockGenerateEmbeddings).not.toHaveBeenCalled()
    })

    it("uses the canonical Bedrock embedding adapter for default-chain credentials", async () => {
      mockResolveFeatureProvider.mockReturnValue({
        kind: "resolved",
        featureId: "plugin-ai-provider-fallback",
        routeProfile: "general-text",
        providerId: "bedrock",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        apiKey: undefined,
        baseURL: undefined,
        bedrock: { authMode: "default-chain", region: "us-west-2", profile: "dev" },
        protocol: "bedrock",
        isCustomProvider: false,
        executionMode: "direct-model",
        useProxy: true,
        attemptedProviderIds: ["bedrock"],
        fallbackProviderIds: [],
      })
      mockGenerateEmbeddings.mockResolvedValueOnce({
        embeddings: [[0.5]],
        model: "amazon.titan-embed-text-v2:0",
        provider: "amazon-bedrock",
      })

      const result = await createAIProviderAPI(testPluginId).embed(["safe text"])

      expect(result).toEqual([[0.5]])
      expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
        ["safe text"],
        expect.objectContaining({
          provider: "amazon-bedrock",
          bedrock: expect.objectContaining({ authMode: "default-chain", profile: "dev" }),
        }),
        ""
      )
    })

    it("should throw NO_PROVIDER_AVAILABLE when no custom or built-in embedding provider can be used", async () => {
      mockResolveFeatureProvider.mockReturnValue({
        kind: "blocked",
        featureId: "plugin-ai-provider-fallback",
        routeProfile: "general-text",
        providerId: "openai",
        code: "missing_credential",
        reason: "Add an API key before using this provider at runtime.",
        nextAction: "add_api_key",
        attemptedProviderIds: ["openai"],
        fallbackProviderIds: [],
        supportedProviderIds: ["openai"],
      })

      const api = createAIProviderAPI(testPluginId)

      await expect(api.embed(["text1"])).rejects.toMatchObject({
        code: "NO_PROVIDER_AVAILABLE",
        suggestion: expect.stringContaining("API key"),
      })
    })
  })

  describe("getDefaultModel", () => {
    it("should return default model from settings", () => {
      const api = createAIProviderAPI(testPluginId)

      const defaultModel = api.getDefaultModel()
      expect(defaultModel).toBe("gpt-4o")
    })
  })

  describe("getDefaultProvider", () => {
    it("should return default provider from settings", () => {
      const api = createAIProviderAPI(testPluginId)

      const defaultProvider = api.getDefaultProvider()
      expect(defaultProvider).toBe("openai")
    })
  })

  describe("session-scoped hosts", () => {
    afterEach(() => {
      __resetPluginHostRuntimesForTesting()
    })

    it("answers from the named session's runtime", () => {
      registerSessionHostRuntime("s-42", () => ({
        runHostTool: async () => ({}),
        chat: async function* () {},
        embed: async () => [],
        getDefaultProvider: () => "anthropic",
        getDefaultModel: () => "claude-sonnet",
      }))
      disableAmbientHostRuntime()
      const api = createAIProviderAPI(testPluginId)

      expect(api.getDefaultModel({ sessionId: "s-42" })).toBe("claude-sonnet")
      expect(api.getDefaultProvider({ sessionId: "s-42" })).toBe("anthropic")
    })

    it("degrades to '' instead of throwing out of a sync getter", () => {
      // The CLI turns ambient resolution off, so an unrouted call has no honest
      // answer. These two are introspection, not spend — throwing from a
      // `() => string` left the plugin no recovery, while `chat`/`embed`, which
      // DO spend the user's quota, still fail loudly.
      disableAmbientHostRuntime()
      const api = createAIProviderAPI(testPluginId)

      expect(api.getDefaultModel()).toBe("")
      expect(api.getDefaultProvider()).toBe("")
      expect(api.getDefaultModel({ sessionId: "unbound" })).toBe("")
    })
  })

  describe("getCustomAIProviders", () => {
    it("should return all registered custom providers", () => {
      const api = createAIProviderAPI(testPluginId)

      const provider1: AIProviderDefinition = {
        id: "provider-1",
        name: "Provider 1",
        description: "Provider 1 description",
        models: [
          {
            id: "model-a",
            name: "Model A",
            provider: "provider-1",
            contextLength: 4096,
            capabilities: ["chat"],
          },
          {
            id: "model-b",
            name: "Model B",
            provider: "provider-1",
            contextLength: 8192,
            capabilities: ["chat"],
          },
        ],
        chat: async function* () {
          yield { content: "test" }
        },
      }

      const provider2: AIProviderDefinition = {
        id: "provider-2",
        name: "Provider 2",
        description: "Provider 2",
        models: [],
        chat: async function* () {
          yield { content: "test" }
        },
      }

      api.registerProvider(provider1)
      api.registerProvider(provider2)

      const providers = getCustomAIProviders()
      expect(providers.length).toBe(2)
    })
  })
})

// W2.3: the AI API is permission-gated; grant the suite's plugin its perms.
beforeAll(() => {
  initializePluginPermissions("test-plugin", ["ai:chat", "ai:embed"])
})

describe("permission gate", () => {
  it("throws PermissionError when ai:chat is not granted", () => {
    const api = createAIProviderAPI("no-perms-plugin")
    expect(() => api.chat([], {})).toThrow(/ai:chat/)
  })
})

describe("PII gate (W2.4)", () => {
  it("blocks chat when a message leaks PII", async () => {
    const api = createAIProviderAPI("test-plugin")
    const messages: AIChatMessage[] = [{ role: "user", content: "email me at leak@example.com" }]
    // chat is an async generator — the gate throws on the first pull,
    // before anything is dispatched to a provider.
    await expect(api.chat(messages)[Symbol.asyncIterator]().next()).rejects.toThrow(/PII/)
  })

  it("blocks embed when a text leaks PII", async () => {
    const api = createAIProviderAPI("test-plugin")
    await expect(api.embed(["sk-ant-api03-abcdefghijklmnopqrstuvwx"])).rejects.toThrow(/PII/)
  })
})

describe("clearCustomAIProvidersByPlugin (W4.3)", () => {
  it("removes only the plugin's providers and their adapter registrations", () => {
    const api = createAIProviderAPI("owner")
    api.registerProvider({
      id: "prov",
      name: "Owner Provider",
      models: [{ id: "m1", name: "M1", capabilities: ["chat"] }],
      chat: async function* () {
        yield { content: "x" }
      },
    } as never)
    const otherApi = createAIProviderAPI("other")
    otherApi.registerProvider({
      id: "prov",
      name: "Other Provider",
      models: [{ id: "m2", name: "M2", capabilities: ["chat"] }],
      chat: async function* () {
        yield { content: "y" }
      },
    } as never)

    expect(getCustomAIProviders().map((p) => p.id)).toEqual(
      expect.arrayContaining(["owner:prov", "other:prov"])
    )

    expect(clearCustomAIProvidersByPlugin("owner")).toBe(1)
    const remaining = getCustomAIProviders().map((p) => p.id)
    expect(remaining).not.toContain("owner:prov")
    expect(remaining).toContain("other:prov")
    expect(getProtocolAdapter("owner:prov")).toBeUndefined()

    clearCustomAIProvidersByPlugin("other")
  })
})
