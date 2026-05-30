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

import { getBuiltInProviderAdapter } from "@/types/provider/built-in-provider-catalog"
import type { BuiltInProviderAdapterId } from "@/types/provider/built-in-provider-catalog"
import {
  getModelsDevCatalog,
  isModelsDevCatalogStale,
  saveModelsDevCatalog,
  MODELS_DEV_STALE_MS,
} from "@/lib/db/models-dev-catalog"
import type { ModelsDevCatalogRow } from "@/lib/db/schema"
import {
  deriveAdapterFromNpm,
  fetchModelsDevApi,
  normalizeModelsDevApi,
  type ModelsDevApi,
  type ModelsDevCatalogModel,
} from "@/lib/ai/providers/models-dev"
import { resolveModelsDevProviderId } from "@/lib/ai/providers/models-dev-id-map"

// =============================================================================
// In-memory cache (for synchronous UI reads; primed by sync/ensure + the hook)
// =============================================================================

let cachedCatalog: ModelsDevCatalogRow | null = null

/** Prime the synchronous in-memory cache (called by the liveQuery hook). */
export function primeModelsDevCatalogCache(row: ModelsDevCatalogRow | null | undefined): void {
  cachedCatalog = row ?? null
}

export function getCachedModelsDevCatalog(): ModelsDevCatalogRow | null {
  return cachedCatalog
}

/** Test-only reset. */
export function __resetModelsDevCatalogCacheForTesting(): void {
  cachedCatalog = null
}

// =============================================================================
// Sync / ensure / refresh
// =============================================================================

let inFlightSync: Promise<ModelsDevCatalogRow> | null = null

/** Fetch the live models.dev catalog, normalize, persist, and prime the cache. */
export async function syncModelsDevCatalog(now: number = Date.now()): Promise<ModelsDevCatalogRow> {
  // Coalesce concurrent syncs (manual button + stale auto-refresh racing).
  if (inFlightSync) return inFlightSync
  inFlightSync = (async () => {
    const api = await fetchModelsDevApi()
    const providers = normalizeModelsDevApi(api)
    const row = await saveModelsDevCatalog({ providers, fetchedAt: now, source: "remote" })
    cachedCatalog = row
    return row
  })()
  try {
    return await inFlightSync
  } finally {
    inFlightSync = null
  }
}

/**
 * Read the cached catalog, seeding the bundled offline snapshot on first run so
 * the app is never empty (even offline / before the first network sync).
 */
export async function ensureModelsDevCatalog(
  now: number = Date.now()
): Promise<ModelsDevCatalogRow> {
  const existing = await getModelsDevCatalog()
  if (existing) {
    cachedCatalog = existing
    return existing
  }
  const api = await loadBundledSnapshot()
  const providers = normalizeModelsDevApi(api)
  const row = await saveModelsDevCatalog({ providers, fetchedAt: now, source: "bundled" })
  cachedCatalog = row
  return row
}

/**
 * App-start hook: ensure a catalog exists (seed bundled), then refresh in the
 * background if stale. Never throws — a failed refresh leaves the existing
 * (bundled or older remote) catalog in place.
 */
export async function refreshModelsDevCatalogIfStale(
  maxAgeMs: number = MODELS_DEV_STALE_MS,
  now: number = Date.now()
): Promise<void> {
  try {
    await ensureModelsDevCatalog(now)
  } catch {
    // Even seeding failed (e.g. snapshot import error) — nothing else to do.
    return
  }
  try {
    if (await isModelsDevCatalogStale(maxAgeMs, now)) {
      await syncModelsDevCatalog(now)
    }
  } catch {
    // Background refresh failure is non-fatal; keep the cached catalog.
  }
}

/** Dynamic-import the bundled raw snapshot (code-split out of the main bundle). */
async function loadBundledSnapshot(): Promise<ModelsDevApi> {
  const mod = (await import("@/lib/ai/providers/models-dev-snapshot.json")) as unknown as {
    default: ModelsDevApi
  }
  return mod.default
}

// =============================================================================
// Synchronous reads (UI render paths)
// =============================================================================

/** models.dev models for a provider, from the in-memory cache. */
export function getCatalogModelsForProvider(providerId: string): ModelsDevCatalogModel[] {
  return cachedCatalog?.providers[providerId]?.models ?? []
}

/** Metadata for a single (provider, model) from the in-memory cache. */
export function getCatalogModelMetadata(
  providerId: string,
  modelId: string
): ModelsDevCatalogModel | undefined {
  return getCatalogModelsForProvider(providerId).find((m) => m.id === modelId)
}

/**
 * Resolve a provider's adapter/driver. Provider-level config is authoritative,
 * so the static catalog wins; models.dev's npm-derived adapter fills the gap
 * for providers the static catalog leaves unspecified; `openai-compatible` is
 * the final long-tail fallback.
 */
export function resolveProviderAdapter(providerId: string): BuiltInProviderAdapterId {
  const staticAdapter = getBuiltInProviderAdapter(providerId)
  if (staticAdapter) return staticAdapter
  const devId = resolveModelsDevProviderId(providerId)
  if (devId) {
    const entry = cachedCatalog?.providers[providerId]
    if (entry?.npm) return deriveAdapterFromNpm(entry.npm)
    // Fall back to any model-level adapter hint we cached.
    const modelAdapter = entry?.models.find((m) => m.adapter)?.adapter
    if (modelAdapter) return modelAdapter
  }
  return "openai-compatible"
}
