// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
// Side effect on import: wire the host's Dexie-backed models.dev catalog store
// into the package seam. All consumers reach models-dev-sync through this shim,
// so the store is always wired before any catalog read/write runs.
import {
  setModelsDevCatalogDb,
  setModelsDevSnapshotLoader,
} from "@cognia/provider-core/providers/models-dev-catalog-db"
import {
  ensureUnifiedProviderCatalog as ensureUnifiedProviderCatalogCore,
  refreshModelsDevCatalogIfStale as refreshModelsDevCatalogIfStaleCore,
  setProviderCatalogRollout,
  setProviderCatalogRepository,
} from "@cognia/provider-core/providers/models-dev-sync"
import {
  getModelsDevCatalog,
  saveModelsDevCatalog,
  isModelsDevCatalogStale,
} from "@/lib/db/models-dev-catalog"
import { providerCatalogRepository } from "@/lib/db/provider-catalog"
import { getProviderCatalogFeatureFlags } from "./provider-catalog-feature-flags"
import { setPresetCatalogRepository } from "@cognia/provider-core/providers/built-in-presets"
import { setDefaultMappingCatalogRepository } from "@cognia/provider-routing/default-mappings"
import { loadBundledModelsDevShards } from "./models-dev-shard-loader"

setModelsDevCatalogDb({ getModelsDevCatalog, saveModelsDevCatalog, isModelsDevCatalogStale })
setModelsDevSnapshotLoader(loadBundledModelsDevShards)

/** Hydrate the hot read index, seed Catalog v2, then run the weekly refresh. */
export async function initializeProviderCatalog(): Promise<void> {
  const flags = getProviderCatalogFeatureFlags()
  setProviderCatalogRepository(flags.providerCatalogV2 ? providerCatalogRepository : null)
  setProviderCatalogRollout({ includeExperimentalProviders: flags.dynamicLongTail })
  if (flags.providerCatalogV2) {
    await providerCatalogRepository.hydrate()
    await ensureUnifiedProviderCatalogCore()
    setPresetCatalogRepository(providerCatalogRepository)
    setDefaultMappingCatalogRepository(providerCatalogRepository)
  }
  await refreshModelsDevCatalogIfStaleCore()
}

export {
  __resetModelsDevCatalogCacheForTesting,
  ensureModelsDevCatalog,
  ensureUnifiedProviderCatalog,
  getCachedModelsDevCatalog,
  getCatalogModelMetadata,
  getCatalogModelsForProvider,
  primeModelsDevCatalogCache,
  refreshModelsDevCatalogIfStale,
  resolveProviderAdapter,
  syncModelsDevCatalog,
} from "@cognia/provider-core/providers/models-dev-sync"
