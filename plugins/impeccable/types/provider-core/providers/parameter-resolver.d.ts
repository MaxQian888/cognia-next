import {
  GlobalInferenceDefaults,
  ResolvedInferenceParams,
  ProviderParameterSchema,
  ParameterDefinition,
} from "@cognia/provider-types/provider-parameter-schema"
import { UserProviderSettings, ModelConfig } from "@cognia/provider-types"

/**
 * Resolves inference parameters using priority chain:
 * session → provider defaults → global defaults → hardcoded defaults
 */
declare function resolveInferenceParams(
  session:
    | {
        temperature?: number
        maxTokens?: number
        topP?: number
        frequencyPenalty?: number
        presencePenalty?: number
      }
    | undefined,
  providerSettings: UserProviderSettings | undefined,
  globalDefaults: GlobalInferenceDefaults
): ResolvedInferenceParams
/**
 * Resolves provider-specific params for AI SDK providerOptions.
 * Filters by model capabilities and inter-param dependencies.
 */
declare function resolveProviderSpecificParams(
  _providerId: string,
  providerSettings: UserProviderSettings | undefined,
  modelConfig: ModelConfig | undefined,
  schema: ProviderParameterSchema
): Record<string, unknown>
/**
 * Evaluates whether a parameter should be shown/applied.
 */
declare function shouldShowParameter(
  definition: ParameterDefinition,
  modelConfig: ModelConfig | undefined,
  currentValues?: Record<string, unknown>
): boolean
/**
 * Converts a namespaced key to nested object for providerOptions.
 * 'openai.reasoningEffort' + nativeKey='reasoning_effort'
 *   → { openai: { reasoning_effort: value } }
 */
declare function setNestedValue(
  obj: Record<string, unknown>,
  key: string,
  value: unknown,
  nativeKey?: string
): void

export {
  resolveInferenceParams,
  resolveProviderSpecificParams,
  setNestedValue,
  shouldShowParameter,
}
