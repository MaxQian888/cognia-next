/**
 * Plugin AI Provider API Implementation
 *
 * Provides AI provider capabilities to plugins.
 */

import { embedMany, streamText } from "ai"
import {
  createFeatureProviderClient,
  createFeatureProviderModel,
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
} from "@/lib/ai/provider-consumption"
import { useSettingsStore } from "@/stores"
import type {
  PluginAIProviderAPI,
  AIProviderDefinition,
  AIModel,
  AIChatMessage,
  AIChatOptions,
  AIChatChunk,
} from "@/types/plugin/plugin-extended"
import { createPluginSystemLogger } from "../core/logger"
import { registerProviderDefinition, unregisterProvider } from "@/lib/ai/providers/provider-loader"

// Registry for custom AI providers
const customProviders = new Map<string, AIProviderDefinition>()

type PluginAIProviderStructuredError = Error & {
  code: "NO_PROVIDER_AVAILABLE"
  suggestion: string
  details?: unknown
}

type EmbeddingCapableProviderId = "openai" | "google" | "cohere" | "mistral"

const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingCapableProviderId, string> = {
  openai: "text-embedding-3-small",
  google: "text-embedding-004",
  cohere: "embed-english-v3.0",
  mistral: "mistral-embed",
}

function createNoProviderAvailableError(
  reason: string,
  nextAction?: string,
  details?: unknown
): PluginAIProviderStructuredError {
  const suggestion = (() => {
    switch (nextAction) {
      case "add_api_key":
        return "在 Settings -> Providers 中为默认 provider 添加 API key。"
      case "enable_provider":
        return "在 Settings -> Providers 中启用默认 provider。"
      case "configure_base_url":
        return "在 Settings -> Providers 中补全默认 provider 的 base URL。"
      case "select_default_model":
        return "在 Settings -> Providers 中为默认 provider 选择可用模型。"
      case "verify_connection":
        return "在 Settings -> Providers 中验证默认 provider 的连接状态。"
      default:
        return "在 Settings -> Providers 中检查默认 built-in provider 的配置。"
    }
  })()

  return Object.assign(new Error(reason), {
    code: "NO_PROVIDER_AVAILABLE" as const,
    suggestion,
    details,
  })
}

function resolveBuiltInProviderFallback() {
  const settings = useSettingsStore.getState()
  const builtInProviderIds = Object.keys(settings.providerSettings || {})
  const preferredBuiltInProvider = builtInProviderIds.includes(settings.defaultProvider)
    ? settings.defaultProvider
    : undefined

  const resolution = resolveFeatureProvider(
    {
      featureId: "plugin-ai-provider-fallback",
      routeProfile: "general-text",
      selectionMode: preferredBuiltInProvider ? "explicit-provider" : "supported-providers",
      providerId: preferredBuiltInProvider,
      supportedProviders: builtInProviderIds,
      fallbackMode: preferredBuiltInProvider ? "ordered" : "first-eligible",
      fallbackProviderOrder: preferredBuiltInProvider
        ? builtInProviderIds.filter((providerId) => providerId !== preferredBuiltInProvider)
        : undefined,
      executionMode: "direct-model",
      proxyMode: "preferred",
    },
    createProviderSettingsSnapshot({
      defaultProvider: settings.defaultProvider,
      providerSettings: settings.providerSettings,
      customProviders: settings.customProviders,
    })
  )

  if (resolution.kind !== "resolved") {
    throw createNoProviderAvailableError(resolution.reason, resolution.nextAction, resolution)
  }

  return resolution
}

/**
 * Create the AI Provider API for a plugin
 */
