/**
 * Multi-API-key rotation for a search provider.
 *
 * A provider's `apiKey` plus its optional `apiKeys[]` form a rotation pool. On
 * each request one key is chosen by the configured strategy; the retry loop in
 * `search-service` then walks the rest of the pool so a rate-limited or rejected
 * key is skipped without a fresh network round-trip.
 *
 * Rotation cursor + per-key usage counters are kept in-memory (session-scoped),
 * NOT persisted: search runs on a hot path where a settings-store write per
 * request would be wasteful, and round-robin / least-used only need
 * within-session state to behave correctly. The store still owns the durable
 * inputs (`apiKeys`, `apiKeyRotationEnabled`, `apiKeyRotationStrategy`).
 */

import type {
  SearchApiKeyRotationStrategy,
  SearchProviderSettings,
  SearchProviderType,
} from "./types"

export type RotationInput = Pick<
  SearchProviderSettings,
  "apiKey" | "apiKeys" | "apiKeyRotationEnabled" | "apiKeyRotationStrategy"
>

/**
 * Clean, de-duplicated key pool: the primary `apiKey` first, then any extra
 * `apiKeys[]`. Blank / whitespace-only / duplicate entries are dropped.
 */
export function buildKeyPool(
  settings: Pick<SearchProviderSettings, "apiKey" | "apiKeys">
): string[] {
  const seen = new Set<string>()
  const pool: string[] = []
  for (const raw of [settings.apiKey, ...(settings.apiKeys ?? [])]) {
    const key = typeof raw === "string" ? raw.trim() : ""
    if (!key || seen.has(key)) continue
    seen.add(key)
    pool.push(key)
  }
  return pool
}

interface ProviderRotationState {
  /** Index of the most recently *attempted* key (round-robin resumes after it). */
  lastIndex: number
  /** Per-key attempt counters keyed by the key string (for least-used). */
  usage: Map<string, number>
}

const rotationState = new Map<SearchProviderType, ProviderRotationState>()

function stateFor(providerId: SearchProviderType): ProviderRotationState {
  let s = rotationState.get(providerId)
  if (!s) {
    s = { lastIndex: -1, usage: new Map() }
    rotationState.set(providerId, s)
  }
  return s
}

function leastUsedIndex(pool: string[], usage: Map<string, number>): number {
  let best = 0
  let bestCount = Number.POSITIVE_INFINITY
  for (let i = 0; i < pool.length; i++) {
    const count = usage.get(pool[i]) ?? 0
    if (count < bestCount) {
      bestCount = count
      best = i
    }
  }
  return best
}

/**
 * Choose the pool index to try FIRST for this request. The retry loop then
 * advances `(startIndex + attempt) % pool.length`. Returns 0 for an
 * empty/single-key pool or when rotation is disabled (always the primary key).
 */
export function pickStartIndex(
  providerId: SearchProviderType,
  pool: string[],
  settings: RotationInput,
  opts?: { random?: () => number }
): number {
  if (pool.length <= 1) return 0
  if (!settings.apiKeyRotationEnabled) return 0

  const strategy: SearchApiKeyRotationStrategy = settings.apiKeyRotationStrategy ?? "round-robin"
  const state = stateFor(providerId)
  switch (strategy) {
    case "random": {
      const r = opts?.random ? opts.random() : Math.random()
      return Math.min(pool.length - 1, Math.max(0, Math.floor(r * pool.length)))
    }
    case "least-used":
      return leastUsedIndex(pool, state.usage)
    case "round-robin":
    default:
      return (state.lastIndex + 1) % pool.length
  }
}

/**
 * Record that `key` (at pool `index`) was attempted: advance the round-robin
 * cursor past it and bump its usage counter. Call for every attempt (success or
 * failure) so round-robin resumes correctly and least-used reflects load.
 */
export function recordKeyAttempt(providerId: SearchProviderType, key: string, index: number): void {
  const state = stateFor(providerId)
  state.lastIndex = index
  state.usage.set(key, (state.usage.get(key) ?? 0) + 1)
}

/** Reset all in-memory rotation state. Test-only seam. */
export function resetRotationState(): void {
  rotationState.clear()
}
