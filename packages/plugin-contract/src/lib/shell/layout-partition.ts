/**
 * Generic partitions for catalog-style customizable layouts (desktop nav rail,
 * discover categories, window bars, …).
 *
 * Two shapes live here, because the surfaces genuinely differ:
 *
 *  - {@link partitionByLayout} — pinned / overflow / hidden, for surfaces with
 *    a third home (the rail's "More" popover, the discover overflow row).
 *    `lib/shell/sidebar-nav.ts:resolveSidebarLayout` and
 *    `lib/discover/categories.ts:resolveDiscoverLayout` are thin wrappers.
 *  - {@link resolveOrderedLayout} — one full order plus a hidden set, for
 *    surfaces where an item is either in the surface or not (the window bars,
 *    via `lib/shell/bar-items.ts:resolveBarLayout`).
 *
 * Pure (no React / lucide) so persistence layers and React-free registries can
 * import them. The dedup / unknown-id-drop / new-catalog-item rules live here
 * once rather than in each caller.
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

/** A user layout for an ordered surface: a full id order plus a hidden set. */
export interface OrderedLayout {
  /** Every id the user has an opinion about, in render order. */
  order: string[]
  /** Ids removed from the surface. Still carry a position in `order`. */
  hidden: string[]
}

/** Resolution of a catalog against an {@link OrderedLayout}. */
export interface ResolvedOrderedCatalog<T> {
  /** Full catalog in effective order — visible and hidden interleaved. */
  order: T[]
  /** `order` minus the hidden ids. */
  visible: T[]
  /** The hidden ids, in `order` order. */
  hidden: T[]
}

/**
 * Resolve `catalog` against `layout`:
 *
 *  - **order**: `layout.order` (known ids, deduped) followed by any catalog
 *    item the stored order never mentioned, in catalog order — so a catalog
 *    addition surfaces without a layout edit or a migration.
 *  - **hidden**: the ids in `layout.hidden` that exist, in effective order.
 *  - **visible**: everything else, in effective order.
 *
 * Hidden items keep their slot in `order` so unhiding one puts it back where
 * the user left it rather than at the end.
 */
export function resolveOrderedLayout<T extends { id: string }>(
  catalog: T[],
  layout: OrderedLayout
): ResolvedOrderedCatalog<T> {
  const byId = new Map(catalog.map((item) => [item.id, item]))

  const seen = new Set<string>()
  const order: T[] = []
  for (const id of layout.order) {
    if (seen.has(id)) continue
    const item = byId.get(id)
    if (!item) continue
    seen.add(id)
    order.push(item)
  }
  for (const item of catalog) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    order.push(item)
  }

  const hiddenIds = new Set(layout.hidden.filter((id) => byId.has(id)))
  const visible: T[] = []
  const hidden: T[] = []
  for (const item of order) {
    if (hiddenIds.has(item.id)) hidden.push(item)
    else visible.push(item)
  }

  return { order, visible, hidden }
}
