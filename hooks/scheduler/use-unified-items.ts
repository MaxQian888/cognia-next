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

export interface UseUnifiedItemsResult {
  items: UnifiedScheduledItem[]
  /** Per-source error (if a source's subscribe stream errored). */
  errors: Partial<Record<ScheduledItemKind, unknown>>
  /** Counts per kind, derived for filter chips / dashboard strip. */
  countsByKind: Record<ScheduledItemKind, number>
  /** Active counts per kind. */
  activeCountsByKind: Record<ScheduledItemKind, number>
}

export interface UseUnifiedItemsOptions {
  /** Override the registry (tests inject a stub registry). */
  registry?: SchedulerSourceRegistry
}

const EMPTY_COUNTS = {
  app: 0,
  workflow: 0,
  backup: 0,
  plugin: 0,
  system: 0,
} satisfies Record<ScheduledItemKind, number>

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

  const { countsByKind, activeCountsByKind } = useMemo(() => {
    const counts = { ...EMPTY_COUNTS }
    const actives = { ...EMPTY_COUNTS }
    for (const [kind, list] of Object.entries(snapshotByKind) as Array<
      [ScheduledItemKind, UnifiedScheduledItem[]]
    >) {
      counts[kind] = list.length
      actives[kind] = list.filter((i) => i.status === "active").length
    }
    return { countsByKind: counts, activeCountsByKind: actives }
  }, [snapshotByKind])

  return { items, errors, countsByKind, activeCountsByKind }
}
