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
import { useShallow } from "zustand/react/shallow"

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

type SidebarLayoutMutation = (current: SidebarLayout) => SidebarLayout

// `saveSettings` serializes writes, but serializing already-computed patches
// is not enough: two fast clicks could both derive from the same rendered
// layout and the second patch would erase the first. Serialize the derivation
// too, reading the store only when each mutation reaches the front of the
// queue. The recovered tail keeps one rejected save from blocking later edits,
// while the returned task still rejects for the initiating caller.
let sidebarLayoutMutationQueue: Promise<void> | null = null

function enqueueSidebarLayoutMutation(mutate: SidebarLayoutMutation): Promise<void> {
  const run = async () => {
    const state = useSettingsStore.getState()
    const stored = state.settings?.sidebarLayout
    const current: SidebarLayout = {
      pinned: stored?.pinned ?? DEFAULT_SIDEBAR_LAYOUT.pinned,
      hidden: stored?.hidden ?? DEFAULT_SIDEBAR_LAYOUT.hidden,
    }
    await state.save({ sidebarLayout: mutate(current) })
  }
  // Start the first mutation synchronously so event handlers preserve their
  // existing observable behavior; only followers wait for the active save.
  const task = sidebarLayoutMutationQueue ? sidebarLayoutMutationQueue.then(run, run) : run()
  const recovered = task.catch(() => undefined)
  sidebarLayoutMutationQueue = recovered
  void recovered.then(() => {
    if (sidebarLayoutMutationQueue === recovered) sidebarLayoutMutationQueue = null
  })
  return task
}

export function useSidebarLayout(): UseSidebarLayout {
  const platform = usePlatform()
  const runtimeSnapshot = useRuntimeSnapshot()
  const save = useSettingsStore((s) => s.save)

  const catalog = useMemo(
    () => getSidebarCatalog(platform, runtimeSnapshot),
    [platform, runtimeSnapshot]
  )
  const validIds = useMemo(() => new Set(catalog.map((c) => c.id)), [catalog])

  // Subscribe to the two layout arrays independently. `save()` may hydrate a
  // fresh settings tree, so comparing only the `sidebarLayout` object reference
  // would still re-render the always-mounted GuildRail for unrelated writes.
  // `useShallow` compares the string entries and preserves each selected array
  // when its contents are unchanged.
  const pinned = useSettingsStore(
    useShallow((s) => s.settings?.sidebarLayout?.pinned ?? DEFAULT_SIDEBAR_LAYOUT.pinned)
  )
  const hidden = useSettingsStore(
    useShallow((s) => s.settings?.sidebarLayout?.hidden ?? DEFAULT_SIDEBAR_LAYOUT.hidden)
  )
  const layout = useMemo<SidebarLayout>(
    () => ({
      pinned,
      hidden,
    }),
    [hidden, pinned]
  )

  const resolved = useMemo(() => resolveSidebarLayout(catalog, layout), [catalog, layout])

  // Read from its own settings key, not from `sidebarLayout`. Keeping the two
  // apart is what stops `pin`/`hide` (which rebuild the layout object) from
  // silently discarding the side, and what stops `reset` from moving the rail.
  const side = useSettingsStore((s) => s.settings?.sidebarSide ?? DEFAULT_SIDEBAR_SIDE)
  const setSide = useCallback((next: SidebarSide) => save({ sidebarSide: next }), [save])

  const pin = useCallback(
    (id: string) =>
      enqueueSidebarLayoutMutation((current) => ({
        pinned: current.pinned.includes(id) ? current.pinned : [...current.pinned, id],
        hidden: current.hidden.filter((h) => h !== id),
      })),
    []
  )

  const unpin = useCallback(
    (id: string) =>
      enqueueSidebarLayoutMutation((current) => ({
        ...current,
        pinned: current.pinned.filter((p) => p !== id),
      })),
    []
  )

  const hide = useCallback(
    (id: string) =>
      enqueueSidebarLayoutMutation((current) => ({
        pinned: current.pinned.filter((p) => p !== id),
        hidden: current.hidden.includes(id) ? current.hidden : [...current.hidden, id],
      })),
    []
  )

  const show = useCallback(
    (id: string) =>
      enqueueSidebarLayoutMutation((current) => ({
        ...current,
        hidden: current.hidden.filter((h) => h !== id),
      })),
    []
  )

  const reorderPinned = useCallback(
    (ids: string[]) =>
      enqueueSidebarLayoutMutation((current) => ({
        ...current,
        pinned: ids.filter((id) => validIds.has(id)),
      })),
    [validIds]
  )

  const reset = useCallback(
    () => enqueueSidebarLayoutMutation(() => ({ ...DEFAULT_SIDEBAR_LAYOUT })),
    []
  )

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
