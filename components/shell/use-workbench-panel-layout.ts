"use client"

/**
 * Read + mutate the Context Workbench's *panel tab* customization — one level
 * below `use-workbench-rail-layout.ts`, which owns the activity rail. The layout
 * lives on `settings.workbenchPanels` and is written via
 * `useSettingsStore.save()`, the same persistence path as every other shell
 * layout, so there is no new layer and no Dexie migration.
 *
 * **One layout for every host and both dock surfaces.** The chat dock shows a
 * different panel set with an artifact in front than without, and Canvas and the
 * editors show their own — but "I never want to see Memory" is one preference,
 * not one per surface, and a user editing it has no idea which surface they are
 * notionally editing. A host simply renders the ones its own panels declare.
 *
 * Hiding a panel takes away its *tab*, never the panel: it stays in the
 * workbench's resolved set, so the command palette, `Ctrl+Shift+E` and
 * `Ctrl+1..7` still reach it. See `isWorkbenchPanelHidden`.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react"

import {
  getWorkbenchPanelCatalog,
  isDefaultWorkbenchPanelLayout,
  resolveWorkbenchPanelLayout,
  workbenchPanelLayoutOf,
  type ResolvedWorkbenchPanels,
  type WorkbenchPanelCatalogItem,
} from "@/lib/shell/workbench-panels"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_WORKBENCH_PANEL_LAYOUT,
  type WorkbenchPanelLayout,
} from "@/types/shell/workbench-panels"

export interface UseWorkbenchPanelLayout {
  catalog: WorkbenchPanelCatalogItem[]
  layout: WorkbenchPanelLayout
  resolved: ResolvedWorkbenchPanels
  /** True when the effective layout equals the shipped default. */
  isDefault: boolean
  /** Replace the full order with `ids` (filtered to catalog ids). */
  reorder: (ids: string[]) => Promise<void>
  /** Remove `id`'s tab, keeping its slot in the order. */
  hide: (id: string) => Promise<void>
  /** Put `id`'s tab back at the slot it already holds. */
  show: (id: string) => Promise<void>
  /** Reset to the factory default layout. */
  reset: () => Promise<void>
}

export function useWorkbenchPanelLayout(): UseWorkbenchPanelLayout {
  const save = useSettingsStore((s) => s.save)
  // The single settings field, not the whole `settings` object: every settings
  // write swaps in a fresh reference, and this hook feeds a component mounted in
  // four hosts.
  const stored = useSettingsStore((s) => s.settings?.workbenchPanels)

  // Re-evaluate when a plugin registers or removes a panel, so the customizer
  // gains and loses third-party entries without a remount.
  const registryRevision = useSyncExternalStore(
    contextPanelRegistry.subscribe,
    contextPanelRegistry.getRevision,
    contextPanelRegistry.getRevision
  )
  const catalog = useMemo(
    () => getWorkbenchPanelCatalog(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registryRevision drives recalc
    [registryRevision]
  )
  const validIds = useMemo(() => new Set(catalog.map((item) => item.id)), [catalog])

  const layout = useMemo(() => workbenchPanelLayoutOf(stored), [stored])
  const resolved = useMemo(() => resolveWorkbenchPanelLayout(catalog, layout), [catalog, layout])
  const isDefault = useMemo(() => isDefaultWorkbenchPanelLayout(layout), [layout])

  const commit = useCallback(
    (next: WorkbenchPanelLayout) => save({ workbenchPanels: next }),
    [save]
  )

  const reorder = useCallback(
    (nextIds: string[]) => {
      // Only the ids the customizer showed arrive here. Anything else — a
      // plugin panel whose extension is disabled this session, an id from a
      // catalog entry retired since — keeps its stored slot, so it is not
      // silently dropped by an unrelated drag.
      const reordered = nextIds.filter((id) => validIds.has(id))
      const untouched = layout.order.filter((id) => !validIds.has(id))
      return commit({ ...layout, order: [...reordered, ...untouched] })
    },
    [commit, layout, validIds]
  )

  const hide = useCallback(
    (id: string) =>
      commit({
        // A hidden id keeps its position, so unhiding restores it in place
        // rather than appending it to the end of the strip.
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

  const reset = useCallback(() => commit(DEFAULT_WORKBENCH_PANEL_LAYOUT), [commit])

  return { catalog, layout, resolved, isDefault, reorder, hide, show, reset }
}
