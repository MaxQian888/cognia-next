import type {
  ParameterDefinition,
  ProviderParameterSchema,
  ResolvedInferenceParams,
  GlobalInferenceDefaults,
} from "@cognia/provider-types/provider-parameter-schema"
import type { UserProviderSettings, ModelConfig } from "@cognia/provider-types"

/**
 * Resolves inference parameters using priority chain:
 * session → provider defaults → global defaults → hardcoded defaults
 */
export function resolveInferenceParams(
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
): ResolvedInferenceParams {
  return {
    temperature:
      session?.temperature ??
      providerSettings?.inferenceDefaults?.temperature ??
      globalDefaults.defaultTemperature ??
      0.7,
    maxTokens:
      session?.maxTokens ??
      providerSettings?.inferenceDefaults?.maxTokens ??
      globalDefaults.defaultMaxTokens ??
      4096,
    topP:
      session?.topP ??
      providerSettings?.inferenceDefaults?.topP ??
      globalDefaults.defaultTopP ??
      1.0,
    frequencyPenalty:
      session?.frequencyPenalty ??
      providerSettings?.inferenceDefaults?.frequencyPenalty ??
      globalDefaults.defaultFrequencyPenalty ??
      0,
    presencePenalty:
      session?.presencePenalty ??
      providerSettings?.inferenceDefaults?.presencePenalty ??
      globalDefaults.defaultPresencePenalty ??
      0,
  }
}

/**
 * Resolves provider-specific params for AI SDK providerOptions.
 * Filters by model capabilities and inter-param dependencies.
 */
export function resolveProviderSpecificParams(
  _providerId: string,
  providerSettings: UserProviderSettings | undefined,
  modelConfig: ModelConfig | undefined,
  schema: ProviderParameterSchema
): Record<string, unknown> {
  const params = providerSettings?.providerSpecificParams ?? {}
  const result: Record<string, unknown> = {}

  for (const def of schema.parameters) {
    if (def.category !== "provider-specific") continue
    if (!shouldShowParameter(def, modelConfig, params)) continue

    const value = params[def.key] ?? def.defaultValue
    if (value !== undefined) {
      setNestedValue(result, def.key, value, def.nativeKey)
    }
  }

  return result
}

/**
 * Evaluates whether a parameter should be shown/applied.
 */
export function shouldShowParameter(
  definition: ParameterDefinition,
  modelConfig: ModelConfig | undefined,
  currentValues?: Record<string, unknown>
): boolean {
  if (!definition.condition) return true

  const { modelCapability, modelIdPattern, dependsOn } = definition.condition

  if (modelCapability && modelConfig) {
    if (!modelConfig[modelCapability]) return false
  }

  if (modelIdPattern && modelConfig) {
    if (!new RegExp(modelIdPattern).test(modelConfig.id)) return false
  }

  if (dependsOn && currentValues) {
    if (currentValues[dependsOn.key] !== dependsOn.value) return false
  }

  return true
}

/**
 * Converts a namespaced key to nested object for providerOptions.
 * 'openai.reasoningEffort' + nativeKey='reasoning_effort'
 *   → { openai: { reasoning_effort: value } }
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  key: string,
  value: unknown,
  nativeKey?: string
): void {
  const parts = key.split(".")
  if (parts.length === 1) {
    obj[nativeKey ?? key] = value
    return
  }

  const provider = parts[0]
  const leafKey = nativeKey ?? parts[parts.length - 1]

  if (!obj[provider]) obj[provider] = {}
  const nested = obj[provider] as Record<string, unknown>

  if (parts.length === 2) {
    nested[leafKey] = value
  } else {
    let current = nested
    for (let i = 1; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {}
      current = current[parts[i]] as Record<string, unknown>
    }
    current[leafKey] = value
  }
}
