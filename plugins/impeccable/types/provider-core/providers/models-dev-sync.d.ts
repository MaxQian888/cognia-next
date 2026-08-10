import { BuiltInProviderAdapterId } from "@cognia/provider-types/built-in-provider-catalog"
import { ModelsDevCatalogRow } from "./models-dev-catalog-db.js"
import { ModelsDevCatalogModel } from "./models-dev.js"
import { CatalogRepository } from "./catalog-repository.js"
import "@cognia/provider-types/model-catalog"
import "@cognia/provider-types/provider"

/**
 * models.dev catalog sync orchestration.
 *
 * Layers on top of the raw mapper (`models-dev.ts`) and the Dexie cache
 * (`lib/db/models-dev-catalog.ts`):
 *  - {@link syncModelsDevCatalog} — fetch live → normalize → persist.
 *  - {@link ensureModelsDevCatalog} — read cache, seeding the bundled offline
 *    snapshot on first run.
 *  - {@link refreshModelsDevCatalogIfStale} — app-start hook; background-refresh
 *    if older than the threshold, swallowing errors.
 *  - {@link getCatalogModelsForProvider} / {@link getCatalogModelMetadata} —
 *    synchronous reads over an in-memory cache for UI render paths.
 *  - {@link resolveProviderAdapter} — provider-level adapter (static catalog
 *    wins; models.dev-derived fills the gap; `openai-compatible` last).
 *
 * The bundled snapshot is dynamic-imported only here so the ~MB JSON is
 * code-split out of the main bundle.
 */

/**
 * Wire the single catalog repository used by the host runtime. Optional for
 * headless package consumers that only need the legacy normalized projection.
 */
declare function setProviderCatalogRepository(repository: CatalogRepository | null): void
declare function setProviderCatalogRollout(options: { includeExperimentalProviders: boolean }): void
/** Prime the synchronous in-memory cache (called by the liveQuery hook). */
declare function primeModelsDevCatalogCache(row: ModelsDevCatalogRow | null | undefined): void
declare function getCachedModelsDevCatalog(): ModelsDevCatalogRow | null
/** Test-only reset. */
declare function __resetModelsDevCatalogCacheForTesting(): void
/** Guard against upstream truncation replacing a healthy local revision. */
declare const MODELS_DEV_MIN_RETENTION_RATIO = 0.75
/** Seed Catalog v2 from the bundled shard when no active revision is loaded. */
declare function ensureUnifiedProviderCatalog(now?: number): Promise<void>
/** Fetch the live models.dev catalog, normalize, persist, and prime the cache. */
declare function syncModelsDevCatalog(now?: number): Promise<ModelsDevCatalogRow>
/**
 * Read the cached catalog, seeding the bundled offline snapshot on first run so
 * the app is never empty (even offline / before the first network sync).
 */
declare function ensureModelsDevCatalog(now?: number): Promise<ModelsDevCatalogRow>
/**
 * App-start hook: ensure a catalog exists (seed bundled), then refresh in the
 * background if stale. Never throws — a failed refresh leaves the existing
 * (bundled or older remote) catalog in place.
 */
declare function refreshModelsDevCatalogIfStale(maxAgeMs?: number, now?: number): Promise<void>
/** models.dev models for a provider, from the in-memory cache. */
declare function getCatalogModelsForProvider(providerId: string): ModelsDevCatalogModel[]
/** Metadata for a single (provider, model) from the in-memory cache. */
declare function getCatalogModelMetadata(
  providerId: string,
  modelId: string
): ModelsDevCatalogModel | undefined
/**
 * Resolve a provider's adapter/driver. Provider-level config is authoritative,
 * so the static catalog wins; models.dev's npm-derived adapter fills the gap
 * for providers the static catalog leaves unspecified; `openai-compatible` is
 * the final long-tail fallback.
 */
declare function resolveProviderAdapter(providerId: string): BuiltInProviderAdapterId

export {
  MODELS_DEV_MIN_RETENTION_RATIO,
  __resetModelsDevCatalogCacheForTesting,
  ensureModelsDevCatalog,
  ensureUnifiedProviderCatalog,
  getCachedModelsDevCatalog,
  getCatalogModelMetadata,
  getCatalogModelsForProvider,
  primeModelsDevCatalogCache,
  refreshModelsDevCatalogIfStale,
  resolveProviderAdapter,
  setProviderCatalogRepository,
  setProviderCatalogRollout,
  syncModelsDevCatalog,
}
