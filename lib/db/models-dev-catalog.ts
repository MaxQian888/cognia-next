// Read/write for the cached models.dev catalog (Dexie v60). A single
// "singleton" row, mirroring the get/save convention of `lib/db/settings.ts`.
// Higher-level fetch/seed/refresh orchestration lives in
// `lib/ai/providers/models-dev-sync.ts`.

import type { NormalizedModelsDevCatalog } from "@/lib/ai/providers/models-dev"
import { getDb, type ModelsDevCatalogRow } from "./schema"

const SINGLETON_ID = "singleton" as const

/** Default staleness threshold for the cached catalog (7 days). */
export const MODELS_DEV_STALE_MS = 7 * 24 * 60 * 60 * 1000

export async function getModelsDevCatalog(): Promise<ModelsDevCatalogRow | undefined> {
  return getDb().modelsDevCatalog.get(SINGLETON_ID)
}

export async function saveModelsDevCatalog(input: {
  providers: NormalizedModelsDevCatalog
  fetchedAt: number
  source: ModelsDevCatalogRow["source"]
}): Promise<ModelsDevCatalogRow> {
  const row: ModelsDevCatalogRow = {
    id: SINGLETON_ID,
    fetchedAt: input.fetchedAt,
    source: input.source,
    providers: input.providers,
  }
  await getDb().modelsDevCatalog.put(row)
  return row
}

/**
 * Whether the cached catalog is missing or older than `maxAgeMs`. `now` is
 * injectable for deterministic tests.
 */
export async function isModelsDevCatalogStale(
  maxAgeMs: number = MODELS_DEV_STALE_MS,
  now: number = Date.now()
): Promise<boolean> {
  const row = await getModelsDevCatalog()
  if (!row) return true
  return now - row.fetchedAt > maxAgeMs
}
