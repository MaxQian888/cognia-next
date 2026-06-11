/**
 * Resolve the active model's *context window* and *pricing* from the synced
 * models.dev catalog so the footer/`/context` gauge and the cost segment adapt
 * per model instead of falling back to the hard-coded 200k window and the SDK's
 * (frequently zero) cost.
 *
 * The catalog is the same one the desktop syncs into Dexie (`models.dev`);
 * `getModelsDevCatalog` reads the single cached row. When the catalog is
 * missing, stale, or doesn't carry the model, we degrade gracefully to
 * `getModelContextWindow` (the pattern table) for the window and no pricing —
 * so a fresh install with no catalog behaves exactly as before.
 *
 * Pure given the injected `loadCatalog` reader.
 */
import { getModelContextWindow } from "@/lib/claude/usage"
import type { ModelPricing } from "@/types/provider/provider"
import { getModelsDevCatalog, type ModelsDevCatalogRow } from "@/lib/db/models-dev-catalog"

/** Per-model display metadata the TUI needs to size the context gauge + cost. */
export interface ModelMeta {
  /** Context window in tokens for the active model. */
  contextWindow: number
  /** Per-token pricing, when the catalog knows it (drives the cost fallback). */
  pricing?: Partial<ModelPricing>
}

type CatalogLoader = () => Promise<ModelsDevCatalogRow | undefined>

/**
 * Find a catalog model entry by id — preferring the active provider's models,
 * then falling back to any provider that lists the same id (model ids are
 * effectively global, so a provider mismatch shouldn't lose the data).
 */
function findCatalogModel(
  row: ModelsDevCatalogRow,
  provider: string,
  modelId: string
): { contextLength?: number; pricing?: Partial<ModelPricing> } | undefined {
  const own = row.providers[provider]?.models.find((m) => m.id === modelId)
  if (own) return own
  for (const p of Object.values(row.providers)) {
    const hit = p.models.find((m) => m.id === modelId)
    if (hit) return hit
  }
  return undefined
}

/**
 * Resolve `{ contextWindow, pricing }` for `provider`/`modelId`. The catalog
 * `contextLength` wins when present and positive; otherwise the pattern-table
 * window is used. Never throws — a read/shape error degrades to the fallback.
 */
export async function resolveModelMeta(
  provider: string,
  modelId: string | undefined,
  loadCatalog: CatalogLoader = getModelsDevCatalog
): Promise<ModelMeta> {
  const fallback = getModelContextWindow(modelId)
  if (!modelId) return { contextWindow: fallback }
  try {
    const row = await loadCatalog()
    if (!row) return { contextWindow: fallback }
    const entry = findCatalogModel(row, provider, modelId)
    if (!entry) return { contextWindow: fallback }
    const contextWindow =
      typeof entry.contextLength === "number" && entry.contextLength > 0
        ? entry.contextLength
        : fallback
    return entry.pricing ? { contextWindow, pricing: entry.pricing } : { contextWindow }
  } catch {
    return { contextWindow: fallback }
  }
}
