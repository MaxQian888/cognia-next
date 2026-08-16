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

import { useCallback, useMemo, useSyncExternalStore } from "react"

import {
  getWorkbenchRailCatalogWithPlugins,
  isDefaultWorkbenchRailLayout,
  resolveWorkbenchRailLayout,
  type ResolvedWorkbenchRail,
  type WorkbenchRailCatalogItem,
} from "@/lib/shell/workbench-rail"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
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
  /** True when reading from a project-specific layout rather than the global one. */
  isProjectScoped: boolean
  /** Replace the full order with `ids` (filtered to catalog ids). */
  reorder: (ids: string[]) => Promise<void>
  /** Remove `id` from the rail, keeping its slot in the order. */
  hide: (id: string) => Promise<void>
  /** Put `id` back on the rail at the slot it already holds. */
  show: (id: string) => Promise<void>
  /** Reset to the factory default layout (clears project-specific if scoped). */
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
    // Carried through even though nothing reads it. This is the *read* half of
    // the same trap `hide` had on the write half: every mutator derives its
    // patch from this object, so dropping `groups` here would delete a stored
    // group on the next pin, hide or reorder no matter how carefully the
    // mutators spread. Dormant has to mean "not used yet", not "quietly erased".
    groups: stored.groups ?? DEFAULT_WORKBENCH_RAIL_LAYOUT.groups,
  }
}

/**
 * Whether the activity rail stays on screen when the panel body is closed.
 *
 * A one-field selector rather than part of {@link useWorkbenchRailLayout},
 * because the hosts that need it (the chat dock's `ResizablePanel`, Canvas, the
 * workflow editor) only want this boolean and must not re-render on every
 * reorder of the rail.
 *
 * Defaults to off: with the panel closed, a persistent rail is a second
 * icon column beside the left navigation rail, and the two of them boxed the
 * conversation in on every idle screen. The panels stay discoverable through
 * the header dock toggle, ⌘/Ctrl+J and the title-bar layout controls; users
 * who want the minibar back opt in from the workbench customizer.
 */
export const DEFAULT_WORKBENCH_RAIL_PERSISTENT = false

export function useWorkbenchRailPersistent(): boolean {
  return useSettingsStore(
    (s) => s.settings?.workbenchRailPersistent ?? DEFAULT_WORKBENCH_RAIL_PERSISTENT
  )
}

/**
 * @param projectId Resolve against `settings.workbenchRailPerProject[projectId]`
 *   before the global layout.
 *
 *   **Intentionally dormant.** No caller passes it — `WorkbenchCustomizer` is
 *   the only consumer and it edits the global layout — so `isProjectScoped` is
 *   permanently `false` and the per-project branch of `commit`/`reset` is
 *   unreachable in the running app. The parameter and the settings key are kept
 *   because the resolution order (project → global → default) is the part that
 *   is hard to retrofit, and because `AppSettings.workbenchRailPerProject` is
 *   already in the settings contract and the section-reset registry.
 *
 *   Per Working Rule 7 this is stated in the UI as well — the customizer draws a
 *   disabled "planned" row — and pinned by the test beside this file.
 */
export function useWorkbenchRailLayout(projectId?: string | null): UseWorkbenchRailLayout {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  // Subscribe to plugin registry changes so new/removed plugin activities
  // cause the catalog (and therefore the customizer) to re-evaluate.
  const registryRevision = useSyncExternalStore(
    contextPanelRegistry.subscribe,
    contextPanelRegistry.getRevision,
    contextPanelRegistry.getRevision
  )

  const catalog = useMemo(
    () => getWorkbenchRailCatalogWithPlugins(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registryRevision drives recalc
    [registryRevision]
  )
  const validIds = useMemo(() => new Set(catalog.map((c) => c.id)), [catalog])

  // Resolve: project-specific → global → default.
  const globalStored = settings?.workbenchRail
  const projectStored = projectId ? settings?.workbenchRailPerProject?.[projectId] : undefined
  const isProjectScoped = Boolean(projectStored)
  const stored = projectStored ?? globalStored
  const layout = useMemo(() => workbenchRailLayoutOf(stored), [stored])

  const resolved = useMemo(() => resolveWorkbenchRailLayout(catalog, layout), [catalog, layout])
  const isDefault = useMemo(() => isDefaultWorkbenchRailLayout(layout), [layout])

  const commit = useCallback(
    (next: WorkbenchRailLayout) => {
      if (projectId && isProjectScoped) {
        // Write to the project-specific slot
        const perProject = { ...(settings?.workbenchRailPerProject ?? {}), [projectId]: next }
        return save({ workbenchRailPerProject: perProject })
      }
      return save({ workbenchRail: next })
    },
    [save, projectId, isProjectScoped, settings?.workbenchRailPerProject]
  )

  const reorder = useCallback(
    (nextIds: string[]) => {
      const reordered = nextIds.filter((id) => validIds.has(id))
      const untouched = layout.order.filter((id) => !validIds.has(id))
      return commit({ ...layout, order: [...reordered, ...untouched] })
    },
    [commit, layout, validIds]
  )

  const hide = useCallback(
    (id: string) =>
      commit({
        // Spread, don't rebuild. `WorkbenchRailLayout` carries a third field —
        // `groups` — and constructing a fresh object dropped it on every hide
        // while `show` below spread it and kept it. The asymmetry is harmless
        // only while `groups` is always empty; the moment it is not, hiding one
        // activity would silently delete every user-defined panel group. This
        // is the same trap `types/shell/sidebar.ts` documents for `sidebarSide`.
        ...layout,
        order: layout.order.includes(id) ? layout.order : [...layout.order, id],
        hidden: layout.hidden.includes(id) ? layout.hidden : [...layout.hidden, id],
      }),
    [commit, layout]
  )

  const show = useCallback(
    (id: string) => commit({ ...layout, hidden: layout.hidden.filter((h) => h !== id) }),
    [commit, layout]
  )

  const reset = useCallback(() => {
    if (projectId && isProjectScoped) {
      // Remove the project-specific override entirely, falling back to global
      const perProject = { ...(settings?.workbenchRailPerProject ?? {}) }
      delete perProject[projectId]
      return save({ workbenchRailPerProject: perProject })
    }
    return commit(DEFAULT_WORKBENCH_RAIL_LAYOUT)
  }, [commit, projectId, isProjectScoped, settings?.workbenchRailPerProject, save])

  return { catalog, layout, resolved, isDefault, isProjectScoped, reorder, hide, show, reset }
}
