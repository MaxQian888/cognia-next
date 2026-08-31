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
  const providerSpecificParams = providerSettings?.providerSpecificParams ?? {}
  const advancedParams = providerSettings?.advancedParams ?? {}
  const currentValues = { ...providerSpecificParams, ...advancedParams }
  const result: Record<string, unknown> = {}
  const googleSafetySettings: Array<{ category: string; threshold: unknown }> = []

  for (const def of schema.parameters) {
    if (def.category !== "provider-specific" && def.category !== "advanced") continue
    if (!shouldShowParameter(def, modelConfig, currentValues)) continue

    const source = def.category === "advanced" ? advancedParams : providerSpecificParams
    if (!Object.prototype.hasOwnProperty.call(source, def.key)) continue

    const value = source[def.key]
    if (value === undefined) continue

    // Seed is an AI SDK core call option, not an OpenAI provider option. It is
    // projected by buildModelInferenceParams instead.
    if (def.key === "openai.seed") continue

    if (def.key === "anthropic.thinking.enabled") {
      setNestedValue(result, "anthropic.thinking.type", value ? "enabled" : "disabled")
      continue
    }

    if (def.key.startsWith("google.safetySettings.")) {
      const category = GOOGLE_SAFETY_CATEGORY[def.key]
      if (category) googleSafetySettings.push({ category, threshold: value })
      continue
    }

    setNestedValue(result, def.key, value, def.nativeKey)
  }

  if (googleSafetySettings.length > 0) {
    setNestedValue(result, "google.safetySettings", googleSafetySettings)
  }

  return result
}

const GOOGLE_SAFETY_CATEGORY: Record<string, string> = {
  "google.safetySettings.harassment": "HARM_CATEGORY_HARASSMENT",
  "google.safetySettings.hateSpeech": "HARM_CATEGORY_HATE_SPEECH",
  "google.safetySettings.sexuallyExplicit": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "google.safetySettings.dangerousContent": "HARM_CATEGORY_DANGEROUS_CONTENT",
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
