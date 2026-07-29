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
 *
 * The optional health fields let the caller seed the row from the catalog it
 * already fetched to preview the source — otherwise a freshly added source
 * would read as "never synced" until the next refresh, seconds after the user
 * watched us list its plugins.
 */
export async function addMarketplaceSource(
  source: Pick<PluginMarketplaceSourceRow, "id" | "repoRef" | "name"> &
    Partial<Pick<PluginMarketplaceSourceRow, "pluginCount" | "lastSyncedAt">>
): Promise<PluginMarketplaceSourceRow> {
  const existing = await getDb().pluginMarketplaceSources.get(source.id)
  const row: PluginMarketplaceSourceRow = {
    id: source.id,
    repoRef: source.repoRef,
    name: source.name,
    addedAt: existing?.addedAt ?? Date.now(),
    pluginCount: source.pluginCount ?? existing?.pluginCount,
    lastSyncedAt: source.lastSyncedAt ?? existing?.lastSyncedAt,
    // A successful add is by definition a successful fetch, so any stale
    // failure from a previous attempt is no longer true.
    lastError: source.lastSyncedAt !== undefined ? undefined : existing?.lastError,
  }
  await getDb().pluginMarketplaceSources.put(row)
  return row
}

/**
 * Record the outcome of a catalog fetch against a saved source.
 *
 * A no-op when the row is gone: a refresh that started before the user removed
 * the source must not put it back.
 */
export async function recordSourceSync(
  id: string,
  outcome: { ok: true; pluginCount: number; name?: string } | { ok: false; message: string }
): Promise<void> {
  const existing = await getDb().pluginMarketplaceSources.get(id)
  if (!existing) return
  const row: PluginMarketplaceSourceRow = outcome.ok
    ? {
        ...existing,
        // The catalog is authoritative for the display name: a marketplace
        // that renames itself shouldn't keep showing the name it had on the
        // day it was added.
        name: outcome.name?.trim() || existing.name,
        pluginCount: outcome.pluginCount,
        lastSyncedAt: Date.now(),
        lastError: undefined,
      }
    : { ...existing, lastError: outcome.message }
  await getDb().pluginMarketplaceSources.put(row)
}

export async function removeMarketplaceSource(id: string): Promise<void> {
  await getDb().pluginMarketplaceSources.delete(id)
}
