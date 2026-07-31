/**
 * Schema type definitions for provider-specific parameter configuration.
 * Used to dynamically render parameter forms and validate parameters.
 */

export type ParameterFieldType = "slider" | "select" | "number" | "toggle" | "text" | "json"

export type ParameterCategory = "inference" | "provider-specific" | "connection" | "advanced"

/** Boolean capability flags on ModelConfig that can be used as conditions */
export type ModelCapabilityFlag =
  | "supportsTools"
  | "supportsVision"
  | "supportsAudio"
  | "supportsVideo"
  | "supportsStreaming"
  | "supportsReasoning"
  | "supportsImageGeneration"
  | "supportsEmbedding"

export interface ParameterValidation {
  min?: number
  max?: number
  step?: number
  options?: Array<{ value: string; label: string; description?: string }>
  pattern?: string
}

export interface ParameterCondition {
  /** Show only when the model has this boolean capability flag */
  modelCapability?: ModelCapabilityFlag
  /** Show only when the model ID matches this regex */
  modelIdPattern?: string
  /** Show only when another parameter has a specific value */
  dependsOn?: { key: string; value: unknown }
}

export interface ParameterDefinition {
  /** Unique key used in storage. e.g., 'temperature', 'openai.reasoningEffort' */
  key: string
  /** Native API parameter name for SDK providerOptions. e.g., 'reasoning_effort' */
  nativeKey?: string
  /** Field type determines the UI control */
  type: ParameterFieldType
  /** i18n key for label */
  label: string
  /** i18n key for description/tooltip */
  description: string
  /** Which section this parameter appears in */
  category: ParameterCategory
  /** Default value */
  defaultValue: unknown
  /** Validation rules */
  validation?: ParameterValidation
  /** Conditions for showing this parameter */
  condition?: ParameterCondition
  /** Whether to show in the chat AI settings dialog */
  showInChatSettings?: boolean
  /** Group label within a category (i18n key) */
  group?: string
}

export interface ProviderParameterSchema {
  providerId: string
  providerName: string
  parameters: ParameterDefinition[]
}

/** Resolved inference parameters (all fields required after resolution) */
export interface ResolvedInferenceParams {
  temperature: number
  maxTokens: number
  topP: number
  frequencyPenalty: number
  presencePenalty: number
}

/** Global inference defaults from settings store */
export interface GlobalInferenceDefaults {
  defaultTemperature: number
  defaultMaxTokens: number
  defaultTopP: number
  defaultFrequencyPenalty: number
  defaultPresencePenalty: number
}
