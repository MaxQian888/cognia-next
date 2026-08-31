/**
 * Provider-specific parameter schema registry.
 *
 * Defines parameter definitions for each AI provider so the UI can
 * render appropriate controls and validate values dynamically.
 */

import type {
  ParameterDefinition,
  ProviderParameterSchema,
} from "@cognia/provider-types/provider-parameter-schema"
import type { CustomProviderSettings } from "@cognia/provider-types/provider"

// ---------------------------------------------------------------------------
// Common inference parameters (shared by all providers)
// ---------------------------------------------------------------------------

export const COMMON_INFERENCE_PARAMETERS: ParameterDefinition[] = [
  {
    key: "temperature",
    type: "slider",
    label: "providerParams.temperature.label",
    description: "providerParams.temperature.description",
    category: "inference",
    defaultValue: 0.7,
    showInChatSettings: true,
    validation: { min: 0, max: 2, step: 0.1 },
  },
  {
    key: "maxTokens",
    type: "number",
    label: "providerParams.maxTokens.label",
    description: "providerParams.maxTokens.description",
    category: "inference",
    defaultValue: 4096,
    showInChatSettings: true,
    validation: { min: 1, max: 128000 },
  },
  {
    key: "topP",
    type: "slider",
    label: "providerParams.topP.label",
    description: "providerParams.topP.description",
    category: "inference",
    defaultValue: 1.0,
    showInChatSettings: true,
    validation: { min: 0, max: 1, step: 0.05 },
  },
  {
    key: "frequencyPenalty",
    type: "slider",
    label: "providerParams.frequencyPenalty.label",
    description: "providerParams.frequencyPenalty.description",
    category: "inference",
    defaultValue: 0,
    showInChatSettings: true,
    validation: { min: -2, max: 2, step: 0.1 },
  },
  {
    key: "presencePenalty",
    type: "slider",
    label: "providerParams.presencePenalty.label",
    description: "providerParams.presencePenalty.description",
    category: "inference",
    defaultValue: 0,
    showInChatSettings: true,
    validation: { min: -2, max: 2, step: 0.1 },
  },
]

// ---------------------------------------------------------------------------
// Common connection parameters (shared by all providers)
// ---------------------------------------------------------------------------

export const COMMON_CONNECTION_PARAMETERS: ParameterDefinition[] = [
  {
    key: "connection.maxRetries",
    type: "number",
    label: "providerParams.connection.maxRetries.label",
    description: "providerParams.connection.maxRetries.description",
    category: "connection",
    defaultValue: 2,
    validation: { min: 0, max: 10 },
  },
  {
    key: "connection.concurrentLimit",
    type: "number",
    label: "providerParams.connection.concurrentLimit.label",
    description: "providerParams.connection.concurrentLimit.description",
    category: "connection",
    defaultValue: undefined,
    validation: { min: 1, max: 256 },
  },
]

// ---------------------------------------------------------------------------
// Provider-specific parameter sets
// ---------------------------------------------------------------------------

const OPENAI_SPECIFIC_PARAMETERS: ParameterDefinition[] = [
  {
    key: "openai.reasoningEffort",
    nativeKey: "reasoningEffort",
    type: "select",
    label: "providerParams.openai.reasoningEffort.label",
    description: "providerParams.openai.reasoningEffort.description",
    category: "provider-specific",
    defaultValue: "medium",
    showInChatSettings: true,
    condition: { modelCapability: "supportsReasoning" },
    validation: {
      options: [
        { value: "low", label: "providerParams.openai.reasoningEffort.low" },
        { value: "medium", label: "providerParams.openai.reasoningEffort.medium" },
        { value: "high", label: "providerParams.openai.reasoningEffort.high" },
      ],
    },
  },
  {
    key: "openai.seed",
    type: "number",
    label: "providerParams.openai.seed.label",
    description: "providerParams.openai.seed.description",
    category: "advanced",
    defaultValue: undefined,
    validation: { min: 0, max: 2147483647 },
  },
  {
    key: "openai.logprobs",
    type: "toggle",
    label: "providerParams.openai.logprobs.label",
    description: "providerParams.openai.logprobs.description",
    category: "advanced",
    defaultValue: false,
  },
  {
    key: "openai.store",
    type: "toggle",
    label: "providerParams.openai.store.label",
    description: "providerParams.openai.store.description",
    category: "advanced",
    defaultValue: false,
  },
]

const ANTHROPIC_SPECIFIC_PARAMETERS: ParameterDefinition[] = [
  {
    key: "anthropic.thinking.enabled",
    type: "toggle",
    label: "providerParams.anthropic.thinking.enabled.label",
    description: "providerParams.anthropic.thinking.enabled.description",
    category: "provider-specific",
    defaultValue: false,
    showInChatSettings: true,
    condition: { modelCapability: "supportsReasoning" },
  },
  {
    key: "anthropic.thinking.budgetTokens",
    nativeKey: "budgetTokens",
    type: "number",
    label: "providerParams.anthropic.thinking.budgetTokens.label",
    description: "providerParams.anthropic.thinking.budgetTokens.description",
    category: "provider-specific",
    defaultValue: 32000,
    showInChatSettings: true,
    condition: { dependsOn: { key: "anthropic.thinking.enabled", value: true } },
    validation: { min: 1024, max: 128000 },
  },
]

const GOOGLE_SAFETY_OPTIONS = [
  { value: "BLOCK_NONE", label: "providerParams.google.safetySettings.none" },
  { value: "BLOCK_LOW_AND_ABOVE", label: "providerParams.google.safetySettings.low" },
  { value: "BLOCK_MEDIUM_AND_ABOVE", label: "providerParams.google.safetySettings.medium" },
  { value: "BLOCK_ONLY_HIGH", label: "providerParams.google.safetySettings.high" },
  { value: "OFF", label: "providerParams.google.safetySettings.off" },
]

