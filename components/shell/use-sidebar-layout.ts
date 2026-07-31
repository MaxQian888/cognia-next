"use client"

/**
 * Read + mutate the desktop navigation rail (`GuildRail`) customization. The layout
 * lives on `settings.sidebarLayout` and is written via `useSettingsStore.save()`
 * — the same persistence path as `usePinnedMeRows`
 * (`components/mobile/me/use-pinned-me-rows.ts`), so there is no new layer.
 *
 * The hook owns the small set of layout transforms (pin / unpin / hide / show /
 * reorder / reset) and resolves the stored layout against the platform catalog
 * so consumers (the rail + the customizer) just render `resolved.pinned` /
 * `.overflow` / `.hidden`. "Move to More" is just `unpin` (an unpinned,
 * unhidden item surfaces in overflow).
 */

import { useCallback, useMemo } from "react"

import { usePlatform } from "@/hooks/use-platform"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  getSidebarCatalog,
  resolveSidebarLayout,
  type ResolvedSidebar,
  type SidebarCatalogItem,
} from "@/lib/shell/sidebar-nav"
import {
  DEFAULT_SIDEBAR_LAYOUT,
  DEFAULT_SIDEBAR_SIDE,
  type SidebarLayout,
  type SidebarSide,
} from "@/types/shell/sidebar"

export interface UseSidebarLayout {
  catalog: SidebarCatalogItem[]
  layout: SidebarLayout
  resolved: ResolvedSidebar
  /** Which window edge the rail occupies. */
  side: SidebarSide
  /**
   * Move the rail to `next`. Written on its own — never folded into `commit`,
   * because the layout mutators below rebuild their object and would drop it.
   */
  setSide: (next: SidebarSide) => Promise<void>
  /** Add `id` to the end of the pinned list (and unhide it). */
  pin: (id: string) => Promise<void>
  /** Remove `id` from pinned → it falls back to "More". */
  unpin: (id: string) => Promise<void>
  /** Hide `id` everywhere (also unpins it). */
  hide: (id: string) => Promise<void>
  /** Unhide `id` → it surfaces in "More". */
  show: (id: string) => Promise<void>
  /** Replace the pinned order with `ids` (filtered to catalog ids). */
  reorderPinned: (ids: string[]) => Promise<void>
  /** Reset to the factory default layout. */
  reset: () => Promise<void>
}

export function useSidebarLayout(): UseSidebarLayout {
  const platform = usePlatform()
  const runtimeSnapshot = useRuntimeSnapshot()
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const catalog = useMemo(
    () => getSidebarCatalog(platform, runtimeSnapshot),
    [platform, runtimeSnapshot]
  )
  const validIds = useMemo(() => new Set(catalog.map((c) => c.id)), [catalog])

  // Key on `settings.sidebarLayout` (not the whole `settings` object): every
  // settings write swaps in a fresh `settings` reference, and recomputing here
  // would re-create all callbacks and re-render the always-mounted GuildRail on
  // unrelated changes (theme, fonts, pinned workflows, …).
  const sidebarLayout = settings?.sidebarLayout
  const layout = useMemo<SidebarLayout>(
    () => ({
      pinned: sidebarLayout?.pinned ?? DEFAULT_SIDEBAR_LAYOUT.pinned,
      hidden: sidebarLayout?.hidden ?? DEFAULT_SIDEBAR_LAYOUT.hidden,
    }),
    [sidebarLayout]
  )

  const resolved = useMemo(() => resolveSidebarLayout(catalog, layout), [catalog, layout])

  // Read from its own settings key, not from `sidebarLayout`. Keeping the two
  // apart is what stops `pin`/`hide` (which rebuild the layout object) from
  // silently discarding the side, and what stops `reset` from moving the rail.
  const side = settings?.sidebarSide ?? DEFAULT_SIDEBAR_SIDE
  const setSide = useCallback((next: SidebarSide) => save({ sidebarSide: next }), [save])

  const commit = useCallback((next: SidebarLayout) => save({ sidebarLayout: next }), [save])

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
    (ids: string[]) => commit({ ...layout, pinned: ids.filter((id) => validIds.has(id)) }),
    [commit, layout, validIds]
  )

  const reset = useCallback(() => commit({ ...DEFAULT_SIDEBAR_LAYOUT }), [commit])

  return {
    catalog,
    layout,
    resolved,
    side,
    setSide,
    pin,
    unpin,
    hide,
    show,
    reorderPinned,
    reset,
  }
}
