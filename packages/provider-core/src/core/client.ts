/**
 * Cognia-style AI client surface. cognia-next's authoritative provider
 * provider type lives in `@cognia/provider-types`; this module re-exports it
 * and provides `getProviderModel()` that the ported canvas-actions code
 * and vision captioner use to obtain a Vercel AI SDK `LanguageModel`.
 */

import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createAzure } from "@ai-sdk/azure"
import { createGoogle } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createCohere } from "@ai-sdk/cohere"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import type { LanguageModel } from "ai"
import { getBuiltInProviderDefaultModel } from "@cognia/provider-types/built-in-provider-catalog"
import type { BedrockConnectionSettings, ProviderName } from "@cognia/provider-types"
import { getBuiltInProviderDefaultBaseURL } from "@cognia/provider-types/built-in-provider-catalog"
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
export function getProviderModel(opts: ProviderModelOptions): LanguageModel {
  const provider = opts.provider as string
  const apiKey = opts.apiKey
  // Catalog `defaultBaseURL`s are OpenAI-compat endpoints (e.g. Cohere's
  // `/compatibility/v1`) — they are only valid for the OpenAI-compatible
  // branch below. Native `@ai-sdk/*` clients must keep their own built-in
  // defaults unless the caller passed an explicit override.
  const baseURL = opts.baseURL

  switch (provider) {
    case "anthropic": {
      // The catalog's own default, never a literal. A hard-coded id here does
      // not merely go stale — it reaches the wire, so a caller that omitted
      // `model` silently ran a model the catalog had already retired, while
      // the composer chip and the effort ladder disagreed about whether that
      // model even supports `effort`.
      const model = opts.model || getBuiltInProviderDefaultModel("anthropic")
      return createAnthropic({ apiKey, baseURL })(model) as LanguageModel
    }
    case "google":
    case "gemini":
      return createGoogle({ apiKey, baseURL })(opts.model) as LanguageModel
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
    case "bedrock": {
      const bedrock = opts.bedrock
      if (bedrock?.authMode === "default-chain") {
        throw new Error("getProviderModel: Bedrock default-chain auth requires the sidecar proxy")
      }
      const client = createAmazonBedrock({
        ...(bedrock?.authMode === "api-key" || (!bedrock && apiKey)
          ? { apiKey: bedrock?.apiKey ?? apiKey }
          : {}),
        ...(bedrock?.authMode === "iam"
          ? {
              accessKeyId: bedrock.accessKeyId,
              secretAccessKey: bedrock.secretAccessKey,
              ...(bedrock.sessionToken ? { sessionToken: bedrock.sessionToken } : {}),
            }
          : {}),
        ...(bedrock?.region ? { region: bedrock.region } : {}),
        ...(baseURL ? { baseURL } : bedrock?.baseURL ? { baseURL: bedrock.baseURL } : {}),
      })
      return client(opts.model) as LanguageModel
    }
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
        const compatBaseURL = baseURL ?? getBuiltInProviderDefaultBaseURL(provider)
        const client = createOpenAI({ apiKey, baseURL: compatBaseURL, headers: opts.headers })
        const flavor = decideOpenAiEndpointFlavor({
          apiFlavor: opts.apiFlavor,
          baseURL: compatBaseURL,
          providerId: provider,
        })
        return (
          flavor === "responses" ? client.responses(opts.model) : client.chat(opts.model)
        ) as LanguageModel
      }
      throw new Error(
        `getProviderModel: unsupported provider "${provider}". Supported: anthropic, ` +
          `openai (+ OpenAI-compatible gateways), google/gemini, mistral, cohere, bedrock.`
      )
  }
}
