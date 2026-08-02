/**
 * Plugin AI Provider API Implementation
 *
 * Provides AI provider capabilities to plugins.
 */

import { streamText, type ModelMessage } from "ai"
import { partitionPrompt } from "@/lib/ai/prompt-partition"
import {
  createFeatureProviderModel,
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
} from "@/lib/ai/provider-consumption"
import { generateEmbeddings, type EmbeddingProvider } from "@cognia/vector/embedding"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type {
  PluginAIProviderAPI,
  AIProviderDefinition,
  AIModel,
  AIChatMessage,
  AIChatOptions,
  AIChatChunk,
} from "@/types/plugin/plugin"
import { createPluginSystemLogger } from "../core/logger"
import { createApiGuardedAPI } from "./api-permission-gate"
import { assertNoLeakingPii } from "./plugin-pii-gate"
import {
  registerProviderDefinition,
  unregisterProvider,
  type ProviderProtocol,
} from "@cognia/provider-core/providers/provider-loader"
import {
  registerProtocolAdapter,
  registerCodeAdapterExecutor,
  unregisterProtocolAdapter,
  unregisterCodeAdapterExecutor,
} from "@cognia/provider-core/providers/protocol-adapter-registry"
import type {
  CodeAdapterChunk,
  CodeAdapterRequest,
  CodeProtocolAdapterFactory,
} from "@/types/plugin/plugin-protocol-adapter"

// Registry for custom AI providers
const customProviders = new Map<string, AIProviderDefinition>()

/**
 * Bridge a plugin's in-process `AIProviderDefinition.chat()` generator to the
 * renderer-side code-protocol-adapter contract. This is what makes a plugin's
 * `chat()` reachable from the MAIN agent chat: the provider is registered under
 * its own `${pluginId}:${id}` protocol (NOT "openai"), so build-options resolves
 * a `{kind:"code"}` spec and the `protocol_adapter_exec` round-trip invokes this
 * factory in the renderer (where plugin code legitimately runs) instead of
 * dispatching a generic OpenAI-compatible HTTP call that never reaches `chat()`.
 */
