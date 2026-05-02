// Plugin-reviews table CRUD (Dexie v15 — §A-Schema).
//
// Caches marketplace reviews locally so the Marketplace tab can render
// offline. Composite primary key on `[pluginId+id]` so each review is unique
// per plugin without a global id namespace.

import type { PluginReviewRow } from "./plugin-types"
import { getDb } from "./schema"

export async function listReviewsForPlugin(pluginId: string): Promise<PluginReviewRow[]> {
  return getDb()
    .pluginReviews.where("pluginId")
    .equals(pluginId)
    .reverse() // newest first by Dexie's natural insertion order
    .toArray()
}

export async function getReview(
  pluginId: string,
  id: string
): Promise<PluginReviewRow | undefined> {
  return getDb().pluginReviews.get([pluginId, id])
}

export async function upsertReview(review: PluginReviewRow): Promise<void> {
  await getDb().pluginReviews.put(review)
}

export async function deleteReview(pluginId: string, id: string): Promise<void> {
  await getDb().pluginReviews.delete([pluginId, id])
}

/** Drop every cached review for the plugin. Called on uninstall. */
export async function clearReviewsForPlugin(pluginId: string): Promise<number> {
  const rows = await listReviewsForPlugin(pluginId)
  await Promise.all(rows.map((r) => deleteReview(r.pluginId, r.id)))
  return rows.length
}

/**
 * Average rating across all cached reviews — used by the marketplace card to
 * surface "★ 4.7 (12 reviews)". Returns `null` when no reviews are present
 * so the UI can render "no reviews yet" instead of "0".
 */
export async function averageRatingForPlugin(
  pluginId: string
): Promise<{ average: number; count: number } | null> {
  const rows = await listReviewsForPlugin(pluginId)
  if (rows.length === 0) return null
  const sum = rows.reduce((acc, r) => acc + r.rating, 0)
  return { average: sum / rows.length, count: rows.length }
}
