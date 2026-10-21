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

export interface PartitionedCatalog<T> {
  pinned: T[]
  overflow: T[]
  hidden: T[]
}

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

export interface OrderedLayout {
  /** Every id the user has an opinion about, in render order. */
  order: string[]
  /** Ids removed from the surface. Still carry a position in `order`. */
  hidden: string[]
}

export interface ResolvedOrderedCatalog<T> {
  /** Full catalog in effective order — visible and hidden interleaved. */
  order: T[]
  /** `order` minus the hidden ids. */
  visible: T[]
  /** The hidden ids, in `order` order. */
  hidden: T[]
}

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
