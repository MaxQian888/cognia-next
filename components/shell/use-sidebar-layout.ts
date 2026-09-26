"use client"

/**
 * Read + mutate the desktop navigation rail (`GuildRail`) customization. The layout
 * lives on `settings.sidebarLayout` and is written via `useSettingsStore.save()`
 * — the same persistence path as `usePinnedMeRows`
 * (`components/mobile/me/use-pinned-me-rows.ts`), so there is no new layer.
 *
 * The hook owns the small set of layout transforms (pin / unpin / hide / show /
 * reorder / move / reset) and resolves the stored layout against the platform
 * catalog so consumers (the rail + the customizer) just render
 * `resolved.pinned` / `.overflow` / `.hidden`. "Move to More" is just `unpin`
 * (an unpinned, unhidden item surfaces in overflow).
 *
 * The workspace modes (Canvas, plugin view containers) are the layout's second,
 * ordered block (`SidebarLayout.modes`). The hook exposes their mutators but
 * not their resolution: which plugin containers exist is a registry fact
 * `useShellNav` already subscribes to, so it resolves them there.
 *
 * The mutations are also exported as plain functions (`pinSidebarItem`, …) for
 * callers outside React — the ⌘K command handler runs after its dialog has
 * closed, with no component left to own a hook.
 */

import { useCallback, useMemo } from "react"
import { useShallow } from "zustand/react/shallow"

import { usePlatform } from "@/hooks/use-platform"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  getSidebarCatalog,
  migrateLegacyIds,
  resolveSidebarLayout,
  type ResolvedSidebar,
  type SidebarCatalogItem,
} from "@/lib/shell/sidebar-nav"
import { moveTeamInOrder } from "@/lib/shell/team-order"
import {
  DEFAULT_SIDEBAR_LAYOUT,
  DEFAULT_SIDEBAR_SIDE,
  SIDEBAR_NAV_META,
  type SidebarLayout,
  type SidebarModesLayout,
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
  /**
   * Replace the visible pinned order with `ids` (filtered to the current
   * catalog). Stored pins the current catalog cannot show — a host-backed page
   * while the paired desktop is offline — are kept after the reordered ones
   * rather than dropped.
   */
  reorderPinned: (ids: string[]) => Promise<void>
  /**
   * Move pinned `id` one slot toward the start (`-1`) or the end (`1`) of the
   * visible pinned order — the keyboard path for the drag. No-op at either end.
   */
  movePinned: (id: string, delta: number) => Promise<void>
  /** The stored workspace-mode layout, or `undefined` for the shipped default. */
  modes: SidebarModesLayout | undefined
  /** Take a workspace mode (Canvas, a plugin view container) off the rail. */
  hideMode: (id: string) => Promise<void>
  /** Put a hidden workspace mode back in its old slot. */
  showMode: (id: string) => Promise<void>
  /**
   * Persist the full mode order as rendered (`ids` = every mode the caller can
   * see, hidden ones included, in order). Stored ids the caller cannot see —
   * a plugin that is disabled right now — keep their place after them.
   */
  reorderModes: (ids: string[]) => Promise<void>
  /** Only the mode block back to its default: declared order, all shown. */
  resetModes: () => Promise<void>
  /**
   * Reset the pinned features and the hidden set to the factory default. The
   * mode block is kept — it has its own reset (`resetModes`).
   */
  reset: () => Promise<void>
}

type SidebarLayoutMutation = (current: SidebarLayout) => SidebarLayout

/**
 * Every id the catalog can ever contain, independent of platform and runtime
 * filtering. A stored pin outside this set is a retired destination and is
 * safe to drop; one inside it is only hidden from the current catalog.
 */
const KNOWN_SIDEBAR_NAV_IDS: ReadonlySet<string> = new Set(SIDEBAR_NAV_META.map((m) => m.id))

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
    // Mutate the migrated layout, not the raw stored one: the ids callers pass
    // are current catalog ids, so a stale renamed id in storage would be
    // invisible to every filter below and survive the edit.
    const current: SidebarLayout = migrateLegacyIds({
      pinned: stored?.pinned ?? DEFAULT_SIDEBAR_LAYOUT.pinned,
      hidden: stored?.hidden ?? DEFAULT_SIDEBAR_LAYOUT.hidden,
      // Carried through untouched by every feature mutation below — they all
      // spread `current` — so pinning an icon never resets the mode order.
      ...(stored?.modes ? { modes: stored.modes } : {}),
    })
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

/** Add `id` to the end of the pinned list (and unhide it). */
export function pinSidebarItem(id: string): Promise<void> {
  return enqueueSidebarLayoutMutation((current) => ({
    ...current,
    pinned: current.pinned.includes(id) ? current.pinned : [...current.pinned, id],
    hidden: current.hidden.filter((h) => h !== id),
  }))
}

/** Remove `id` from pinned → it falls back to "More". */
export function unpinSidebarItem(id: string): Promise<void> {
  return enqueueSidebarLayoutMutation((current) => ({
    ...current,
    pinned: current.pinned.filter((p) => p !== id),
  }))
}

/** Hide `id` everywhere (also unpins it). */
export function hideSidebarItem(id: string): Promise<void> {
  return enqueueSidebarLayoutMutation((current) => ({
    ...current,
    pinned: current.pinned.filter((p) => p !== id),
    hidden: current.hidden.includes(id) ? current.hidden : [...current.hidden, id],
  }))
}

