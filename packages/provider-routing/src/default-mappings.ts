/**
 * Default Model Mappings Generator
 *
 * Generates default model alias mappings (fast/balanced/powerful/reasoning)
 * based on which providers the user has enabled and configured.
 */

import { nanoid } from "nanoid"
import type { ModelMapping, ModelMappingEntry } from "@/types/provider/model-mapping"

/** Provider model catalog for each tier */
const TIER_MODELS: Record<string, ModelMappingEntry[]> = {
  fast: [
    { providerId: "groq", modelId: "llama-3.3-70b-versatile" },
    { providerId: "cerebras", modelId: "llama-3.3-70b" },
    { providerId: "sambanova", modelId: "Meta-Llama-3.3-70B-Instruct" },
    { providerId: "deepseek", modelId: "deepseek-v4-flash" },
    { providerId: "openai", modelId: "gpt-4o-mini" },
    { providerId: "anthropic", modelId: "claude-3-5-haiku-20241022" },
    { providerId: "google", modelId: "gemini-2.0-flash" },
    { providerId: "mistral", modelId: "mistral-small-latest" },
  ],
  balanced: [
    { providerId: "openai", modelId: "gpt-4o" },
    { providerId: "anthropic", modelId: "claude-sonnet-4-20250514" },
    { providerId: "google", modelId: "gemini-2.0-flash" },
    { providerId: "deepseek", modelId: "deepseek-v4-flash" },
    { providerId: "mistral", modelId: "mistral-large-latest" },
    { providerId: "xai", modelId: "grok-2" },
  ],
  powerful: [
    { providerId: "anthropic", modelId: "claude-opus-4-20250514" },
    { providerId: "openai", modelId: "gpt-4o" },
    { providerId: "google", modelId: "gemini-2.5-pro-preview-05-06" },
    { providerId: "xai", modelId: "grok-2" },
    { providerId: "mistral", modelId: "mistral-large-latest" },
  ],
  reasoning: [
    { providerId: "openai", modelId: "o3" },
    { providerId: "anthropic", modelId: "claude-opus-4-20250514" },
    { providerId: "google", modelId: "gemini-2.5-pro-preview-05-06" },
    { providerId: "deepseek", modelId: "deepseek-v4-pro" },
  ],
}

/** Tier display names */
const TIER_NAMES: Record<string, string> = {
  fast: "Fast",
  balanced: "Balanced",
  powerful: "Powerful",
  reasoning: "Reasoning",
}

/**
 * Generate default model mappings filtered by enabled providers.
 *
 * @param enabledProviderIds - Set or array of provider IDs the user has configured
 * @returns Array of ModelMapping objects for each tier that has at least one provider
 */
export function generateDefaultMappings(
  enabledProviderIds: string[] | Set<string>
): ModelMapping[] {
  const enabled =
    enabledProviderIds instanceof Set ? enabledProviderIds : new Set(enabledProviderIds)

  const now = Date.now()
  const mappings: ModelMapping[] = []

  for (const [tier, entries] of Object.entries(TIER_MODELS)) {
    const filtered = entries.filter((e) => enabled.has(e.providerId))
    if (filtered.length === 0) continue

    mappings.push({
      id: nanoid(),
      alias: tier,
      providers: filtered,
      distribution: "priority",
      enabled: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    })
  }

  return mappings
}

/**
 * Get the display name for a tier alias.
 */
export function getTierDisplayName(alias: string): string {
  return TIER_NAMES[alias] ?? alias
}

/**
 * Get all known tier aliases.
 */
export function getDefaultTierAliases(): string[] {
  return Object.keys(TIER_MODELS)
}
