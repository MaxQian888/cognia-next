/**
 * Built-in Routing Presets
 *
 * Three predefined routing profiles that users can activate with one click.
 * Presets dynamically adapt to which providers are enabled.
 */

import type { RoutingPreset, BuiltInPresetId } from "@/types/provider/routing-presets"
import type { ModelMapping, ModelMappingEntry } from "@/types/provider/model-mapping"

/** Provider:model entries used across presets */
const KNOWN_ENTRIES = {
  // Fast / cheap
  groqLlama: { providerId: "groq", modelId: "llama-3.3-70b-versatile" } as ModelMappingEntry,
  cerebrasLlama: { providerId: "cerebras", modelId: "llama-3.3-70b" } as ModelMappingEntry,
  deepseekChat: { providerId: "deepseek", modelId: "deepseek-v4-flash" } as ModelMappingEntry,
  openaiMini: { providerId: "openai", modelId: "gpt-4o-mini" } as ModelMappingEntry,
  geminiFlash: { providerId: "google", modelId: "gemini-2.0-flash-exp" } as ModelMappingEntry,

  // Balanced
  openaiGpt4o: { providerId: "openai", modelId: "gpt-4o" } as ModelMappingEntry,
  claudeSonnet: {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-20250514",
  } as ModelMappingEntry,
  geminiPro: { providerId: "google", modelId: "gemini-2.5-pro-exp-03-25" } as ModelMappingEntry,

  // Powerful
  claudeOpus: { providerId: "anthropic", modelId: "claude-opus-4-20250514" } as ModelMappingEntry,
  openaiGpt41: { providerId: "openai", modelId: "gpt-4.1" } as ModelMappingEntry,

  // Reasoning
  deepseekReasoner: { providerId: "deepseek", modelId: "deepseek-v4-pro" } as ModelMappingEntry,
  openaiO1: { providerId: "openai", modelId: "o1" } as ModelMappingEntry,

  // Coding
  deepseekCoder: { providerId: "deepseek", modelId: "deepseek-v4-flash" } as ModelMappingEntry,
} as const

/** Helper to create a mapping shape (without id/timestamps - those are added at activation) */
function mapping(
  alias: string,
  providers: ModelMappingEntry[],
  opts?: { temperature?: number }
): Omit<ModelMapping, "id" | "createdAt" | "updatedAt"> {
  return {
    alias,
    providers,
    distribution: "priority",
    enabled: true,
    isDefault: true,
    parameterDefaults: opts ? { temperature: opts.temperature } : undefined,
  }
}

/** Budget Mode: minimize cost, prefer free-tier and cheap providers */
export const BUDGET_PRESET: RoutingPreset = {
  id: "preset-budget",
  name: "Budget Mode",
  description:
    "Minimize cost. Prioritizes free-tier providers (Groq, Cerebras) and cheap models (DeepSeek). Best for casual conversations and simple tasks.",
  isBuiltIn: true,
  builtInId: "budget",
  strategy: "cost",
  icon: "piggy-bank",
  mappings: [
    mapping("fast", [
      KNOWN_ENTRIES.groqLlama,
      KNOWN_ENTRIES.cerebrasLlama,
      KNOWN_ENTRIES.deepseekChat,
    ]),
    mapping("balanced", [
      KNOWN_ENTRIES.deepseekChat,
      KNOWN_ENTRIES.groqLlama,
      KNOWN_ENTRIES.openaiMini,
    ]),
    mapping("powerful", [
      KNOWN_ENTRIES.deepseekChat,
      KNOWN_ENTRIES.openaiMini,
      KNOWN_ENTRIES.geminiFlash,
    ]),
    mapping("reasoning", [KNOWN_ENTRIES.deepseekReasoner, KNOWN_ENTRIES.groqLlama]),
    mapping("coding", [KNOWN_ENTRIES.deepseekCoder, KNOWN_ENTRIES.groqLlama], { temperature: 0.1 }),
  ],
  routingConfig: {
    strategy: "cost",
    allowPerRequestOverride: true,
    providerConstraints: [],
    requestTimeoutMs: 30000,
    maxFallbackAttempts: 3,
  },
}

