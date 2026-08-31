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
  ModelConfig,
  ModelInferenceParams,
  ProviderConnectionParams,
  ProviderInferenceDefaults,
  UserProviderSettings,
} from "@cognia/provider-types/provider"
import type { ProviderParameterSchema } from "@cognia/provider-types/provider-parameter-schema"

import { resolveProviderSpecificParams } from "./parameter-resolver"

export interface InferenceParamSource {
  inferenceDefaults?: ProviderInferenceDefaults
  connectionParams?: ProviderConnectionParams
  advancedParams?: Record<string, unknown>
  /** Namespaced provider knobs from the Parameters tab (`openai.reasoningEffort`, …). */
  providerSpecificParams?: Record<string, unknown>
}

export interface BuildModelInferenceParamsOptions {
  providerId?: string
  /**
   * Parameter schema for the provider. When given (with `providerId`), the
   * `providerSpecificParams` map is projected into an AI SDK `providerOptions`
   * block via the schema's native keys / capability conditions.
   */
  schema?: ProviderParameterSchema
  /** Model the request targets — gates capability-conditioned parameters. */
  modelConfig?: ModelConfig
}

/**
 * The Parameters tab writes values under the schema key — namespaced
 * (`connection.maxRetries`, `openai.seed`, `togetherAi.topK`) — while older
 * rows and the plugin API used the bare leaf (`maxRetries`, `seed`, `topK`).
 * Read whichever is present so neither generation of writes is dropped.
 */
function readParam(map: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!map) return undefined
  for (const key of keys) {
    if (map[key] !== undefined) return map[key]
  }
  return undefined
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
  source: InferenceParamSource | undefined,
  options: BuildModelInferenceParamsOptions = {}
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

  const maxRetries = finiteNumber(
    readParam(
      connectionParams as Record<string, unknown> | undefined,
      "maxRetries",
      "connection.maxRetries"
    )
  )
  if (maxRetries !== undefined) params.maxRetries = maxRetries

  // `topK`, `seed`, and `stopSequences` are valid AI SDK sampling settings but
  // have no dedicated field on our provider config, so they ride in the
  // free-form `advancedParams` map (bare or schema-namespaced key).
  const topK = finiteNumber(readParam(advancedParams, "topK"))
  if (topK !== undefined) params.topK = topK

  const seed = finiteNumber(readParam(advancedParams, "seed", "openai.seed"))
  if (seed !== undefined) params.seed = seed

  const stopSequences = stringArray(readParam(advancedParams, "stopSequences"))
  if (stopSequences !== undefined) params.stopSequences = stopSequences

  // Provider-specific knobs (reasoning effort, thinking budget, safety
  // settings, Ollama numCtx, …) → AI SDK `providerOptions`. Until now the
  // Parameters tab persisted these and nothing read them back.
  if (
    options.schema &&
    options.providerId &&
    (source.providerSpecificParams || source.advancedParams)
  ) {
    const providerOptions = resolveProviderSpecificParams(
      options.providerId,
      source as UserProviderSettings,
      options.modelConfig,
      options.schema
    )
    if (Object.keys(providerOptions).length > 0) {
      params.providerOptions = providerOptions as Record<string, Record<string, unknown>>
    }
  }

  return Object.keys(params).length > 0 ? params : undefined
}
