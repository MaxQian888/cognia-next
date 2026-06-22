/**
 * Local-provider embedding support (ADR-0043 Phase 5).
 *
 * Ollama embeds via its native `/api/embeddings` path (handled in
 * `embedding.ts`). The other local engines expose an OpenAI-compatible
 * `/v1/embeddings` endpoint, so they embed through the AI SDK's openai client
 * with a custom baseURL — this module decides which providers qualify and
 * resolves their endpoint. Pure + framework-agnostic.
 */

import {
  LOCAL_PROVIDER_URLS,
  getOpenAICompatibleURL,
  type LocalProviderName,
} from "@cognia/provider-types/local-provider"

/**
 * Local engines with an OpenAI-compatible `/v1/embeddings` endpoint AND
 * embedding capability (per `getProviderCapabilities`). Ollama is intentionally
 * excluded — it uses its native embeddings API.
 */
export const OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS = [
  "lmstudio",
  "llamacpp",
  "vllm",
  "localai",
  "jan",
] as const

export type OpenAICompatibleEmbeddingProvider =
  (typeof OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS)[number]

export function isOpenAICompatibleEmbeddingProvider(
  provider: string
): provider is OpenAICompatibleEmbeddingProvider {
  return (OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS as readonly string[]).includes(provider)
}

/**
 * Resolve the OpenAI-compatible `/v1` base URL for a local embedding provider.
 * Honours an explicit user base URL (normalised to `/v1`); otherwise falls back
 * to the catalog default for that engine.
 */
export function resolveLocalEmbeddingBaseURL(provider: string, baseURL?: string): string {
  const trimmed = baseURL?.trim()
  if (trimmed) return getOpenAICompatibleURL(trimmed)
  const fallback = LOCAL_PROVIDER_URLS[provider as LocalProviderName] ?? "http://localhost:8000"
  return getOpenAICompatibleURL(fallback)
}

/** Soft default model when the user hasn't pinned a local embedding model. */
export const DEFAULT_LOCAL_EMBEDDING_MODEL = "nomic-embed-text"
