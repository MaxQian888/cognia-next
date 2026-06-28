/**
 * Cognia-style AI client surface. cognia-next's authoritative provider
 * provider type lives in `@cognia/provider-types`; this module re-exports it
 * and provides `getProviderModel()` that the ported canvas-actions code
 * and vision captioner use to obtain a Vercel AI SDK `LanguageModel`.
 */

import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createCohere } from "@ai-sdk/cohere"
import type { LanguageModel } from "ai"
import type { ProviderName } from "@cognia/provider-types"
// Single source of truth for the OpenAI Responses-vs-Chat decision and the
// provider→protocol map (shared with the sidecar; the file lives under
// `sidecar/` because the sidecar ships standalone and can't import TS).
import {
  isGenuineOpenAiEndpoint,
  resolveProviderProtocol,
  decideOpenAiEndpointFlavor,
} from "../../../../sidecar/dispatch/protocol-adapters/provider-protocol.mjs"

export type { ProviderName } from "@cognia/provider-types"
// Re-exported for back-compat with importers that pulled it from here.
export { isGenuineOpenAiEndpoint }

export interface ProviderModelOptions {
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
    case "azure": {
      // Azure serves the OpenAI surface; honor apiFlavor (auto → chat for Azure,
      // "responses" opts into the Responses API) via the shared decision.
      const client = createAzure({ apiKey, baseURL, headers: opts.headers })
      const flavor = decideOpenAiEndpointFlavor({
        apiFlavor: opts.apiFlavor,
        baseURL,
        providerId: "azure",
      })
      return (
        flavor === "responses" ? client.responses(opts.model) : client.chat(opts.model)
      ) as LanguageModel
    }
    case "bedrock":
      // Bedrock's AWS SigV4 deps must not enter the renderer/mobile bundle; the
      // sidecar chat path supports it natively. Keep it out of this in-renderer
      // model factory.
      throw new Error("getProviderModel: bedrock is only supported via the chat/sidecar path")
    default:
      if (resolveProviderProtocol(provider) === "openai") {
        // @ai-sdk/openai v3's bare `client(model)` returns a Responses-API
        // model (`/responses`) — an OpenAI-proprietary endpoint. Genuine OpenAI
        // serves it, but the OpenAI-*compatible* gateways this branch also
        // handles (DeepSeek, Groq, OpenRouter, Ollama, LM Studio, vLLM, …) only
        // implement `/chat/completions`, so the bare call 404s ("Not Found")
        // for every one of them. The shared decision picks the family — honoring
        // an explicit `apiFlavor` and otherwise the host/id heuristic — exactly
        // as the sidecar's ai-sdk dispatch path does.
        const client = createOpenAI({ apiKey, baseURL, headers: opts.headers })
        const flavor = decideOpenAiEndpointFlavor({
          apiFlavor: opts.apiFlavor,
          baseURL,
          providerId: provider,
        })
        return (
          flavor === "responses" ? client.responses(opts.model) : client.chat(opts.model)
        ) as LanguageModel
      }
      throw new Error(
        `getProviderModel: unsupported provider "${provider}". Supported: anthropic, ` +
          `openai (+ OpenAI-compatible gateways), google/gemini, mistral, cohere.`
      )
  }
}
