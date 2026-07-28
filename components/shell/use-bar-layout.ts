"use client"

/**
 * Read + mutate one desktop window bar's customization (title bar or status
 * bar). The layout lives on `settings.titleBarLayout` / `settings.statusBarLayout`
 * and is written via `useSettingsStore.save()` — the same persistence path as
 * `useSidebarLayout` and `useMobileTabLayout`, so there is no new layer and no
 * Dexie migration.
 *
 * The hook owns the layout transforms (reorder / hide / show / reset) and
 * resolves the stored layout against the platform catalog, so the bar renders
 * `resolved.zones[zone]` and the customizer renders `resolved.visible` /
 * `.hidden`.
 *
 * ## Legacy migration
 *
 * Before the bars became orderable, visibility lived in the UI store's
 * `barItems` boolean map (localStorage, key `cognia-ui`). When settings hold no
 * layout for this bar yet, that map is folded in once — so an install that had
 * turned the perf monitor on or the workspace chip off keeps that choice. The
 * fold is read-only and pure (`migrateLegacyBarItems`); the first write through
 * this hook persists the result to settings and the legacy map stops mattering.
 */

import { useCallback, useMemo } from "react"

import { usePlatform } from "@/hooks/use-platform"
import {
  getBarCatalog,
  isDefaultBarLayout,
  migrateLegacyBarItems,
  resolveBarLayout,
  type BarCatalogItem,
  type ResolvedBar,
} from "@/lib/shell/bar-items"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useUIStore } from "@/stores/ui/ui-store"
import { defaultBarLayout, type BarId, type BarLayout } from "@/types/shell/bars"

export interface UseBarLayout {
  catalog: BarCatalogItem[]
  layout: BarLayout
  resolved: ResolvedBar
  /** True when the effective layout equals the shipped default. */
  isDefault: boolean
  /** Replace the full order with `ids` (filtered to catalog ids). */
  reorder: (ids: string[]) => Promise<void>
  /** Remove `id` from the bar, keeping its slot in the order. */
  hide: (id: string) => Promise<void>
  /** Put `id` back into the bar at the slot it already holds. */
  show: (id: string) => Promise<void>
  /** Reset this bar to the factory default layout. */
  reset: () => Promise<void>
}

/** Settings key that stores each bar's layout. */
const SETTINGS_KEY = { title: "titleBarLayout", status: "statusBarLayout" } as const

export function useBarLayout(bar: BarId): UseBarLayout {
  const platform = usePlatform()
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  // Legacy visibility map — only read when settings hold no layout yet.
  const legacyBarItems = useUIStore((s) => s.barItems)

  const catalog = useMemo(() => getBarCatalog(bar, platform), [bar, platform])
  const validIds = useMemo(() => new Set(catalog.map((c) => c.id)), [catalog])

  // Key on the single settings field rather than the whole `settings` object:
  // every settings write swaps in a fresh `settings` reference, and recomputing
  // here would re-create all callbacks and re-render the always-mounted bars on
  // unrelated changes (theme, fonts, pinned workflows, …).
  const stored = settings?.[SETTINGS_KEY[bar]]
  const layout = useMemo<BarLayout>(() => {
    if (stored) {
      const fallback = defaultBarLayout(bar)
      return { order: stored.order ?? fallback.order, hidden: stored.hidden ?? fallback.hidden }
    }
    return migrateLegacyBarItems(bar, legacyBarItems) ?? defaultBarLayout(bar)
  }, [bar, stored, legacyBarItems])

  const resolved = useMemo(() => resolveBarLayout(catalog, layout), [catalog, layout])
  const isDefault = useMemo(
    () => isDefaultBarLayout(bar, catalog, resolved),
    [bar, catalog, resolved]
  )

  const commit = useCallback((next: BarLayout) => save({ [SETTINGS_KEY[bar]]: next }), [bar, save])

  const reorder = useCallback(
    (nextIds: string[]) => {
      // Only the ids the customizer showed are in `nextIds`; anything the
      // platform filter dropped (a desktop-only segment on web) must keep its
      // stored slot, otherwise switching shells would silently reset it.
      const reordered = nextIds.filter((id) => validIds.has(id))
      const untouched = layout.order.filter((id) => !validIds.has(id))
      return commit({ ...layout, order: [...reordered, ...untouched] })
    },
    [commit, layout, validIds]
  )

  const hide = useCallback(
    (id: string) =>
      commit({
        // A hidden id keeps its position, so unhiding restores it in place.
        order: layout.order.includes(id) ? layout.order : [...layout.order, id],
        hidden: layout.hidden.includes(id) ? layout.hidden : [...layout.hidden, id],
      }),
    [commit, layout]
  )

  const show = useCallback(
    (id: string) => commit({ ...layout, hidden: layout.hidden.filter((h) => h !== id) }),
    [commit, layout]
  )

  const reset = useCallback(() => commit(defaultBarLayout(bar)), [bar, commit])

  return { catalog, layout, resolved, isDefault, reorder, hide, show, reset }
}
