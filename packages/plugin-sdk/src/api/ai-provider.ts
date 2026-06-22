/**
 * Plugin SDK - `ai-provider` capability surface.
 *
 * Re-exports the declarative authoring helper, manifest bridge, and runtime
 * plugin AI provider API that backs `ctx.ai.registerProvider(...)`.
 */

export { defineAiProvider } from "../define/define-ai-provider"

export {
  clearCustomAIProviders,
  createAIProviderAPI,
  getCustomAIProviders,
} from "@/lib/plugin/api/ai-provider-api"

export {
  registerAiProvidersForPlugin,
  unregisterAiProvidersForPlugin,
} from "@/lib/plugin/bridge/ai-providers-bridge"

export type {
  AiProvidersBridgeError,
  AiProvidersBridgeOptions,
  AiProvidersBridgeResult,
} from "@/lib/plugin/bridge/ai-providers-bridge"

export type {
  AiCompletionRequest,
  AiCompletionResponse,
  AiEmbeddingRequest,
  AiEmbeddingResponse,
  AiMessage,
  PluginAiProvider,
  PluginAiProviderDef,
  PluginAiProviderFactory,
  PluginAiProviderFactoryContext,
  PluginAiProviderRegistration,
  PluginEmbeddingProvider,
  PluginEmbeddingProviderDef,
  PluginLlmProvider,
  PluginLlmProviderDef,
} from "@/types/plugin/plugin-ai-provider"

export type {
  AIChatChunk,
  AIChatMessage,
  AIChatOptions,
  AIModel,
  AIProviderDefinition,
  PluginAIProviderAPI,
} from "@/types/plugin/plugin-extended"
