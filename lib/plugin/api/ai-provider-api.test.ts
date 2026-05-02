/**
 * Tests for AI Provider Plugin API
 */

import { embedMany, streamText } from "ai"
import {
  createFeatureProviderClient,
  createFeatureProviderModel,
  resolveFeatureProvider,
} from "@/lib/ai/provider-consumption"
import {
  createAIProviderAPI,
  getCustomAIProviders,
  clearCustomAIProviders,
} from "./ai-provider-api"
import type {
  AIProviderDefinition,
  AIChatChunk,
  AIChatMessage,
} from "@/types/plugin/plugin-extended"

// Mock the settings store
jest.mock("@/stores", () => ({
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
  embedMany: jest.fn(),
}))

jest.mock("@/lib/ai/provider-consumption", () => ({
  createProviderSettingsSnapshot: jest.fn((input) => input),
  resolveFeatureProvider: jest.fn(),
  createFeatureProviderModel: jest.fn(),
  createFeatureProviderClient: jest.fn(),
}))

const mockStreamText = streamText as jest.MockedFunction<typeof streamText>
const mockEmbedMany = embedMany as jest.MockedFunction<typeof embedMany>
const mockResolveFeatureProvider = resolveFeatureProvider as jest.MockedFunction<
  typeof resolveFeatureProvider
>
const mockCreateFeatureProviderModel = createFeatureProviderModel as jest.MockedFunction<
  typeof createFeatureProviderModel
>
const mockCreateFeatureProviderClient = createFeatureProviderClient as jest.MockedFunction<
  typeof createFeatureProviderClient
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
    mockCreateFeatureProviderClient.mockReturnValue({
      embedding: jest.fn(() => ({ id: "built-in-embedding-model" })),
    } as never)
    mockStreamText.mockReturnValue({
      textStream: (async function* () {
        yield "Hello"
        yield " from built-in"
      })(),
    } as never)
    mockEmbedMany.mockResolvedValue({
      embeddings: [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ],
    } as never)
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
      expect(mockCreateFeatureProviderClient).toHaveBeenCalled()
      expect(mockEmbedMany).toHaveBeenCalled()
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
      expect(mockEmbedMany).not.toHaveBeenCalled()
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
