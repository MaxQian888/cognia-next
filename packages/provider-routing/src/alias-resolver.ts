/**
 * Alias Resolver
 *
 * Resolves a model alias string to a concrete provider:model entry list
 * using the ModelMappingRegistry. Supports priority-based fallback chains
 * and weighted random distribution, with optional condition filtering.
 */

import type {
  ModelMappingRegistry,
  ModelMappingEntry,
  AliasResolutionResult,
} from "@cognia/provider-types/model-mapping"

/** Health metrics for a provider, used to evaluate entry conditions */
export interface ProviderHealthMetricsLite {
  /** Cost per 1M tokens in USD */
  costPer1M?: number
  /** Recent P50 latency in ms */
  latencyMs?: number
}

/**
 * Resolve a model alias to a list of eligible provider:model entries.
 *
 * @param alias - The alias to resolve (e.g., 'fast', 'balanced', 'reasoning')
 * @param registry - The full model mapping registry
 * @param healthMetrics - Optional per-provider health data for condition filtering.
 *   Keys are `providerId:modelId` (e.g., `"openai:gpt-4o"`).
 * @returns AliasResolutionResult with ordered/weighted entries
 */
export function resolveModelAlias(
  alias: string,
  registry: ModelMappingRegistry,
  healthMetrics?: Record<string, ProviderHealthMetricsLite>
): AliasResolutionResult {
  // If the mapping system is globally disabled, return not-found
  if (!registry.enabled) {
    return { found: false, entries: [] }
  }

  // Find a matching, enabled mapping (case-insensitive alias match)
  const normalizedAlias = alias.toLowerCase()
  const mapping = registry.mappings.find(
    (m) => m.enabled && m.alias.toLowerCase() === normalizedAlias
  )

  if (!mapping) {
    return { found: false, entries: [] }
  }

  // Filter entries by conditions when health metrics are available
  let eligible = mapping.providers
  if (healthMetrics) {
    eligible = eligible.filter((entry) => {
      const key = `${entry.providerId}:${entry.modelId}`
      const metrics = healthMetrics[key]
      if (!metrics || !entry.conditions) return true

      if (
        entry.conditions.maxCostPer1M !== undefined &&
        metrics.costPer1M !== undefined &&
        metrics.costPer1M > entry.conditions.maxCostPer1M
      ) {
        return false
      }
      if (
        entry.conditions.maxLatencyMs !== undefined &&
        metrics.latencyMs !== undefined &&
        metrics.latencyMs > entry.conditions.maxLatencyMs
      ) {
        return false
      }

      return true
    })
  }

  // Sort entries based on distribution strategy
  let entries: ModelMappingEntry[]

  if (mapping.distribution === "weighted") {
    // Weighted distribution: shuffle entries according to their weights
    entries = weightedShuffle(eligible)
  } else {
    // Priority distribution: entries stay in their original order (fallback chain)
    entries = [...eligible]
  }

  return {
    found: true,
    entries,
    mapping,
    parameterDefaults: mapping.parameterDefaults,
  }
}

/**
 * Shuffle entries by weight so that higher-weight entries appear earlier
 * on average. Uses weighted random sampling without replacement.
 */
function weightedShuffle(entries: ModelMappingEntry[]): ModelMappingEntry[] {
  if (entries.length <= 1) return [...entries]

  // Assign default weight of 1 to entries without explicit weights
  const pool = entries.map((e) => ({ entry: e, weight: e.weight ?? 1 }))
  const result: ModelMappingEntry[] = []

  while (pool.length > 0) {
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0)
    if (totalWeight <= 0) {
      // All remaining have zero weight — append in order
      result.push(...pool.map((p) => p.entry))
      break
    }

    let rand = Math.random() * totalWeight
    let idx = 0
    for (let i = 0; i < pool.length; i++) {
      rand -= pool[i].weight
      if (rand <= 0) {
        idx = i
        break
      }
    }

    result.push(pool[idx].entry)
    pool.splice(idx, 1)
  }

  return result
}

/**
 * Pick a single provider:model entry from a resolution result.
 * For priority distribution this is always the first entry.
 * For weighted distribution the list is already shuffled, so first entry works too.
 */
export function pickTopEntry(result: AliasResolutionResult): ModelMappingEntry | null {
  return result.entries[0] ?? null
}
