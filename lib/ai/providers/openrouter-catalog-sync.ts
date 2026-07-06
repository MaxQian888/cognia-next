// Re-export shim: canonical source lives in @cognia/provider-core.
// Side effect on import: wire the host's Dexie-backed OpenRouter catalog store
// into the package seam. All consumers reach openrouter-catalog-sync through this
// shim, so the store is always wired before any catalog read/write runs.
import { setOpenRouterCatalogDb } from "@cognia/provider-core/providers/openrouter-catalog-db"
import {
  getOpenRouterCatalog,
  saveOpenRouterCatalog,
  isOpenRouterCatalogStale,
} from "@/lib/db/openrouter-catalog"

setOpenRouterCatalogDb({ getOpenRouterCatalog, saveOpenRouterCatalog, isOpenRouterCatalogStale })

export {
  __resetOpenRouterCatalogCacheForTesting,
  getCachedOpenRouterCatalog,
  getCachedOpenRouterCatalogModels,
  primeOpenRouterCatalogCache,
  refreshOpenRouterCatalogIfStale,
  syncOpenRouterCatalog,
} from "@cognia/provider-core/providers/openrouter-catalog-sync"
