import { LanguageModel } from "ai"
import { ProviderName, BedrockConnectionSettings } from "@cognia/provider-types"
export { ProviderName } from "@cognia/provider-types"

declare function isGenuineOpenAiEndpoint(baseURL?: string): boolean

/**
 * Cognia-style AI client surface. cognia-next's authoritative provider
 * provider type lives in `@cognia/provider-types`; this module re-exports it
 * and provides `getProviderModel()` that the ported canvas-actions code
 * and vision captioner use to obtain a Vercel AI SDK `LanguageModel`.
 */

interface ProviderModelOptions {
  provider: ProviderName
  model: string
  apiKey?: string
  baseURL?: string
  /**
   * Extra default headers forwarded into the provider client. Used by the
   * Codex ChatGPT-login path, which must send `ChatGPT-Account-Id`,
   * `OpenAI-Beta`, `Originator`, etc. alongside the bearer token.
   */
  headers?: Record<string, string>
  /**
   * Explicit OpenAI endpoint family. "responses" / "chat" override the host
   * heuristic (this is what unlocks the Responses API on Azure / compatible
   * gateways / custom base URLs); "auto" or omitted falls back to the heuristic.
   */
  apiFlavor?: "auto" | "responses" | "chat"
  bedrock?: BedrockConnectionSettings
}
/**
 * Resolve a Vercel AI SDK `LanguageModel` for a given provider + model.
 *
 * Honours `opts.provider` across the first-party `@ai-sdk/*` families plus the
 * OpenAI-compatible gateways (routed through `createOpenAI` with `baseURL`).
 * The API key is passed directly into the provider factory — we never mutate
 * `process.env` (that leaked the key process-wide and only worked for
 * Anthropic). `baseURL` is forwarded so proxies / self-hosted gateways work.
 *
 * Unknown providers throw, matching `lib/ai/embedding/embedding.ts`'s
 * `getEmbeddingModel`, rather than silently falling back to Anthropic.
 */
declare function getProviderModel(opts: ProviderModelOptions): LanguageModel

export { type ProviderModelOptions, getProviderModel, isGenuineOpenAiEndpoint }
