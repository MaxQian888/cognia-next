"use client"

/**
 * Read + mutate the `/discover` category layout. Mirrors
 * `components/shell/use-sidebar-layout.ts` exactly — same `{ pinned, hidden }`
 * model, same persistence path (`useSettingsStore.save({ discoverLayout })`),
 * same pin / unpin / hide / show / reorder / reset transforms — but over the
 * discover category registry instead of the nav rail catalog.
 *
 * `overflow` is derived (catalog − pinned − hidden) so a future category
 * auto-lands as visible-but-unpinned without a layout edit.
 */

import { useCallback, useMemo } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_DISCOVER_LAYOUT,
  DISCOVER_CATEGORIES,
  firstVisibleCategory,
  resolveDiscoverLayout,
  type DiscoverCategory,
  type DiscoverCategoryId,
} from "@/lib/discover/categories"
import type { PartitionedCatalog } from "@/lib/shell/layout-partition"
import type { SidebarLayout } from "@/types/shell/sidebar"

const CATEGORY_IDS: ReadonlySet<string> = new Set(DISCOVER_CATEGORIES.map((c) => c.id))

export interface UseDiscoverLayout {
  layout: SidebarLayout
  resolved: PartitionedCatalog<DiscoverCategory>
  /** First visible category — the default landing when `?category=` is absent. */
  defaultCategory: DiscoverCategoryId
  /** Add `id` to the end of the pinned list (and unhide it). */
  pin: (id: string) => Promise<void>
  /** Remove `id` from pinned → it falls back to overflow ("More"). */
  unpin: (id: string) => Promise<void>
  /** Hide `id` (also unpins it). */
  hide: (id: string) => Promise<void>
  /** Unhide `id` → it surfaces in overflow. */
  show: (id: string) => Promise<void>
  /** Replace the pinned order with `ids` (filtered to known category ids). */
  reorderPinned: (ids: string[]) => Promise<void>
  /** Reset to the factory default (nothing pinned, nothing hidden). */
  reset: () => Promise<void>
}

export function useDiscoverLayout(): UseDiscoverLayout {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  // Key on `settings.discoverLayout` (not the whole `settings` object) so an
  // unrelated settings write (theme, fonts, …) doesn't rebuild the callbacks.
  const discoverLayout = settings?.discoverLayout
  const layout = useMemo<SidebarLayout>(
    () => ({
      pinned: discoverLayout?.pinned ?? DEFAULT_DISCOVER_LAYOUT.pinned,
      hidden: discoverLayout?.hidden ?? DEFAULT_DISCOVER_LAYOUT.hidden,
    }),
    [discoverLayout]
  )

  const resolved = useMemo(() => resolveDiscoverLayout(layout), [layout])
  const defaultCategory = useMemo(() => firstVisibleCategory(layout), [layout])

  const commit = useCallback((next: SidebarLayout) => save({ discoverLayout: next }), [save])

  const pin = useCallback(
    (id: string) =>
      commit({
        pinned: layout.pinned.includes(id) ? layout.pinned : [...layout.pinned, id],
        hidden: layout.hidden.filter((h) => h !== id),
      }),
    [commit, layout]
  )

  const unpin = useCallback(
    (id: string) => commit({ ...layout, pinned: layout.pinned.filter((p) => p !== id) }),
    [commit, layout]
  )

  const hide = useCallback(
    (id: string) =>
      commit({
        pinned: layout.pinned.filter((p) => p !== id),
        hidden: layout.hidden.includes(id) ? layout.hidden : [...layout.hidden, id],
      }),
    [commit, layout]
  )

  const show = useCallback(
    (id: string) => commit({ ...layout, hidden: layout.hidden.filter((h) => h !== id) }),
    [commit, layout]
  )

  const reorderPinned = useCallback(
    (ids: string[]) => commit({ ...layout, pinned: ids.filter((id) => CATEGORY_IDS.has(id)) }),
    [commit, layout]
  )

  const reset = useCallback(() => commit({ ...DEFAULT_DISCOVER_LAYOUT }), [commit])

  return { layout, resolved, defaultCategory, pin, unpin, hide, show, reorderPinned, reset }
}