/** Performance Mode: maximize quality, use flagship models */
export const PERFORMANCE_PRESET: RoutingPreset = {
  id: "preset-performance",
  name: "Performance Mode",
  description:
    "Maximize quality. Uses flagship models (GPT-4o, Claude Sonnet, Gemini Pro). Best for complex tasks, coding, and analysis.",
  isBuiltIn: true,
  builtInId: "performance",
  strategy: "quality",
  icon: "zap",
  mappings: [
    mapping("fast", [KNOWN_ENTRIES.geminiFlash, KNOWN_ENTRIES.openaiMini, KNOWN_ENTRIES.groqLlama]),
    mapping("balanced", [
      KNOWN_ENTRIES.openaiGpt4o,
      KNOWN_ENTRIES.claudeSonnet,
      KNOWN_ENTRIES.geminiPro,
    ]),
    mapping("powerful", [
      KNOWN_ENTRIES.claudeOpus,
      KNOWN_ENTRIES.openaiGpt41,
      KNOWN_ENTRIES.openaiGpt4o,
    ]),
    mapping("reasoning", [
      KNOWN_ENTRIES.openaiO1,
      KNOWN_ENTRIES.deepseekReasoner,
      KNOWN_ENTRIES.claudeOpus,
    ]),
    mapping(
      "coding",
      [KNOWN_ENTRIES.claudeSonnet, KNOWN_ENTRIES.openaiGpt4o, KNOWN_ENTRIES.deepseekCoder],
      { temperature: 0.1 }
    ),
  ],
  routingConfig: {
    strategy: "quality",
    allowPerRequestOverride: true,
    providerConstraints: [],
    requestTimeoutMs: 60000,
    maxFallbackAttempts: 2,
  },
}

/** Reliability Mode: maximum fallback coverage, balanced strategy */
export const RELIABILITY_PRESET: RoutingPreset = {
  id: "preset-reliability",
  name: "Reliability Mode",
  description:
    "Maximum uptime. Every alias has 3+ providers with aggressive failover. Best for production-critical workflows.",
  isBuiltIn: true,
  builtInId: "reliability",
  strategy: "balanced",
  icon: "shield",
  mappings: [
    mapping("fast", [
      KNOWN_ENTRIES.groqLlama,
      KNOWN_ENTRIES.cerebrasLlama,
      KNOWN_ENTRIES.geminiFlash,
      KNOWN_ENTRIES.openaiMini,
      KNOWN_ENTRIES.deepseekChat,
    ]),
    mapping("balanced", [
      KNOWN_ENTRIES.openaiGpt4o,
      KNOWN_ENTRIES.claudeSonnet,
      KNOWN_ENTRIES.geminiPro,
      KNOWN_ENTRIES.deepseekChat,
      KNOWN_ENTRIES.groqLlama,
    ]),
    mapping("powerful", [
      KNOWN_ENTRIES.claudeOpus,
      KNOWN_ENTRIES.openaiGpt41,
      KNOWN_ENTRIES.openaiGpt4o,
      KNOWN_ENTRIES.claudeSonnet,
      KNOWN_ENTRIES.geminiPro,
    ]),
    mapping("reasoning", [
      KNOWN_ENTRIES.openaiO1,
      KNOWN_ENTRIES.deepseekReasoner,
      KNOWN_ENTRIES.claudeOpus,
      KNOWN_ENTRIES.openaiGpt4o,
    ]),
    mapping(
      "coding",
      [
        KNOWN_ENTRIES.claudeSonnet,
        KNOWN_ENTRIES.deepseekCoder,
        KNOWN_ENTRIES.openaiGpt4o,
        KNOWN_ENTRIES.groqLlama,
      ],
      { temperature: 0.1 }
    ),
  ],
  routingConfig: {
    strategy: "balanced",
    allowPerRequestOverride: true,
    providerConstraints: [],
    requestTimeoutMs: 30000,
    maxFallbackAttempts: 5,
  },
}

/** All built-in presets */
export const BUILT_IN_PRESETS: RoutingPreset[] = [
  BUDGET_PRESET,
  PERFORMANCE_PRESET,
  RELIABILITY_PRESET,
]

/**
 * Get a built-in preset by ID
 */
export function getBuiltInPreset(id: BuiltInPresetId): RoutingPreset | undefined {
  return BUILT_IN_PRESETS.find((p) => p.builtInId === id)
}

/**
 * Adapt a preset's mappings to only include providers that are currently enabled.
 * Removes entries for unconfigured providers while preserving the fallback chain order.
 *
 * @param preset - The preset to adapt
 * @param enabledProviderIds - Set of currently enabled provider IDs
 * @returns Adapted preset with filtered mappings
 */
export function adaptPresetToEnabledProviders(
  preset: RoutingPreset,
  enabledProviderIds: Set<string>
): RoutingPreset {
  const adaptedMappings = preset.mappings
    .map((m) => ({
      ...m,
      providers: m.providers.filter((p) => enabledProviderIds.has(p.providerId)),
    }))
    .filter((m) => m.providers.length > 0) // Remove mappings with no available providers

  return {
    ...preset,
    mappings: adaptedMappings,
  }
}
