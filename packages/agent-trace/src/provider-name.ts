/**
 * Maps a Cognia provider id onto OTel GenAI's `gen_ai.provider.name`.
 *
 * The semantic convention defines a well-known value set and states that a
 * well-known value MUST be used when one applies, and that a custom value MAY
 * be used otherwise. Before this module every non-Anthropic provider was
 * reported as `"openai"` with the true id buried in `metadata.providerId`, so
 * any backend (or local panel) grouping by provider mis-attributed DeepSeek,
 * Zhipu, Ollama, OpenRouter, … cost and latency to OpenAI.
 *
 * Emitting the raw provider id as a custom value is both spec-legal and
 * strictly more truthful than the previous bucketing.
 */

import type { SpanProviderName } from "./types"

/**
 * Provider ids whose OTel well-known name differs from the id itself. Ids that
 * already equal their well-known value (`anthropic`, `openai`, `deepseek`,
 * `groq`, `cohere`) need no entry — they fall through unchanged.
 */
const WELL_KNOWN_BY_PROVIDER_ID: Record<string, SpanProviderName> = {
  // The built-in `google` provider targets the Gemini API.
  google: "gcp.gemini",
  gemini: "gcp.gemini",
  vertex: "gcp.vertex_ai",
  vertexai: "gcp.vertex_ai",
  bedrock: "aws.bedrock",
  azure: "azure.ai.openai",
  mistral: "mistral_ai",
  xai: "x_ai",
  perplexity: "perplexity",
  watsonx: "ibm.watsonx.ai",
}

/** The OTel GenAI well-known values that a provider id may already equal. */
const IDENTITY_WELL_KNOWN = new Set<string>([
  "anthropic",
  "aws.bedrock",
  "azure.ai.inference",
  "azure.ai.openai",
  "cohere",
  "deepseek",
  "gcp.gemini",
  "gcp.gen_ai",
  "gcp.vertex_ai",
  "groq",
  "ibm.watsonx.ai",
  "mistral_ai",
  "openai",
  "perplexity",
  "x_ai",
])

/**
 * Resolve a provider id to a `gen_ai.provider.name` value.
 *
 * Returns the OTel well-known value when one applies, otherwise the normalized
 * provider id as a custom value. Falls back to `"openai"` only for an
 * empty/missing id, where no truthful answer exists and the span would
 * otherwise be dropped by `emitFinishedSpan`'s identity check.
 */
export function providerNameFromId(providerId: string | undefined): SpanProviderName {
  const id = providerId?.trim().toLowerCase()
  if (!id) return "openai"
  const mapped = WELL_KNOWN_BY_PROVIDER_ID[id]
  if (mapped) return mapped
  if (IDENTITY_WELL_KNOWN.has(id)) return id as SpanProviderName
  return id
}

/** True when `name` is one of OTel GenAI's well-known provider values. */
export function isWellKnownProviderName(name: string): boolean {
  return IDENTITY_WELL_KNOWN.has(name)
}
