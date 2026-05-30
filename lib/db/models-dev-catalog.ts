// Read/write for the cached models.dev catalog (Dexie v60). A single
// "singleton" row, mirroring the get/save convention of `lib/db/settings.ts`.
// Higher-level fetch/seed/refresh orchestration lives in
// `lib/ai/providers/models-dev-sync.ts`.

import type {
  NormalizedModelsDevCatalog,
  NormalizedModelsDevProvider,
} from "@/lib/ai/providers/models-dev"
import { getDb } from "./schema"

/**
 * Cached models.dev catalog row (Dexie v60). A single "singleton" row holding
 * the normalized catalog keyed by our internal provider ids. `source` records
 * whether the data came from the live API or the bundled offline snapshot.
 *
 * Co-located with this CRUD module; `schema.ts` imports + re-exports it, so
 * existing `@/lib/db/schema` import sites keep working. See `CONVENTIONS.md`.
 */
export interface ModelsDevCatalogRow {
  /** Always `"singleton"`. */
  id: string
  /** Epoch milliseconds when this snapshot was written. */
  fetchedAt: number
  /** Where the data came from. */
  source: "remote" | "bundled"
  /** Normalized catalog, keyed by our internal provider id. */
  providers: Record<string, NormalizedModelsDevProvider>
}

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
