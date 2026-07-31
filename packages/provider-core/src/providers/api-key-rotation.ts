/**
 * Multi-API-key rotation for a provider.
 *
 * `UserProviderSettings` has long carried `apiKeys[]` + a rotation strategy +
 * per-key usage stats, but the send path only ever read the single `apiKey`.
 * This module turns that configuration into an actual per-request key choice
 * (round-robin / random / least-used) plus the persisted state update to record
 * afterwards. Pure + framework-agnostic (rng / clock injectable) so it unit
 * tests cleanly and can be reused by the chat send path and the plugin AI
 * surface.
 */

import type {
  ApiKeyRotationStrategy,
  ApiKeyUsageStats,
  UserProviderSettings,
} from "@cognia/provider-types/provider"

export type RotationSettings = Partial<
  Pick<
    UserProviderSettings,
    | "apiKey"
    | "apiKeys"
    | "apiKeyRotationEnabled"
    | "apiKeyRotationStrategy"
    | "apiKeyUsageStats"
    | "currentKeyIndex"
  >
>

export interface ApiKeySelection {
  /** The key to use for this request, or undefined if none configured. */
  apiKey: string | undefined
  /** Index into the cleaned key pool; undefined when a single key (no rotation). */
  index: number | undefined
  strategy: ApiKeyRotationStrategy | "single"
  poolSize: number
}

export interface RotationPersist {
  currentKeyIndex: number
  apiKeyUsageStats: Record<string, ApiKeyUsageStats>
}

function cleanPool(keys?: string[]): string[] {
  return (keys ?? [])
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter((k) => k.length > 0)
}

function leastUsedIndex(pool: string[], stats?: Record<string, ApiKeyUsageStats>): number {
  let best = 0
  let bestCount = Number.POSITIVE_INFINITY
  for (let i = 0; i < pool.length; i++) {
    const count = stats?.[pool[i]]?.usageCount ?? 0
    if (count < bestCount) {
      bestCount = count
      best = i
    }
  }
  return best
}

/**
 * Choose the key for the next request. When rotation is disabled or the pool is
 * empty, returns the single `apiKey` with `index: undefined`.
 */
export function selectApiKey(
  settings: RotationSettings | undefined,
  opts?: { random?: () => number }
): ApiKeySelection {
  const pool = cleanPool(settings?.apiKeys)
  const single = settings?.apiKey?.trim() || undefined

  if (!settings?.apiKeyRotationEnabled || pool.length === 0) {
    return {
      apiKey: single ?? pool[0],
      index: undefined,
      strategy: "single",
      poolSize: pool.length,
    }
  }

  const strategy = settings.apiKeyRotationStrategy ?? "round-robin"
  let index: number
  switch (strategy) {
    case "random": {
      const r = opts?.random ? opts.random() : Math.random()
      index = Math.min(pool.length - 1, Math.max(0, Math.floor(r * pool.length)))
      break
    }
    case "least-used":
      index = leastUsedIndex(pool, settings.apiKeyUsageStats)
      break
    case "round-robin":
    default: {
      const last = typeof settings.currentKeyIndex === "number" ? settings.currentKeyIndex : -1
      index = (last + 1) % pool.length
      break
    }
  }
  return { apiKey: pool[index], index, strategy, poolSize: pool.length }
}

/**
 * Produce the persisted rotation state after a key was used: pin
 * `currentKeyIndex` to the selected slot (so round-robin advances next time) and
 * bump the per-key usage counters. Returns null when no pooled key was used
 * (single-key path needs no state).
 */
export function recordKeyUse(
  settings: RotationSettings | undefined,
  selection: ApiKeySelection,
  opts?: { now?: number; error?: string }
): RotationPersist | null {
  if (selection.index === undefined || !selection.apiKey) return null
  const now = opts?.now ?? Date.now()
  const stats: Record<string, ApiKeyUsageStats> = { ...(settings?.apiKeyUsageStats ?? {}) }
  const prev = stats[selection.apiKey] ?? { usageCount: 0, lastUsed: 0, errorCount: 0 }
  const next: ApiKeyUsageStats = {
    usageCount: prev.usageCount + 1,
    lastUsed: now,
    errorCount: prev.errorCount + (opts?.error ? 1 : 0),
  }
  const lastError = opts?.error ?? prev.lastError
  if (lastError) next.lastError = lastError
  stats[selection.apiKey] = next
  return { currentKeyIndex: selection.index, apiKeyUsageStats: stats }
}
