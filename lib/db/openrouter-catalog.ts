// Read/write for the cached OpenRouter live-models catalog (Dexie v93). A single
// "singleton" row, mirroring the get/save convention of `lib/db/models-dev-catalog.ts`.
// Higher-level fetch/seed/refresh orchestration lives in
// `lib/ai/providers/openrouter-catalog-sync.ts` (a shim over @cognia/provider-core).

import type { OpenRouterCatalogRow } from "@cognia/provider-core/providers/openrouter-catalog-db"
import type { ProviderModelDiscoveryEntry } from "@cognia/provider-types/provider"
import { getDb } from "./schema"

export type { OpenRouterCatalogRow }

const SINGLETON_ID = "singleton" as const

/** Default staleness threshold for the cached catalog (24 hours). OpenRouter's
 * catalog churns far faster than models.dev's, hence the tighter window. */
export const OPENROUTER_CATALOG_STALE_MS = 24 * 60 * 60 * 1000

export async function getOpenRouterCatalog(): Promise<OpenRouterCatalogRow | undefined> {
  return getDb().openrouterCatalog.get(SINGLETON_ID)
}

export async function saveOpenRouterCatalog(input: {
  models: ProviderModelDiscoveryEntry[]
  fetchedAt: number
}): Promise<OpenRouterCatalogRow> {
  const row: OpenRouterCatalogRow = {
    id: SINGLETON_ID,
    fetchedAt: input.fetchedAt,
    source: "remote",
    models: input.models,
  }
  await getDb().openrouterCatalog.put(row)
  return row
}

/**
 * Whether the cached catalog is missing or older than `maxAgeMs`. `now` is
 * injectable for deterministic tests.
 */
export async function isOpenRouterCatalogStale(
  maxAgeMs: number = OPENROUTER_CATALOG_STALE_MS,
  now: number = Date.now()
): Promise<boolean> {
  const row = await getOpenRouterCatalog()
  if (!row) return true
  return now - row.fetchedAt > maxAgeMs
}
