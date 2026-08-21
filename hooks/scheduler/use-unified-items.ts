"use client"

/**
 * Aggregates every registered `ScheduledItemSource` into one
 * `UnifiedScheduledItem[]` for the scheduler page list view.
 *
 * Sources push to the hook through `subscribe(observer)`; the hook keeps the
 * latest snapshot per source and re-emits a merged + sorted list whenever any
 * source updates. The merge is stable thanks to `compareUnifiedItems`.
 *
 * If a source is missing (unregistered or throws on subscribe), the hook
 * treats it as "no items from that source" rather than failing the whole
 * list. Errors are surfaced through the returned `errors` map for the UI to
 * decide whether to render a per-source warning chip.
 */

import { useEffect, useMemo, useState } from "react"
import {
  compareUnifiedItems,
  type ScheduledItemKind,
  type UnifiedScheduledItem,
} from "@/types/scheduler/unified"
import {
  getSchedulerSourceRegistry,
  type SchedulerSourceRegistry,
} from "@/lib/scheduler/sources/registry"
import { deriveUnifiedStatistics, type UnifiedStatistics } from "@/lib/scheduler/unified-filter"

export interface UseUnifiedItemsResult {
  items: UnifiedScheduledItem[]
  /** Per-source error (if a source's subscribe stream errored). */
  errors: Partial<Record<ScheduledItemKind, unknown>>
  /** Counts per kind, derived for filter chips / dashboard strip. */
  countsByKind: Record<ScheduledItemKind, number>
  /** Active counts per kind. */
  activeCountsByKind: Record<ScheduledItemKind, number>
  /**
   * Headline readings over the *same* merged list the page renders — the
   * overview used to compute these from the app-only store, so it announced
   * "2 tasks" above a list of 4. See `lib/scheduler/unified-filter.ts`.
   */
  statistics: UnifiedStatistics
}

export interface UseUnifiedItemsOptions {
  /** Override the registry (tests inject a stub registry). */
  registry?: SchedulerSourceRegistry
}

export function useUnifiedScheduledItems(
  options: UseUnifiedItemsOptions = {}
): UseUnifiedItemsResult {
  const registry = options.registry ?? getSchedulerSourceRegistry()
  const [snapshotByKind, setSnapshotByKind] = useState<
    Record<ScheduledItemKind, UnifiedScheduledItem[]>
  >({
    app: [],
    workflow: [],
    backup: [],
    plugin: [],
    system: [],
    connector: [],
  })
  const [errors, setErrors] = useState<Partial<Record<ScheduledItemKind, unknown>>>({})

  useEffect(() => {
    const subs = registry.listAllSources().map((source) =>
      source.subscribe({
        next: (items) => setSnapshotByKind((prev) => ({ ...prev, [source.kind]: items })),
        error: (err) => setErrors((prev) => ({ ...prev, [source.kind]: err })),
      })
    )
    return () => {
      for (const sub of subs) sub.unsubscribe()
    }
  }, [registry])

  const items = useMemo(() => {
    const merged: UnifiedScheduledItem[] = []
    for (const list of Object.values(snapshotByKind)) merged.push(...list)
    merged.sort(compareUnifiedItems)
    return merged
  }, [snapshotByKind])

  // One aggregation pass over the merged list feeds both the per-kind chips
  // and the overview headline, so the two can never disagree.
  const statistics = useMemo(() => deriveUnifiedStatistics(items), [items])

  return {
    items,
    errors,
    countsByKind: statistics.countsByKind,
    activeCountsByKind: statistics.activeCountsByKind,
    statistics,
  }
}
