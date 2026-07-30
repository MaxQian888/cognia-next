"use client"

/**
 * Read + mutate the Context Workbench activity rail's customization. The layout
 * lives on `settings.workbenchRail` and is written via `useSettingsStore.save()`
 * — the same persistence path as `useSidebarLayout` and `useBarLayout`, so
 * there is no new layer and no Dexie migration.
 *
 * **One layout for every host.** The chat dock, Canvas' side panels, the
 * workflow editor and the project editor all render from the same activity
 * vocabulary and each shows only the activities its own panels declare, so a
 * single stored order serves all four: a host without `workspace` simply skips
 * it. Per-host layouts would have needed four customizer entry points and left
 * the user guessing which one they were editing.
 */

import { useCallback, useMemo } from "react"

import {
  getWorkbenchRailCatalog,
  isDefaultWorkbenchRailLayout,
  resolveWorkbenchRailLayout,
  type ResolvedWorkbenchRail,
  type WorkbenchRailCatalogItem,
} from "@/lib/shell/workbench-rail"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_WORKBENCH_RAIL_LAYOUT,
  type WorkbenchRailLayout,
} from "@/types/shell/workbench-rail"

export interface UseWorkbenchRailLayout {
  catalog: WorkbenchRailCatalogItem[]
  layout: WorkbenchRailLayout
  resolved: ResolvedWorkbenchRail
  /** True when the effective layout equals the shipped default. */
  isDefault: boolean
  /** Replace the full order with `ids` (filtered to catalog ids). */
  reorder: (ids: string[]) => Promise<void>
  /** Remove `id` from the rail, keeping its slot in the order. */
  hide: (id: string) => Promise<void>
  /** Put `id` back on the rail at the slot it already holds. */
  show: (id: string) => Promise<void>
  /** Reset to the factory default layout. */
  reset: () => Promise<void>
}

/**
 * Read the stored layout without subscribing to React — for the workbench's own
 * sort, which needs it inside a `useMemo` keyed on the settings field.
 */
export function workbenchRailLayoutOf(
  stored: Partial<WorkbenchRailLayout> | undefined
): WorkbenchRailLayout {
  if (!stored) return DEFAULT_WORKBENCH_RAIL_LAYOUT
  return {
    order: stored.order ?? DEFAULT_WORKBENCH_RAIL_LAYOUT.order,
    hidden: stored.hidden ?? DEFAULT_WORKBENCH_RAIL_LAYOUT.hidden,
  }
}

/**
 * Whether the activity rail stays on screen when the panel body is closed.
 *
 * A one-field selector rather than part of {@link useWorkbenchRailLayout},
 * because the hosts that need it (the chat dock's `ResizablePanel`, Canvas, the
 * workflow editor) only want this boolean and must not re-render on every
 * reorder of the rail. Defaults to on: the rail is what makes the right-hand
 * panels discoverable at all, and the pre-minibar behaviour — a column that
 * vanishes completely — is the opt-out.
 */
export function useWorkbenchRailPersistent(): boolean {
  return useSettingsStore((s) => s.settings?.workbenchRailPersistent ?? true)
}

export function useWorkbenchRailLayout(): UseWorkbenchRailLayout {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const catalog = useMemo(() => getWorkbenchRailCatalog(), [])
  const validIds = useMemo(() => new Set(catalog.map((c) => c.id)), [catalog])

  // Key on the single settings field rather than the whole `settings` object:
  // every settings write swaps in a fresh `settings` reference, and recomputing
  // here would re-create all callbacks and re-render the workbench on unrelated
  // changes (theme, fonts, pinned workflows, …).
  const stored = settings?.workbenchRail
  const layout = useMemo(() => workbenchRailLayoutOf(stored), [stored])

  const resolved = useMemo(() => resolveWorkbenchRailLayout(catalog, layout), [catalog, layout])
  const isDefault = useMemo(() => isDefaultWorkbenchRailLayout(layout), [layout])

  const commit = useCallback((next: WorkbenchRailLayout) => save({ workbenchRail: next }), [save])

  const reorder = useCallback(
    (nextIds: string[]) => {
      // Only ids the customizer showed are in `nextIds`; a plugin activity that
      // is on the live rail but not in the canonical catalog must keep its
      // stored slot rather than being dropped by the filter.
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

  const reset = useCallback(() => commit(DEFAULT_WORKBENCH_RAIL_LAYOUT), [commit])

  return { catalog, layout, resolved, isDefault, reorder, hide, show, reset }
}
