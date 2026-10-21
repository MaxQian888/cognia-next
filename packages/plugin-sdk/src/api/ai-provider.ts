/**
 * Plugin SDK - `ai-provider` capability surface.
 *
 * Exports the declarative authoring helper and the types behind
 * `ctx.ai.registerProvider(...)`. The host builds `ctx.ai` and registers
 * manifest-declared providers itself; neither is on the author surface.
 */

export { defineAiProvider } from "../define/define-ai-provider"

export type {
  AiProvidersBridgeError,
  AiProvidersBridgeOptions,
  AiProvidersBridgeResult,
} from "@cognia/plugin-contract/lib/plugin/bridge/ai-providers-bridge"

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
} from "@cognia/plugin-contract/types/plugin/plugin-ai-provider"

export type {
  AIChatChunk,
  AIChatMessage,
  AIChatOptions,
  AIModel,
  AIProviderDefinition,
  PluginAIProviderAPI,
} from "@cognia/plugin-contract/types/plugin/plugin"
