"use client"

/**
 * Read + mutate the mobile home (chat welcome) customization. The layout lives
 * on `settings.mobileHomeLayout` and is written via `useSettingsStore.save()` —
 * the same persistence path as `useSidebarLayout`
 * (`components/shell/use-sidebar-layout.ts`) and `usePinnedMeRows`, so there is
 * no new layer and no Dexie migration.
 *
 * The hook owns the quick-action transforms (add / remove / reorder / reset)
 * and the section visibility toggles, and resolves the stored layout against
 * the catalog so consumers just render `resolved.active` / `.available`.
 */

import { useCallback, useMemo } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  getMobileQuickActionCatalog,
  resolveMobileHomeLayout,
  type MobileQuickActionItem,
  type ResolvedMobileQuickActions,
} from "@/lib/shell/mobile-home-nav"
import {
  DEFAULT_MOBILE_HOME_LAYOUT,
  type MobileHomeLayout,
  type MobileHomeSectionId,
} from "@/types/shell/mobile-home"

export interface UseMobileHomeLayout {
  catalog: MobileQuickActionItem[]
  layout: MobileHomeLayout
  resolved: ResolvedMobileQuickActions
  /** Append `id` to the shown grid (no-op if already shown). */
  addAction: (id: string) => Promise<void>
  /** Remove `id` from the grid → it falls back to "available". */
  removeAction: (id: string) => Promise<void>
  /** Replace the grid order with `ids` (filtered to catalog ids). */
  reorderActions: (ids: string[]) => Promise<void>
  /** Hide a whole home section. */
  hideSection: (id: MobileHomeSectionId) => Promise<void>
  /** Show a previously hidden section. */
  showSection: (id: MobileHomeSectionId) => Promise<void>
  /** Whether `id` is currently hidden. */
  isSectionHidden: (id: MobileHomeSectionId) => boolean
  /** Reset to the factory default layout. */
  reset: () => Promise<void>
}

export function useMobileHomeLayout(): UseMobileHomeLayout {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const catalog = useMemo(() => getMobileQuickActionCatalog(), [])
  const validIds = useMemo(() => new Set(catalog.map((c) => c.id)), [catalog])

  // Key on `settings.mobileHomeLayout` (not the whole `settings` object): every
  // settings write swaps in a fresh `settings` reference, and recomputing on
  // unrelated changes (theme, fonts, …) would re-create all callbacks and
  // re-render the always-mounted home grid.
  const stored = settings?.mobileHomeLayout
  const layout = useMemo<MobileHomeLayout>(
    () => ({
      quickActions: stored?.quickActions ?? DEFAULT_MOBILE_HOME_LAYOUT.quickActions,
      hiddenSections: stored?.hiddenSections ?? DEFAULT_MOBILE_HOME_LAYOUT.hiddenSections,
    }),
    [stored]
  )

  const resolved = useMemo(() => resolveMobileHomeLayout(catalog, layout), [catalog, layout])

  const commit = useCallback((next: MobileHomeLayout) => save({ mobileHomeLayout: next }), [save])

  const addAction = useCallback(
    (id: string) =>
      commit({
        ...layout,
        quickActions:
          layout.quickActions.includes(id) || !validIds.has(id)
            ? layout.quickActions
            : [...layout.quickActions, id],
      }),
    [commit, layout, validIds]
  )

  const removeAction = useCallback(
    (id: string) =>
      commit({ ...layout, quickActions: layout.quickActions.filter((a) => a !== id) }),
    [commit, layout]
  )

  const reorderActions = useCallback(
    (ids: string[]) =>
      commit({ ...layout, quickActions: ids.filter((id) => validIds.has(id)) }),
    [commit, layout, validIds]
  )

  const hideSection = useCallback(
    (id: MobileHomeSectionId) =>
      commit({
        ...layout,
        hiddenSections: layout.hiddenSections.includes(id)
          ? layout.hiddenSections
          : [...layout.hiddenSections, id],
      }),
    [commit, layout]
  )

  const showSection = useCallback(
    (id: MobileHomeSectionId) =>
      commit({ ...layout, hiddenSections: layout.hiddenSections.filter((s) => s !== id) }),
    [commit, layout]
  )

  const isSectionHidden = useCallback(
    (id: MobileHomeSectionId) => layout.hiddenSections.includes(id),
    [layout]
  )

  const reset = useCallback(() => commit({ ...DEFAULT_MOBILE_HOME_LAYOUT }), [commit])

  return {
    catalog,
    layout,
    resolved,
    addAction,
    removeAction,
    reorderActions,
    hideSection,
    showSection,
    isSectionHidden,
    reset,
  }
}
