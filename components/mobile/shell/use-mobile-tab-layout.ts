"use client"

/**
 * Read + mutate the mobile bottom-tab customization. The layout lives on
 * `settings.mobileTabLayout` and is written via `useSettingsStore.save()` — the
 * same persistence path as `useSidebarLayout`, so there is no new layer and no
 * Dexie migration.
 *
 * Owns the tab transforms (reorder / hide / show / set landing / reset) and
 * resolves the stored layout so consumers render `resolved.visible` directly.
 * Hiding is guarded so at least `MIN_VISIBLE_TABS` tabs always remain.
 */

import { useCallback, useMemo } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_MOBILE_TAB_LAYOUT,
  MIN_VISIBLE_TABS,
  MOBILE_TAB_IDS,
  resolveMobileTabLayout,
  type MobileTabId,
  type MobileTabLayout,
  type ResolvedMobileTabs,
} from "@/types/shell/mobile-tabs"

export interface UseMobileTabLayout {
  layout: MobileTabLayout
  resolved: ResolvedMobileTabs
  /** Replace the full order with `ids` (valid ids only). */
  reorder: (ids: MobileTabId[]) => Promise<void>
  /** Hide `id` — no-op if it would drop below the visible floor. */
  hide: (id: MobileTabId) => Promise<void>
  /** Show a hidden tab. */
  show: (id: MobileTabId) => Promise<void>
  /** Set the launch landing tab. */
  setDefaultLanding: (id: MobileTabId) => Promise<void>
  /** Reset to the factory default layout. */
  reset: () => Promise<void>
}

export function useMobileTabLayout(): UseMobileTabLayout {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const stored = settings?.mobileTabLayout
  const layout = useMemo<MobileTabLayout>(
    () => ({
      order: stored?.order ?? DEFAULT_MOBILE_TAB_LAYOUT.order,
      hidden: stored?.hidden ?? DEFAULT_MOBILE_TAB_LAYOUT.hidden,
      defaultLanding: stored?.defaultLanding ?? DEFAULT_MOBILE_TAB_LAYOUT.defaultLanding,
    }),
    [stored]
  )

  const resolved = useMemo(() => resolveMobileTabLayout(layout), [layout])

  const commit = useCallback((next: MobileTabLayout) => save({ mobileTabLayout: next }), [save])

  const valid = useMemo(() => new Set<MobileTabId>(MOBILE_TAB_IDS), [])

  const reorder = useCallback(
    (ids: MobileTabId[]) => commit({ ...layout, order: ids.filter((id) => valid.has(id)) }),
    [commit, layout, valid]
  )

  const hide = useCallback(
    (id: MobileTabId) => {
      // Guard: never hide below the visible floor.
      if (resolved.visible.length <= MIN_VISIBLE_TABS) return Promise.resolve()
      return commit({
        ...layout,
        hidden: layout.hidden.includes(id) ? layout.hidden : [...layout.hidden, id],
      })
    },
    [commit, layout, resolved.visible.length]
  )

  const show = useCallback(
    (id: MobileTabId) => commit({ ...layout, hidden: layout.hidden.filter((h) => h !== id) }),
    [commit, layout]
  )

  const setDefaultLanding = useCallback(
    (id: MobileTabId) => commit({ ...layout, defaultLanding: id }),
    [commit, layout]
  )

  const reset = useCallback(() => commit({ ...DEFAULT_MOBILE_TAB_LAYOUT }), [commit])

  return { layout, resolved, reorder, hide, show, setDefaultLanding, reset }
}
