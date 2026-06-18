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
import type { ProviderName } from "@cognia/provider-types"

export type { ProviderName } from "@cognia/provider-types"

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
 * Decide whether an openai-protocol base URL is genuine OpenAI (api.openai.com),
 * which serves the modern Responses API, versus an OpenAI-*compatible* gateway
 * (DeepSeek / Groq / OpenRouter / Ollama / LM Studio / vLLM / …) that only
 * implements Chat Completions. A missing base URL means the default OpenAI
 * endpoint. Anything that doesn't parse, or whose host isn't *.openai.com, is
 * treated as a compatible gateway so we fail safe onto `/chat/completions`.
 *
 * Mirrors `isGenuineOpenAiEndpoint` in the sidecar's `ai-sdk-adapter.mjs` — the
 * renderer and sidecar must agree, or a gateway works in chat but 404s here.
 */
export function isGenuineOpenAiEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL || typeof baseURL !== "string") return true
  try {
    const host = new URL(baseURL).host.toLowerCase()
    return host === "api.openai.com" || host.endsWith(".openai.com")
  } catch {
    return false
  }
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
        // @ai-sdk/openai v3's bare `client(model)` returns a Responses-API
        // model (`/responses`) — an OpenAI-proprietary endpoint. Genuine OpenAI
        // serves it, but the OpenAI-*compatible* gateways this branch also
        // handles (DeepSeek, Groq, OpenRouter, Ollama, LM Studio, vLLM, …) only
        // implement `/chat/completions`, so the bare call 404s ("Not Found")
        // for every one of them. Pick the endpoint family explicitly, matching
        // the sidecar's ai-sdk dispatch path.
        const client = createOpenAI({ apiKey, baseURL })
        return (
          isGenuineOpenAiEndpoint(baseURL) ? client.responses(opts.model) : client.chat(opts.model)
        ) as LanguageModel
      }
      throw new Error(
        `getProviderModel: unsupported provider "${provider}". Supported: anthropic, ` +
          `openai (+ OpenAI-compatible gateways), google/gemini, mistral, cohere.`
      )
  }
}
