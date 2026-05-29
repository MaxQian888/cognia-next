// CRUD for GitHub "marketplace repo" sources (Dexie v59). A source is a repo
// that ships a `marketplace.json` catalog; its listed plugins surface in the
// browse grid. Mirrors the flat list/add/remove convention of the other
// `lib/db/*` modules.

import type { PluginMarketplaceSourceRow } from "./plugin-types"
import { getDb } from "./schema"

/** Newest-first list of saved marketplace sources. */
export async function listMarketplaceSources(): Promise<PluginMarketplaceSourceRow[]> {
  const rows = await getDb().pluginMarketplaceSources.orderBy("addedAt").toArray()
  return rows.reverse()
}

/**
 * Add (or refresh) a source. Keyed by `id` (canonical `owner/repo[@ref]`) so
 * re-adding the same repo updates its display name rather than duplicating.
 */
export async function addMarketplaceSource(
  source: Pick<PluginMarketplaceSourceRow, "id" | "repoRef" | "name">
): Promise<PluginMarketplaceSourceRow> {
  const existing = await getDb().pluginMarketplaceSources.get(source.id)
  const row: PluginMarketplaceSourceRow = {
    id: source.id,
    repoRef: source.repoRef,
    name: source.name,
    addedAt: existing?.addedAt ?? Date.now(),
  }
  await getDb().pluginMarketplaceSources.put(row)
  return row
}

export async function removeMarketplaceSource(id: string): Promise<void> {
  await getDb().pluginMarketplaceSources.delete(id)
}
