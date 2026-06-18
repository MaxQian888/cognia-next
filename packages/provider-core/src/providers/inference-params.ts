/**
 * Translate a provider's persisted inference configuration into the AI SDK v6
 * call-option shape (`ModelInferenceParams`) that the sidecar's ai-sdk
 * dispatcher spreads into `streamText`. Without this, every non-Anthropic turn
 * dropped the user's configured temperature / token cap / penalties because the
 * dispatcher hard-coded them to `undefined`.
 *
 * Pure + framework-agnostic so it can be unit-tested and reused by both the
 * chat send path (`build-options`) and the plugin AI surface.
 */

import type {
  ModelInferenceParams,
  ProviderConnectionParams,
  ProviderInferenceDefaults,
} from "@/types/provider/provider"

export interface InferenceParamSource {
  inferenceDefaults?: ProviderInferenceDefaults
  connectionParams?: ProviderConnectionParams
  advancedParams?: Record<string, unknown>
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((v): v is string => typeof v === "string")
  return items.length > 0 ? items : undefined
}

/**
 * Build the AI SDK call-option params, omitting anything unset or malformed.
 * Returns `undefined` when nothing usable is configured so callers can avoid
 * attaching an empty object to the request.
 */
export function buildModelInferenceParams(
  source: InferenceParamSource | undefined
): ModelInferenceParams | undefined {
  if (!source) return undefined

  const { inferenceDefaults, connectionParams, advancedParams } = source
  const params: ModelInferenceParams = {}

  const temperature = finiteNumber(inferenceDefaults?.temperature)
  if (temperature !== undefined) params.temperature = temperature

  // v5+ renamed `maxTokens` → `maxOutputTokens`.
  const maxOutputTokens = finiteNumber(inferenceDefaults?.maxTokens)
  if (maxOutputTokens !== undefined) params.maxOutputTokens = maxOutputTokens

  const topP = finiteNumber(inferenceDefaults?.topP)
  if (topP !== undefined) params.topP = topP

  const frequencyPenalty = finiteNumber(inferenceDefaults?.frequencyPenalty)
  if (frequencyPenalty !== undefined) params.frequencyPenalty = frequencyPenalty

  const presencePenalty = finiteNumber(inferenceDefaults?.presencePenalty)
  if (presencePenalty !== undefined) params.presencePenalty = presencePenalty

  const maxRetries = finiteNumber(connectionParams?.maxRetries)
  if (maxRetries !== undefined) params.maxRetries = maxRetries

  // `topK`, `seed`, and `stopSequences` are valid AI SDK sampling settings but
  // have no dedicated field on our provider config, so they ride in the
  // free-form `advancedParams` map.
  const topK = finiteNumber(advancedParams?.topK)
  if (topK !== undefined) params.topK = topK

  const seed = finiteNumber(advancedParams?.seed)
  if (seed !== undefined) params.seed = seed

  const stopSequences = stringArray(advancedParams?.stopSequences)
  if (stopSequences !== undefined) params.stopSequences = stopSequences

  return Object.keys(params).length > 0 ? params : undefined
}
