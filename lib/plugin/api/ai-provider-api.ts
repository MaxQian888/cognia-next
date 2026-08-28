/**
 * Plugin AI Provider API Implementation
 *
 * Provides AI provider capabilities to plugins.
 */

import type {
  PluginAIProviderAPI,
  AIProviderDefinition,
  AIModel,
  AIChatMessage,
  AIChatOptions,
  AIChatChunk,
  AIEmbedOptions,
} from "@/types/plugin/plugin"
import {
  PluginHostRuntimeUnavailableError,
  resolvePluginHostRuntime,
  type PluginHostRuntime,
} from "@/lib/plugin/runtime/host-runtime"
import type { PluginInvocationOptions } from "@/types/plugin/plugin-host-tools"
import { createPluginSystemLogger } from "../core/logger"
import { createApiGuardedAPI } from "./api-permission-gate"
import { assertNoLeakingPii } from "./plugin-pii-gate"
import { refreshAllPackWarnings } from "@/lib/plugin/registries/character-pack-registry"
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

/**
 * Resolve the runtime that answers this call. `sessionId` comes off the call's
 * own options rather than an ambient "current session": on the CLI several
 * sessions share the process, each with its own provider and key, and picking
 * the wrong one silently bills the wrong account.
 */
function hostRuntime(
  pluginId: string,
  options?: { sessionId?: string; messageId?: string }
): PluginHostRuntime {
  return resolvePluginHostRuntime({
    pluginId,
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.messageId ? { messageId: options.messageId } : {}),
  })
}

/**
 * Read one synchronous default off the resolved runtime.
 *
 * These two are introspection, not spend: they answer "what would this host
 * pick?". On a session-scoped host (the CLI) an unrouted call has no honest
 * answer, and throwing out of a `() => string` getter leaves the plugin no
 * recovery — so it degrades to `""` ("unknown") and the next `chat`/`embed`,
 * which DOES spend the user's quota, still fails loudly with the routing
 * error. Passing `sessionId` through `options` is what gets a real answer.
 */
function readDefault(
  pluginId: string,
  options: PluginInvocationOptions | undefined,
  read: (runtime: PluginHostRuntime) => string
): string {
  try {
    return read(hostRuntime(pluginId, options))
  } catch (error) {
    if (error instanceof PluginHostRuntimeUnavailableError) return ""
    throw error
  }
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
        // A Character Pack may declare `requires.providers`; the provider
        // catalog has no change notification of its own, so push a refresh from
        // the single host-side mutator rather than adding a subscription to
        // @cognia/provider-types for one consumer.
        refreshAllPackWarnings()
      } catch {
        // Non-critical: plugin still works even if settings UI integration fails
      }

      return () => {
        customProviders.delete(providerId)
        unregisterProvider(providerId)
        refreshAllPackWarnings()
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
      // have no human review, so leaking content aborts before dispatch. It
      // runs HERE, above the host-runtime seam, so no runtime — renderer, CLI
      // or a future one — can be the thing that forgot to redact.
      assertNoLeakingPii(
        pluginId,
        "ctx.ai.chat",
        messages.map((m) => m.content)
      )
      // Check for custom provider first. A plugin's own registered provider is
      // host-independent: it runs in-process and bills nothing of the user's,
      // so it resolves before the host runtime.
      for (const provider of customProviders.values()) {
        if (options?.model && provider.models.some((m) => m.id === options.model)) {
          // Use this custom provider
          yield* provider.chat(messages, options)
          return
        }
      }

      yield* hostRuntime(pluginId, options).chat(messages, options)
    },

    embed: async (texts: string[], options?: AIEmbedOptions): Promise<number[][]> => {
      assertNoLeakingPii(pluginId, "ctx.ai.embed", texts)
      // Check custom providers for embedding support
      for (const provider of customProviders.values()) {
        if (provider.embed) {
          return provider.embed(texts, options)
        }
      }

      return hostRuntime(pluginId, options).embed(texts, options)
    },

    getDefaultModel: (options?: PluginInvocationOptions): string =>
      readDefault(pluginId, options, (runtime) => runtime.getDefaultModel()),

    getDefaultProvider: (options?: PluginInvocationOptions): string =>
      readDefault(pluginId, options, (runtime) => runtime.getDefaultProvider()),
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
  if (removed > 0) refreshAllPackWarnings()
  return removed
}