export function createAIProviderAPI(pluginId: string): PluginAIProviderAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
    registerProvider: (provider: AIProviderDefinition) => {
      const providerId = `${pluginId}:${provider.id}`
      customProviders.set(providerId, { ...provider, id: providerId })
      logger.info(`Registered AI provider: ${provider.name}`)

      // Also register in the dynamic provider loader so the provider
      // appears in the settings UI and projection system.
      try {
        registerProviderDefinition(
          {
            id: providerId,
            name: provider.name,
            type: "cloud",
            protocol: "openai",
            apiKeyRequired: false,
            baseURLRequired: false,
            defaultModel: provider.models[0]?.id || "",
            defaultEnabled: true,
            category: "specialized",
            description: `Plugin provider from ${pluginId}`,
            models: provider.models.map((m) => {
              const capabilities = new Set(m.capabilities)
              return {
                id: m.id,
                name: m.name || m.id,
                contextLength: m.contextLength || 4096,
                supportsTools: capabilities.has("function_calling"),
                supportsVision: capabilities.has("vision"),
                supportsAudio: false,
                supportsVideo: false,
                supportsStreaming: capabilities.has("chat") || capabilities.has("completion"),
              }
            }),
          },
          "plugin"
        )
      } catch {
        // Non-critical: plugin still works even if settings UI integration fails
      }

      return () => {
        customProviders.delete(providerId)
        unregisterProvider(providerId)
        logger.info(`Unregistered AI provider: ${provider.name}`)
      }
    },

    getAvailableModels: (): AIModel[] => {
      const models: AIModel[] = []

      // Add models from custom providers
      for (const provider of customProviders.values()) {
        models.push(...provider.models)
      }

      // Built-in models would be added here from settings
      // For now, return custom provider models only
      return models
    },

    getProviderModels: (providerId: string): AIModel[] => {
      const provider = customProviders.get(providerId)
      return provider?.models || []
    },

    chat: async function* (
      messages: AIChatMessage[],
      options?: AIChatOptions
    ): AsyncIterable<AIChatChunk> {
      // Check for custom provider first
      for (const provider of customProviders.values()) {
        if (options?.model && provider.models.some((m) => m.id === options.model)) {
          // Use this custom provider
          yield* provider.chat(messages, options)
          return
        }
      }

      const resolution = resolveBuiltInProviderFallback()
      const model = createFeatureProviderModel(resolution)
      const streamOptions: Record<string, unknown> = {
        model,
        messages,
      }
      if (options?.temperature !== undefined) {
        streamOptions.temperature = options.temperature
      }
      if (options?.maxTokens !== undefined) {
        streamOptions.maxTokens = options.maxTokens
      }
      if (options?.topP !== undefined) {
        streamOptions.topP = options.topP
      }
      if (options?.stop?.length) {
        streamOptions.stopSequences = options.stop
      }

      const result = streamText(streamOptions as Parameters<typeof streamText>[0])
      for await (const chunk of result.textStream) {
        yield { content: chunk }
      }
    },

    embed: async (texts: string[]): Promise<number[][]> => {
      // Check custom providers for embedding support
      for (const provider of customProviders.values()) {
        if (provider.embed) {
          return provider.embed(texts)
        }
      }

      const resolution = resolveBuiltInProviderFallback()
      const embeddingModelId =
        DEFAULT_EMBEDDING_MODELS[resolution.providerId as EmbeddingCapableProviderId]
      if (!embeddingModelId) {
        throw createNoProviderAvailableError(
          `Built-in provider ${resolution.providerId} does not expose an embedding model for plugin fallback.`,
          "open_provider_settings",
          resolution
        )
      }

      const providerClient = createFeatureProviderClient({
        providerId: resolution.providerId,
        apiKey: resolution.apiKey,
        baseURL: resolution.baseURL,
        protocol: resolution.protocol,
        isCustomProvider: resolution.isCustomProvider,
        useProxy: resolution.useProxy,
      }) as {
        embedding?: (modelId: string) => unknown
        textEmbeddingModel?: (modelId: string) => unknown
      }

      const embeddingModel =
        providerClient.embedding?.(embeddingModelId) ||
        providerClient.textEmbeddingModel?.(embeddingModelId)

      if (!embeddingModel) {
        throw createNoProviderAvailableError(
          `Built-in provider ${resolution.providerId} does not support embedding fallback.`,
          "open_provider_settings",
          resolution
        )
      }

      const result = await embedMany({
        model: embeddingModel as never,
        values: texts,
      })
      return result.embeddings
    },

    getDefaultModel: (): string => {
      const settings = useSettingsStore.getState()
      const provider = settings.providerSettings?.[settings.defaultProvider]
      return provider?.defaultModel || "gpt-4o"
    },

    getDefaultProvider: (): string => {
      return useSettingsStore.getState().defaultProvider
    },
  }
}

/**
 * Get all registered custom AI providers
 */
export function getCustomAIProviders(): AIProviderDefinition[] {
  return Array.from(customProviders.values())
}

/**
 * Clear all custom AI providers (for testing purposes)
 */
export function clearCustomAIProviders(): void {
  customProviders.clear()
}
