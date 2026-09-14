"use client"

/**
 * The unified list's filter, read from the scheduler store and applied to the
 * items once (ADR-0179 §2). Both pages call this with the same items and the
 * same workspace scope, so the rows, the facet counts and the empty state can
 * never disagree between the desktop and the phone.
 */

import { useCallback, useMemo } from "react"

import {
  deriveUnifiedFacets,
  type UnifiedFacets,
  type UnifiedStatusFilter,
} from "@/lib/scheduler/unified-filter"
import { useSchedulerStore, type SchedulerListFilter } from "@/stores/scheduler/scheduler-store"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"

export interface SchedulerListFilterState {
  filter: SchedulerListFilter
  /** `filter.kinds` as the set the filter bar and the predicate want. */
  kinds: ReadonlySet<ScheduledItemKind>
  facets: UnifiedFacets
  /** True when any axis narrows the list. */
  isFiltering: boolean
  setSearch: (search: string) => void
  setStatus: (status: UnifiedStatusFilter) => void
  toggleKind: (kind: ScheduledItemKind) => void
  setLoopOnly: (loopOnly: boolean) => void
  /** Resets kinds + loop (the menu's own axes). */
  clearKindFilters: () => void
  /** Resets every axis, search included. */
  reset: () => void
}

export function useSchedulerListFilter(
  items: readonly UnifiedScheduledItem[],
  /** The workspace on screen, or `undefined` for every workspace. */
  projectId: string | undefined
): SchedulerListFilterState {
  const filter = useSchedulerStore((s) => s.listFilter)
  const setListFilter = useSchedulerStore((s) => s.setListFilter)
  const toggleListKind = useSchedulerStore((s) => s.toggleListKind)
  const resetListFilter = useSchedulerStore((s) => s.resetListFilter)

  const kinds = useMemo(() => new Set(filter.kinds), [filter.kinds])
  const facets = useMemo(
    () =>
      deriveUnifiedFacets(items, {
        search: filter.search,
        status: filter.status,
        kinds,
        loopOnly: filter.loopOnly,
        projectId,
      }),
    [items, filter.search, filter.status, kinds, filter.loopOnly, projectId]
  )

  const setSearch = useCallback((search: string) => setListFilter({ search }), [setListFilter])
  const setStatus = useCallback(
    (status: UnifiedStatusFilter) => setListFilter({ status }),
    [setListFilter]
  )
  const setLoopOnly = useCallback(
    (loopOnly: boolean) => setListFilter({ loopOnly }),
    [setListFilter]
  )
  const clearKindFilters = useCallback(
    () => setListFilter({ kinds: [], loopOnly: false }),
    [setListFilter]
  )

  return {
    filter,
    kinds,
    facets,
    isFiltering:
      filter.search.trim() !== "" ||
      filter.status !== "all" ||
      filter.kinds.length > 0 ||
      filter.loopOnly,
    setSearch,
    setStatus,
    toggleKind: toggleListKind,
    setLoopOnly,
    clearKindFilters,
    reset: resetListFilter,
  }
}