/** Unhide `id` → it surfaces in "More". */
export function showSidebarItem(id: string): Promise<void> {
  return enqueueSidebarLayoutMutation((current) => ({
    ...current,
    hidden: current.hidden.filter((h) => h !== id),
  }))
}

const EMPTY_MODES: SidebarModesLayout = { order: [], hidden: [] }

/** Take workspace mode `id` off the rail. It keeps its slot in the order. */
export function hideSidebarMode(id: string): Promise<void> {
  return enqueueSidebarLayoutMutation((current) => {
    const modes = current.modes ?? EMPTY_MODES
    if (modes.hidden.includes(id)) return current
    return { ...current, modes: { ...modes, hidden: [...modes.hidden, id] } }
  })
}

/** Put workspace mode `id` back on the rail, in the slot it left. */
export function showSidebarMode(id: string): Promise<void> {
  return enqueueSidebarLayoutMutation((current) => {
    const modes = current.modes ?? EMPTY_MODES
    if (!modes.hidden.includes(id)) return current
    return { ...current, modes: { ...modes, hidden: modes.hidden.filter((h) => h !== id) } }
  })
}

/** Put the mode block back to its shipped state: declared order, nothing hidden. */
export function resetSidebarModes(): Promise<void> {
  return enqueueSidebarLayoutMutation((current) => {
    if (!current.modes) return current
    const { modes: _modes, ...rest } = current
    return rest
  })
}

/**
 * Persist `ids` as the mode order. Ids the stored order names but `ids` does
 * not — a plugin container whose plugin is disabled right now — stay behind
 * the reordered ones instead of losing their place for good.
 */
export function reorderSidebarModes(ids: string[]): Promise<void> {
  return enqueueSidebarLayoutMutation((current) => {
    const modes = current.modes ?? EMPTY_MODES
    const reordered = [...new Set(ids)]
    const seen = new Set(reordered)
    const untouched = modes.order.filter((id) => !seen.has(id))
    return { ...current, modes: { ...modes, order: [...reordered, ...untouched] } }
  })
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
  // Same per-array subscription for the mode block. `undefined` stays
  // `undefined` (it means "shipped default"), so it is selected as a flag and
  // two arrays rather than as the object a fresh settings tree would replace.
  const hasModes = useSettingsStore((s) => s.settings?.sidebarLayout?.modes != null)
  const modeOrder = useSettingsStore(
    useShallow((s) => s.settings?.sidebarLayout?.modes?.order ?? EMPTY_MODES.order)
  )
  const modeHidden = useSettingsStore(
    useShallow((s) => s.settings?.sidebarLayout?.modes?.hidden ?? EMPTY_MODES.hidden)
  )
  const modes = useMemo<SidebarModesLayout | undefined>(
    () => (hasModes ? { order: modeOrder, hidden: modeHidden } : undefined),
    [hasModes, modeOrder, modeHidden]
  )
  const layout = useMemo<SidebarLayout>(
    () => ({
      pinned,
      hidden,
      ...(modes ? { modes } : {}),
    }),
    [hidden, pinned, modes]
  )

  const resolved = useMemo(() => resolveSidebarLayout(catalog, layout), [catalog, layout])

  // Read from its own settings key, not from `sidebarLayout`. Keeping the two
  // apart is what stops `pin`/`hide` (which rebuild the layout object) from
  // silently discarding the side, and what stops `reset` from moving the rail.
  const side = useSettingsStore((s) => s.settings?.sidebarSide ?? DEFAULT_SIDEBAR_SIDE)
  const setSide = useCallback((next: SidebarSide) => save({ sidebarSide: next }), [save])

  const reorderPinned = useCallback(
    (ids: string[]) =>
      enqueueSidebarLayoutMutation((current) => {
        // The catalog is runtime-filtered (`getSidebarCatalog` consults the
        // paired host's snapshot), so "not in the catalog right now" is not
        // "gone". Only ids the drag could see are reordered; the rest keep
        // their pinned status, the way the workbench rail's `reorder` does.
        const reordered = [...new Set(ids.filter((id) => validIds.has(id)))]
        const untouched = current.pinned.filter(
          (id) => !validIds.has(id) && KNOWN_SIDEBAR_NAV_IDS.has(id)
        )
        return { ...current, pinned: [...reordered, ...untouched] }
      }),
    [validIds]
  )

  const movePinned = useCallback(
    (id: string, delta: number) => {
      const next = moveTeamInOrder(
        resolved.pinned.map((item) => item.id),
        id,
        delta
      )
      return next ? reorderPinned(next) : Promise.resolve()
    },
    [resolved.pinned, reorderPinned]
  )

  // The feature list's "Restore defaults". The mode block has its own
  // (`resetModes`), so this one leaves it alone — one button, one list.
  const reset = useCallback(
    () =>
      enqueueSidebarLayoutMutation((current) => ({
        ...DEFAULT_SIDEBAR_LAYOUT,
        ...(current.modes ? { modes: current.modes } : {}),
      })),
    []
  )

  return {
    catalog,
    layout,
    resolved,
    side,
    setSide,
    pin: pinSidebarItem,
    unpin: unpinSidebarItem,
    hide: hideSidebarItem,
    show: showSidebarItem,
    reorderPinned,
    movePinned,
    modes,
    hideMode: hideSidebarMode,
    showMode: showSidebarMode,
    reorderModes: reorderSidebarModes,
    resetModes: resetSidebarModes,
    reset,
  }
}
