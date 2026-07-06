import type { ProviderModelDiscoveryEntry } from "@cognia/provider-types/provider"

/**
 * Cached OpenRouter live-models catalog row. A single "singleton" row holding the
 * full, real-time OpenRouter `/models` list normalized into our discovery shape —
 * the OpenRouter analogue of the `modelsDevCatalog` row. Both the desktop GUI and
 * the standalone CLI read this one shared row (the CLI shares the same Dexie via
 * its snapshot), so the OpenRouter model picker stays in lock-step across shells.
 */
export interface OpenRouterCatalogRow {
  /** Always `"singleton"`. */
  id: string
  /** Epoch milliseconds when this snapshot was written. */
  fetchedAt: number
  /** Where the data came from. OpenRouter ships no bundled snapshot, so it is
   * always `"remote"` once populated. */
  source: "remote"
  /** The live OpenRouter model list, normalized into our discovery entries. */
  models: ProviderModelDiscoveryEntry[]
}

/**
 * Persistence seam for the OpenRouter catalog. provider-core must not import the
 * app's Dexie layer directly, so catalog reads/writes go through this injected
 * interface. The host wires a Dexie-backed implementation at boot (see the
 * `lib/ai/providers/openrouter-catalog-sync.ts` shim). Type imports above are
 * erased at runtime — only the shape crosses the boundary.
 */
export interface OpenRouterCatalogDb {
  getOpenRouterCatalog(): Promise<OpenRouterCatalogRow | undefined>
  saveOpenRouterCatalog(input: {
    models: ProviderModelDiscoveryEntry[]
    fetchedAt: number
  }): Promise<OpenRouterCatalogRow>
  isOpenRouterCatalogStale(maxAgeMs?: number, now?: number): Promise<boolean>
}

/**
 * Catalog staleness window — 24 hours. OpenRouter's catalog churns far more often
 * than models.dev's (new models land daily), so the auto-refresh cadence is much
 * tighter than the models.dev 7-day window.
 */
export const OPENROUTER_CATALOG_STALE_MS = 24 * 60 * 60 * 1000

let _db: OpenRouterCatalogDb | null = null

/** Wire the host's Dexie-backed catalog store. Called once at app boot. */
export function setOpenRouterCatalogDb(db: OpenRouterCatalogDb): void {
  _db = db
}

function requireDb(): OpenRouterCatalogDb {
  if (!_db) {
    throw new Error(
      "[provider-core] OpenRouterCatalogDb not wired — call setOpenRouterCatalogDb() at boot " +
        "(the lib/ai/providers/openrouter-catalog-sync shim does this)."
    )
  }
  return _db
}

export function getOpenRouterCatalog(): Promise<OpenRouterCatalogRow | undefined> {
  return requireDb().getOpenRouterCatalog()
}

export function saveOpenRouterCatalog(
  input: Parameters<OpenRouterCatalogDb["saveOpenRouterCatalog"]>[0]
): Promise<OpenRouterCatalogRow> {
  return requireDb().saveOpenRouterCatalog(input)
}

export function isOpenRouterCatalogStale(maxAgeMs?: number, now?: number): Promise<boolean> {
  return requireDb().isOpenRouterCatalogStale(maxAgeMs, now)
}
