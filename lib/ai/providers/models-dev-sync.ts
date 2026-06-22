// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
// Side effect on import: wire the host's Dexie-backed models.dev catalog store
// into the package seam. All consumers reach models-dev-sync through this shim,
// so the store is always wired before any catalog read/write runs.
import {
  setModelsDevCatalogDb,
  setModelsDevSnapshotLoader,
} from "@cognia/provider-core/providers/models-dev-catalog-db"
import {
  getModelsDevCatalog,
  saveModelsDevCatalog,
  isModelsDevCatalogStale,
} from "@/lib/db/models-dev-catalog"

setModelsDevCatalogDb({ getModelsDevCatalog, saveModelsDevCatalog, isModelsDevCatalogStale })
setModelsDevSnapshotLoader(async () => {
  const mod = (await import("@/lib/ai/providers/models-dev-snapshot.json")) as unknown as {
    default: unknown
  }
  return mod.default as never
})

export {
  __resetModelsDevCatalogCacheForTesting,
  ensureModelsDevCatalog,
  getCachedModelsDevCatalog,
  getCatalogModelMetadata,
  getCatalogModelsForProvider,
  primeModelsDevCatalogCache,
  refreshModelsDevCatalogIfStale,
  resolveProviderAdapter,
  syncModelsDevCatalog,
} from "@cognia/provider-core/providers/models-dev-sync"
