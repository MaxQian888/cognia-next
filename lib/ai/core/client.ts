/**
 * Cognia-style AI client surface. cognia-next's authoritative provider
 * type lives in `@/types/provider/provider`; this module re-exports it
 * and provides `getProviderModel()` that the ported canvas-actions code
 * and vision captioner use to obtain a Vercel AI SDK `LanguageModel`.
 */

import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createCohere } from "@ai-sdk/cohere"
import type { LanguageModel } from "ai"
import type { ProviderName } from "@/types/provider/provider"

export type { ProviderName } from "@/types/provider/provider"

export interface ProviderModelOptions {
  provider: ProviderName
  model: string
  apiKey?: string
  baseURL?: string
}

/**
 * Providers that expose an OpenAI-compatible `/v1` surface, so they dispatch
 * through the OpenAI client with a custom `baseURL`. Mirrors the sidecar's
 * `resolveProtocol()` (sidecar/dispatch/ai-sdk.mjs) so the renderer and the
 * sidecar agree on which family a provider id belongs to.
 */
const OPENAI_COMPATIBLE_PROVIDERS = new Set<string>([
  "openai",
  "openrouter",
  "opencode",
  "opencode-go",
  "deepseek",
  "groq",
  "mistral-openai-compat",
  "ollama",
  "lmstudio",
  "llamacpp",
  "llamafile",
  "vllm",
  "localai",
  "jan",
  "textgenwebui",
  "koboldcpp",
  "tabbyapi",
])

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
export function getProviderModel(opts: ProviderModelOptions): LanguageModel {
  const { apiKey, baseURL } = opts
  const provider = opts.provider as string

  switch (provider) {
    case "anthropic": {
      const model = opts.model || "claude-sonnet-4-5"
      return createAnthropic({ apiKey, baseURL })(model) as LanguageModel
    }
    case "google":
    case "gemini":
      return createGoogleGenerativeAI({ apiKey, baseURL })(opts.model) as LanguageModel
    case "mistral":
      return createMistral({ apiKey, baseURL })(opts.model) as LanguageModel
    case "cohere":
      return createCohere({ apiKey, baseURL })(opts.model) as LanguageModel
    default:
      if (OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
        return createOpenAI({ apiKey, baseURL })(opts.model) as LanguageModel
      }
      throw new Error(
        `getProviderModel: unsupported provider "${provider}". Supported: anthropic, ` +
          `openai (+ OpenAI-compatible gateways), google/gemini, mistral, cohere.`
      )
  }
}
