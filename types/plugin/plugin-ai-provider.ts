/**
 * Type contracts for plugin-contributed AI providers — strictly **internal**
 * to the contributing plugin.
 *
 * Per ADR-0026 §F (and the explicit user decision recorded in the plan file):
 * the main chat loop never resolves a plugin provider. A plugin registers
 * an AI provider only so it can call `ctx.ai.complete(...)` or
 * `ctx.ai.embed(...)` for its own background tasks (summarization,
 * classification, embedding for plugin-owned vector stores, etc.).
 *
 * The host-side chat pipeline continues to flow through Claude Code SDK
 * via `lib/claude/build-options.ts:resolveSendOptions`. The
 * `chat.middleware` extension point (Phase 4) is the sanctioned way for a
 * plugin to influence main-chat behavior — not provider replacement.
 *
 * Two flavors, discriminated by `kind`:
 *   - `llm`      → text completion / chat. Returns a streamed or buffered text.
 *   - `embedding` → vector embedding for RAG / Twin use.
 *
 * Permission gates: `network:fetch` + `secrets:read`.
 */

import type { PluginContributionBackend } from "@/types/plugin/plugin"

/**
 * Discriminated union of provider definitions in `manifest.aiProviders[]`.
 * Both shapes share `id / label / entry / export` and differ only in the
 * runtime shape the factory returns.
 */
export type PluginAiProviderDef = PluginLlmProviderDef | PluginEmbeddingProviderDef

interface BasePluginAiProviderDef {
  id: string
  label: string
  /**
   * Which runtime owns this factory. Omit to inherit the plugin type
   * (`python` plugins default to `"python"`); declaring `entry` pins it to
   * `"js"`. See {@link PluginContributionBackend}.
   */
  backend?: PluginContributionBackend
  entry?: string
  export?: string
  description?: string
}

export interface PluginLlmProviderDef extends BasePluginAiProviderDef {
  kind: "llm"
  /**
   * Model identifiers this provider can serve. Optional metadata used by
   * the provider picker; not enforced at runtime.
   */
  models?: string[]
}

export interface PluginEmbeddingProviderDef extends BasePluginAiProviderDef {
  kind: "embedding"
  /** Dimensionality of the embedding vector. */
  dimensions: number
}

// ---------------------------------------------------------------------------
// Runtime shapes
// ---------------------------------------------------------------------------

export interface AiMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface AiCompletionRequest {
  messages: AiMessage[]
  /** Provider-resolvable model identifier. */
  model?: string
  maxTokens?: number
  temperature?: number
  /** AbortSignal to cancel mid-stream. */
  signal?: AbortSignal
}

export interface AiCompletionResponse {
  /** The full completion text. Always populated even when streamed. */
  text: string
  /** Optional token usage block, when the provider supplies it. */
  usage?: { prompt: number; completion: number; total: number }
}

export interface AiEmbeddingRequest {
  texts: string[]
  /** Provider-resolvable model identifier. */
  model?: string
  signal?: AbortSignal
}

export interface AiEmbeddingResponse {
  vectors: number[][]
  /** Dimensionality of each returned vector. */
  dimensions: number
  usage?: { prompt: number; total: number }
}

export interface PluginLlmProvider {
  id: string
  complete(req: AiCompletionRequest): Promise<AiCompletionResponse>
}

export interface PluginEmbeddingProvider {
  id: string
  dimensions: number
  embed(req: AiEmbeddingRequest): Promise<AiEmbeddingResponse>
}

export type PluginAiProvider = PluginLlmProvider | PluginEmbeddingProvider

export type PluginAiProviderFactory = (
  ctx: PluginAiProviderFactoryContext
) => PluginAiProvider | Promise<PluginAiProvider>

export interface PluginAiProviderFactoryContext {
  providerId: string
  pluginId: string
  kind: "llm" | "embedding"
  getConfig<T = unknown>(key: string): T | undefined
  getSecret(key: string): Promise<string | undefined>
}

export interface PluginAiProviderRegistration {
  providerId: string
  kind: "llm" | "embedding"
  unregister(): void
}