const GOOGLE_SPECIFIC_PARAMETERS: ParameterDefinition[] = [
  {
    key: "google.safetySettings.harassment",
    type: "select",
    label: "providerParams.google.safetySettings.harassment.label",
    description: "providerParams.google.safetySettings.harassment.description",
    category: "provider-specific",
    defaultValue: "BLOCK_MEDIUM_AND_ABOVE",
    group: "providerParams.google.safetySettings.label",
    validation: { options: GOOGLE_SAFETY_OPTIONS },
  },
  {
    key: "google.safetySettings.hateSpeech",
    type: "select",
    label: "providerParams.google.safetySettings.hateSpeech.label",
    description: "providerParams.google.safetySettings.hateSpeech.description",
    category: "provider-specific",
    defaultValue: "BLOCK_MEDIUM_AND_ABOVE",
    group: "providerParams.google.safetySettings.label",
    validation: { options: GOOGLE_SAFETY_OPTIONS },
  },
  {
    key: "google.safetySettings.sexuallyExplicit",
    type: "select",
    label: "providerParams.google.safetySettings.sexuallyExplicit.label",
    description: "providerParams.google.safetySettings.sexuallyExplicit.description",
    category: "provider-specific",
    defaultValue: "BLOCK_MEDIUM_AND_ABOVE",
    group: "providerParams.google.safetySettings.label",
    validation: { options: GOOGLE_SAFETY_OPTIONS },
  },
  {
    key: "google.safetySettings.dangerousContent",
    type: "select",
    label: "providerParams.google.safetySettings.dangerousContent.label",
    description: "providerParams.google.safetySettings.dangerousContent.description",
    category: "provider-specific",
    defaultValue: "BLOCK_MEDIUM_AND_ABOVE",
    group: "providerParams.google.safetySettings.label",
    validation: { options: GOOGLE_SAFETY_OPTIONS },
  },
]

const MISTRAL_SPECIFIC_PARAMETERS: ParameterDefinition[] = [
  {
    key: "mistral.safePrompt",
    type: "toggle",
    label: "providerParams.mistral.safePrompt.label",
    description: "providerParams.mistral.safePrompt.description",
    category: "provider-specific",
    defaultValue: false,
  },
]

// ---------------------------------------------------------------------------
// Helper to build a full schema (inference + specific + connection)
// ---------------------------------------------------------------------------

function buildSchema(
  providerId: string,
  providerName: string,
  specificParams: ParameterDefinition[] = []
): ProviderParameterSchema {
  return {
    providerId,
    providerName,
    parameters: [
      ...COMMON_INFERENCE_PARAMETERS,
      ...specificParams,
      ...COMMON_CONNECTION_PARAMETERS,
    ],
  }
}

// ---------------------------------------------------------------------------
// PROVIDER_SCHEMAS registry
// ---------------------------------------------------------------------------

export const PROVIDER_SCHEMAS: Record<string, ProviderParameterSchema> = {
  openai: buildSchema("openai", "OpenAI", OPENAI_SPECIFIC_PARAMETERS),
  anthropic: buildSchema("anthropic", "Anthropic", ANTHROPIC_SPECIFIC_PARAMETERS),
  google: buildSchema("google", "Google", GOOGLE_SPECIFIC_PARAMETERS),
  deepseek: buildSchema("deepseek", "DeepSeek"),
  xai: buildSchema("xai", "xAI"),
  mistral: buildSchema("mistral", "Mistral", MISTRAL_SPECIFIC_PARAMETERS),
  ollama: buildSchema("ollama", "Ollama"),
  togetherai: buildSchema("togetherai", "Together AI"),
  cohere: buildSchema("cohere", "Cohere"),
  // Providers with no unique parameters beyond inference + connection
  groq: buildSchema("groq", "Groq"),
  fireworks: buildSchema("fireworks", "Fireworks"),
  cerebras: buildSchema("cerebras", "Cerebras"),
  sambanova: buildSchema("sambanova", "SambaNova"),
  zhipu: buildSchema("zhipu", "Zhipu"),
  minimax: buildSchema("minimax", "MiniMax"),
  // OpenRouter - uses openai-compatible API
  openrouter: buildSchema("openrouter", "OpenRouter"),
}

// ---------------------------------------------------------------------------
// getSchemaForProvider
// ---------------------------------------------------------------------------

/**
 * Returns the parameter schema for a given provider ID.
 *
 * Resolution order:
 * 1. Built-in schema from PROVIDER_SCHEMAS
 * 2. Custom provider — inherits from its apiProtocol schema, overriding id/name
 * 3. Unknown provider — returns inference + connection parameters only
 */
export function getSchemaForProvider(
  providerId: string,
  customProviders?: Record<string, Pick<CustomProviderSettings, "apiProtocol" | "name">>
): ProviderParameterSchema {
  // 1. Built-in
  if (PROVIDER_SCHEMAS[providerId]) {
    return PROVIDER_SCHEMAS[providerId]
  }

  // 2. Custom provider — inherit from apiProtocol
  if (customProviders?.[providerId]) {
    const custom = customProviders[providerId]
    const baseSchema = PROVIDER_SCHEMAS[custom.apiProtocol]
    const providerName = custom.name ?? providerId

    if (baseSchema) {
      return {
        ...baseSchema,
        providerId,
        providerName,
      }
    }

    // apiProtocol not found in built-ins — fall through to fallback
  }

  // 3. Fallback — inference + connection only
  return buildSchema(providerId, providerId)
}