function buildPluginLlmCodeAdapter(provider: AIProviderDefinition): CodeProtocolAdapterFactory {
  return () => ({
    stream: async function* (req: CodeAdapterRequest): AsyncIterable<CodeAdapterChunk> {
      try {
        const messages: AIChatMessage[] = req.messages.map((m) => ({
          role: m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        }))
        const options: AIChatOptions = {
          model: req.model,
          temperature:
            typeof req.modelParams?.temperature === "number"
              ? req.modelParams.temperature
              : undefined,
          maxTokens:
            typeof req.modelParams?.maxOutputTokens === "number"
              ? req.modelParams.maxOutputTokens
              : undefined,
          topP: typeof req.modelParams?.topP === "number" ? req.modelParams.topP : undefined,
          stop: Array.isArray(req.modelParams?.stopSequences)
            ? req.modelParams.stopSequences.filter(
                (value): value is string => typeof value === "string"
              )
            : undefined,
        }
        for await (const chunk of provider.chat(messages, options)) {
          if (chunk.content) yield { type: "text-delta", text: chunk.content }
          if (chunk.finishReason || chunk.usage) {
            yield {
              type: "finish",
              finishReason: chunk.finishReason,
              usage: chunk.usage
                ? {
                    promptTokens: chunk.usage.promptTokens,
                    completionTokens: chunk.usage.completionTokens,
                    totalTokens: chunk.usage.totalTokens,
                  }
                : undefined,
            }
          }
        }
      } catch (err) {
        // A code adapter must not throw the whole stream — yield an error chunk.
        yield { type: "error", error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}

type PluginAIProviderStructuredError = Error & {
  code: "NO_PROVIDER_AVAILABLE"
  suggestion: string
  details?: unknown
}

type EmbeddingCapableProviderId = "openai" | "google" | "cohere" | "mistral" | "bedrock"

const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingCapableProviderId, string> = {
  openai: "text-embedding-3-small",
  google: "text-embedding-004",
  cohere: "embed-english-v3.0",
  mistral: "mistral-embed",
  bedrock: "amazon.titan-embed-text-v2:0",
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
  const api: PluginAIProviderAPI = {
    registerProvider: (provider: AIProviderDefinition) => {
      const providerId = `${pluginId}:${provider.id}`
      const scopedProvider = { ...provider, id: providerId }
      customProviders.set(providerId, scopedProvider)
      logger.info(`Registered AI provider: ${provider.name}`)

      // Register a renderer-side code protocol adapter so the plugin's in-process
      // chat() generator is reachable from the MAIN agent chat (not just the
      // plugin's own ctx.ai.chat). Without this, the provider was registered with
      // protocol:"openai" → build-options resolved a no-op adapter and dispatched
      // a generic OpenAI HTTP call, so chat() was never invoked. Reserved ids are
      // refused by the registry, but `${pluginId}:${id}` is always namespaced.
      const protocolRegistered = registerProtocolAdapter(
        { id: providerId, label: provider.name, spec: { kind: "code" } },
        { pluginId }
      )
      if (protocolRegistered) {
        registerCodeAdapterExecutor(providerId, buildPluginLlmCodeAdapter(scopedProvider), pluginId)
      }

      // Also register in the dynamic provider loader so the provider
      // appears in the settings UI and projection system. The protocol is the
      // namespaced code-adapter id when registration succeeded, so a chat send
      // routes through protocol_adapter_exec → the plugin's chat() generator.
      try {
        registerProviderDefinition(
          {
            id: providerId,
            name: provider.name,
            type: "cloud",
            // The namespaced code-adapter id is not a member of the built-in
            // `ProviderProtocol` union, but build-options routes on this string
            // verbatim (getProtocolAdapter) — the cast is the single bridge.
            protocol: (protocolRegistered ? providerId : "openai") as ProviderProtocol,
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
        if (protocolRegistered) {
          unregisterProtocolAdapter(providerId)
          unregisterCodeAdapterExecutor(providerId)
        }
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
      // PII red-line (same gate as Twin/Goal/Connector): plugin-driven sends
      // have no human review, so leaking content aborts before dispatch.
      assertNoLeakingPii(
        pluginId,
        "ctx.ai.chat",
        messages.map((m) => m.content)
      )
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
      // Plugin-supplied histories routinely lead with a system turn; AI SDK 7
      // rejects `{ role: "system" }` inside `messages`, so hoist it into the
      // top-level instructions option.
      const streamOptions: Record<string, unknown> = {
        model,
        ...partitionPrompt(messages as ModelMessage[]),
      }
      if (options?.temperature !== undefined) {
        streamOptions.temperature = options.temperature
      }
      if (options?.maxTokens !== undefined) {
        // `AIChatOptions.maxTokens` is the plugin-facing name; the AI SDK option
        // has been `maxOutputTokens` since v5, so the old key was silently
        // dropped and every plugin cap went unenforced.
        streamOptions.maxOutputTokens = options.maxTokens
      }
      if (options?.topP !== undefined) {
        streamOptions.topP = options.topP
      }
      if (options?.stop?.length) {
        streamOptions.stopSequences = options.stop
      }
      if (options?.signal) {
        streamOptions.abortSignal = options.signal
      }

      const result = streamText(streamOptions as Parameters<typeof streamText>[0])
      for await (const chunk of result.textStream) {
        yield { content: chunk }
      }

      // Surface end-of-stream token usage on a trailing chunk so plugins can
      // track cost. `streamText` resolves `.usage` after the stream drains;
      // only emit when the provider actually reported counts. Tolerates both
      // the AI-SDK field naming (`inputTokens`/`outputTokens`) and the legacy
      // `promptTokens`/`completionTokens` shape.
      const usage = (await Promise.resolve(result.usage).catch(() => undefined)) as
        Record<string, number | undefined> | undefined
      const promptTokens = usage?.inputTokens ?? usage?.promptTokens
      const completionTokens = usage?.outputTokens ?? usage?.completionTokens
      if (typeof promptTokens === "number" || typeof completionTokens === "number") {
        const p = promptTokens ?? 0
        const c = completionTokens ?? 0
        yield {
          content: "",
          finishReason: "stop",
          usage: { promptTokens: p, completionTokens: c, totalTokens: usage?.totalTokens ?? p + c },
        }
      }
    },

    embed: async (texts: string[]): Promise<number[][]> => {
      assertNoLeakingPii(pluginId, "ctx.ai.embed", texts)
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

      const embeddingProvider = (
        resolution.providerId === "bedrock" ? "amazon-bedrock" : resolution.providerId
      ) as EmbeddingProvider
      const result = await generateEmbeddings(
        texts,
        {
          provider: embeddingProvider,
          model: embeddingModelId,
          baseURL: resolution.baseURL,
          bedrock: resolution.bedrock,
        },
        resolution.apiKey || ""
      )
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

  // `chat`/`embed` spend the user's model quota — they require the declared
  // ai:* permissions. Registration and model introspection stay ungated:
  // they expose the plugin's OWN providers, not user resources.
  return createApiGuardedAPI(
    pluginId,
    api,
    {
      chat: "ai:chat",
      embed: "ai:embed",
    },
    {
      unguarded: [
        "registerProvider",
        "getAvailableModels",
        "getProviderModels",
        "getDefaultModel",
        "getDefaultProvider",
      ],
    }
  )
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

/**
 * Tear down every runtime-registered AI provider owned by `pluginId` (W4.3).
 * Mirrors the disposer returned by `registerProvider` — without this, a
 * disabled plugin's `chat()` stayed reachable through the provider loader and
 * protocol-adapter registry because only the plugin itself held the disposer.
 * Called by the manager's `unregisterPluginContributions`.
 */
export function clearCustomAIProvidersByPlugin(pluginId: string): number {
  const prefix = `${pluginId}:`
  let removed = 0
  for (const providerId of Array.from(customProviders.keys())) {
    if (!providerId.startsWith(prefix)) continue
    customProviders.delete(providerId)
    try {
      unregisterProvider(providerId)
    } catch {
      // best effort — the loader may not know the id
    }
    unregisterProtocolAdapter(providerId)
    unregisterCodeAdapterExecutor(providerId)
    removed += 1
  }
  return removed
}
