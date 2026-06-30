/**
 * OpenRouter live-catalog sync orchestration.
 *
 * The OpenRouter analogue of `models-dev-sync.ts`. Layers on top of the
 * discovery normalizer (`discoverOpenRouterModels`) and the Dexie cache
 * (`lib/db/openrouter-catalog.ts`):
 *  - {@link syncOpenRouterCatalog} — fetch live `/models` → normalize → persist
 *    → prime the in-memory cache.
 *  - {@link refreshOpenRouterCatalogIfStale} — app-start hook; prime the cache
 *    from the existing row, then background-refresh if missing/older than the
 *    24h threshold, swallowing errors.
 *  - {@link getCachedOpenRouterCatalogModels} — synchronous read over an
 *    in-memory cache for UI render paths (the model picker).
 *
 * Unlike models.dev there is NO bundled snapshot — the OpenRouter `/models`
 * endpoint is fetched keyless (the full public catalog), so the very first boot
 * populates the row from the network. Until then the picker falls back to the
 * static `PROVIDERS.openrouter.models` subset, which is the correct degradation.
 */

import type { ProviderModelDiscoveryEntry } from "@cognia/provider-types/provider"
import {
  getOpenRouterCatalog,
  isOpenRouterCatalogStale,
  saveOpenRouterCatalog,
  OPENROUTER_CATALOG_STALE_MS,
  type OpenRouterCatalogRow,
} from "./openrouter-catalog-db"
import { discoverOpenRouterModels } from "./model-discovery"

// =============================================================================
// In-memory cache (for synchronous UI reads; primed by sync + the refresh hook)
// =============================================================================

// The cache is parked on `globalThis`, NOT a module-level `let`. Reason: the CLI
// is an esbuild bundle with code-splitting, and this module is reachable from
// both the eager graph (the `/model` picker reads `getCachedOpenRouterCatalogModels`)
// and a lazy dynamic-import chain (the provider resolver writes via the
// `lib/ai/providers/openrouter-catalog-sync` shim). esbuild duplicated the module
// into two chunks, so a plain module-level variable gave the writer and the
// reader SEPARATE caches — the sync populated one copy while the picker read the
// other (empty) one, so it never left the static fallback subset. A single global
// slot is shared by every duplicated copy, so writer and reader always agree.
const CACHE_KEY = "__cogniaOpenRouterCatalogCache__"

type CacheHolder = { [CACHE_KEY]?: OpenRouterCatalogRow | null }

function cacheHolder(): CacheHolder {
  return globalThis as unknown as CacheHolder
}

/** Prime the synchronous in-memory cache (called by the liveQuery hook + CLI boot). */
export function primeOpenRouterCatalogCache(row: OpenRouterCatalogRow | null | undefined): void {
  cacheHolder()[CACHE_KEY] = row ?? null
}

export function getCachedOpenRouterCatalog(): OpenRouterCatalogRow | null {
  return cacheHolder()[CACHE_KEY] ?? null
}

/** The cached OpenRouter model list (empty until first sync / prime). */
export function getCachedOpenRouterCatalogModels(): ProviderModelDiscoveryEntry[] {
  return cacheHolder()[CACHE_KEY]?.models ?? []
}

/** Test-only reset. */
export function __resetOpenRouterCatalogCacheForTesting(): void {
  cacheHolder()[CACHE_KEY] = null
}

// =============================================================================
// Sync / refresh
// =============================================================================

let inFlightSync: Promise<OpenRouterCatalogRow> | null = null

/**
 * Fetch the live OpenRouter `/models` list, normalize, persist, and prime the
 * cache. `apiKey` is optional — keyless fetches the full public catalog, which
 * is what we want for a catalog shared identically across GUI + CLI.
 */
export async function syncOpenRouterCatalog(
  now: number = Date.now(),
  apiKey?: string
): Promise<OpenRouterCatalogRow> {
  // Coalesce concurrent syncs (manual refresh button + stale auto-refresh racing).
  if (inFlightSync) return inFlightSync
  inFlightSync = (async () => {
    const models = await discoverOpenRouterModels(apiKey)
    const row = await saveOpenRouterCatalog({ models, fetchedAt: now })
    primeOpenRouterCatalogCache(row)
    return row
  })()
  try {
    return await inFlightSync
  } finally {
    inFlightSync = null
  }
}

/**
 * App-start hook: prime the cache from the persisted row, then refresh in the
 * background if the catalog is missing or stale (>24h). Never throws — a failed
 * refresh leaves the existing (or empty) catalog in place. Returns the row that
 * is now cached (post-refresh when a refresh ran, else the existing row).
 */
export async function refreshOpenRouterCatalogIfStale(
  maxAgeMs: number = OPENROUTER_CATALOG_STALE_MS,
  now: number = Date.now(),
  apiKey?: string
): Promise<OpenRouterCatalogRow | null> {
  try {
    const existing = await getOpenRouterCatalog()
    primeOpenRouterCatalogCache(existing ?? null)
  } catch {
    // A read failure (corrupt snapshot, locked db) leaves the cache untouched.
    return getCachedOpenRouterCatalog()
  }
  try {
    if (await isOpenRouterCatalogStale(maxAgeMs, now)) {
      return await syncOpenRouterCatalog(now, apiKey)
    }
  } catch {
    // Background refresh failure is non-fatal; keep the cached catalog.
  }
  return getCachedOpenRouterCatalog()
}
