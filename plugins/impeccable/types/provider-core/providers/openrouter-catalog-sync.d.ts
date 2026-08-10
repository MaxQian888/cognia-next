import { ProviderModelDiscoveryEntry } from "@cognia/provider-types/provider"
import { OpenRouterCatalogRow } from "./openrouter-catalog-db.js"

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

/** Prime the synchronous in-memory cache (called by the liveQuery hook + CLI boot). */
declare function primeOpenRouterCatalogCache(row: OpenRouterCatalogRow | null | undefined): void
declare function getCachedOpenRouterCatalog(): OpenRouterCatalogRow | null
/** The cached OpenRouter model list (empty until first sync / prime). */
declare function getCachedOpenRouterCatalogModels(): ProviderModelDiscoveryEntry[]
/** Test-only reset. */
declare function __resetOpenRouterCatalogCacheForTesting(): void
/**
 * Fetch the live OpenRouter `/models` list, normalize, persist, and prime the
 * cache. `apiKey` is optional — keyless fetches the full public catalog, which
 * is what we want for a catalog shared identically across GUI + CLI.
 */
declare function syncOpenRouterCatalog(now?: number, apiKey?: string): Promise<OpenRouterCatalogRow>
/**
 * App-start hook: prime the cache from the persisted row, then refresh in the
 * background if the catalog is missing or stale (>24h). Never throws — a failed
 * refresh leaves the existing (or empty) catalog in place. Returns the row that
 * is now cached (post-refresh when a refresh ran, else the existing row).
 */
declare function refreshOpenRouterCatalogIfStale(
  maxAgeMs?: number,
  now?: number,
  apiKey?: string
): Promise<OpenRouterCatalogRow | null>

export {
  __resetOpenRouterCatalogCacheForTesting,
  getCachedOpenRouterCatalog,
  getCachedOpenRouterCatalogModels,
  primeOpenRouterCatalogCache,
  refreshOpenRouterCatalogIfStale,
  syncOpenRouterCatalog,
}
