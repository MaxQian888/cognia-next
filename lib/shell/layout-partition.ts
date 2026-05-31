/**
 * Generic pinned/overflow/hidden partition for catalog-style customizable
 * layouts (desktop nav rail, discover categories, …).
 *
 * Pure (no React / lucide) so persistence layers and React-free registries
 * can import it. Both `lib/shell/sidebar-nav.ts:resolveSidebarLayout` and
 * `lib/discover/categories.ts:resolveDiscoverLayout` are thin wrappers over
 * this — the dedup / unknown-id-drop / three-bucket rules live here once.
 */

/** A user layout: an explicit pinned order plus a hidden set. */
export interface CatalogLayout {
  /** Ordered ids shown directly, in the user's order. */
  pinned: string[]
  /** Ids hidden everywhere (neither pinned nor overflow). */
  hidden: string[]
}

/** Three-way partition of a catalog according to a layout. */
export interface PartitionedCatalog<T> {
  pinned: T[]
  overflow: T[]
  hidden: T[]
}

/**
 * Partition `catalog` according to `layout`:
 *
 *  - **pinned**: `layout.pinned` ids that exist in the catalog, in the user's
 *    stored order. Pinned wins over hidden if an id appears in both. Duplicate
 *    pinned ids are deduped.
 *  - **hidden**: `layout.hidden` ids that exist and are not pinned, in catalog
 *    order.
 *  - **overflow**: everything else (catalog − pinned − hidden), in catalog
 *    order — so newly-added catalog items appear in overflow automatically.
 *
 * Unknown ids in the layout are dropped.
 */
export function partitionByLayout<T extends { id: string }>(
  catalog: T[],
  layout: CatalogLayout
): PartitionedCatalog<T> {
  const byId = new Map(catalog.map((item) => [item.id, item]))

  const seen = new Set<string>()
  const pinned: T[] = []
  for (const id of layout.pinned) {
    if (seen.has(id)) continue
    const item = byId.get(id)
    if (!item) continue
    seen.add(id)
    pinned.push(item)
  }

  const hiddenIds = new Set(layout.hidden.filter((id) => byId.has(id) && !seen.has(id)))

  const hidden: T[] = []
  const overflow: T[] = []
  for (const item of catalog) {
    if (seen.has(item.id)) continue
    if (hiddenIds.has(item.id)) hidden.push(item)
    else overflow.push(item)
  }

  return { pinned, overflow, hidden }
}
