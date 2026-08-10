import {
  ApiKeyRotationStrategy,
  ApiKeyUsageStats,
  UserProviderSettings,
} from "@cognia/provider-types/provider"

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

type RotationSettings = Partial<
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
interface ApiKeySelection {
  /** The key to use for this request, or undefined if none configured. */
  apiKey: string | undefined
  /** Index into the cleaned key pool; undefined when a single key (no rotation). */
  index: number | undefined
  strategy: ApiKeyRotationStrategy | "single"
  poolSize: number
}
interface RotationPersist {
  currentKeyIndex: number
  apiKeyUsageStats: Record<string, ApiKeyUsageStats>
}
/**
 * Choose the key for the next request. When rotation is disabled or the pool is
 * empty, returns the single `apiKey` with `index: undefined`.
 */
declare function selectApiKey(
  settings: RotationSettings | undefined,
  opts?: {
    random?: () => number
  }
): ApiKeySelection
/**
 * Produce the persisted rotation state after a key was used: pin
 * `currentKeyIndex` to the selected slot (so round-robin advances next time) and
 * bump the per-key usage counters. Returns null when no pooled key was used
 * (single-key path needs no state).
 */
declare function recordKeyUse(
  settings: RotationSettings | undefined,
  selection: ApiKeySelection,
  opts?: {
    now?: number
    error?: string
  }
): RotationPersist | null

export {
  type ApiKeySelection,
  type RotationPersist,
  type RotationSettings,
  recordKeyUse,
  selectApiKey,
}
