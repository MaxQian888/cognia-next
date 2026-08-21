/**
 * Cross-source filtering and aggregation for the scheduler page.
 *
 * Before this module the page carried two disagreeing universes: the sidebar's
 * search box and status chips filtered the app-only `ScheduledTask[]`, while
 * the list, the kind chips, and the calendar actually rendered
 * `UnifiedScheduledItem[]` merged from all six sources. Typing in the search
 * box therefore changed nothing on screen, and the overview headline
 * ("2 tasks") contradicted the list right next to it ("4 rows").
 *
 * Everything the page filters, counts, or charts now goes through the helpers
 * here, so there is exactly one answer to "how many scheduled things are
 * there, and which of them are you looking at".
 */

import {
  SCHEDULED_ITEM_KINDS,
  type ScheduledItemKind,
  type UnifiedItemStatus,
  type UnifiedScheduledItem,
} from "@/types/scheduler/unified"

/** Status buckets offered by the sidebar's segmented control. */
export const UNIFIED_STATUS_FILTERS = ["all", "active", "paused"] as const

export type UnifiedStatusFilter = (typeof UNIFIED_STATUS_FILTERS)[number]

/** The tag `/loop` writes on the interval tasks it creates. */
export const LOOP_TAG = "loop"

export function isUnifiedStatusFilter(value: string): value is UnifiedStatusFilter {
  return (UNIFIED_STATUS_FILTERS as readonly string[]).includes(value)
}

export interface UnifiedFilterCriteria {
  /** Free-text query matched against name, description, and cron expression. */
  search?: string
  /** Status bucket; `all` (or omitted) disables the status predicate. */
  status?: UnifiedStatusFilter
  /**
   * Keep only `/loop` interval tasks (tagged by `lib/loop/interval.ts`).
   * Deliberately a separate axis rather than a fourth status value: "the
   * paused loops" is a question the user asks, and a four-way status control
   * cannot express it.
   */
  loopOnly?: boolean
  /** Kinds to keep. An empty/omitted set means "every kind". */
  kinds?: ReadonlySet<ScheduledItemKind>
}

function matchesStatus(item: UnifiedScheduledItem, status: UnifiedStatusFilter): boolean {
  switch (status) {
    case "active":
      return item.status === "active"
    case "paused":
      return item.status === "paused"
    case "all":
      return true
  }
}

/** Whether this item was created by the `/loop` slash command. */
export function isLoopItem(item: UnifiedScheduledItem): boolean {
  return item.tags?.includes(LOOP_TAG) === true
}

function matchesSearch(item: UnifiedScheduledItem, query: string): boolean {
  return (
    item.name.toLowerCase().includes(query) ||
    item.description?.toLowerCase().includes(query) === true ||
    item.triggerSummary.cron?.toLowerCase().includes(query) === true
  )
}

/**
 * Apply search + status + kind together. Order is irrelevant (all three are
 * conjunctive); the input array is never mutated, and the result is always a
 * fresh array the caller owns outright — including on the no-op path, so a
 * consumer that sorts what it is handed can never reach back into the source
 * list. Render identity is the call sites' job: every one of them already
 * wraps this in a `useMemo`.
 */
export function filterUnifiedItems(
  items: readonly UnifiedScheduledItem[],
  criteria: UnifiedFilterCriteria = {}
): UnifiedScheduledItem[] {
  const query = criteria.search?.trim().toLowerCase() ?? ""
  const status = criteria.status ?? "all"
  const loopOnly = criteria.loopOnly === true
  const kinds = criteria.kinds && criteria.kinds.size > 0 ? criteria.kinds : undefined

  // A copy, not the caller's array. The signature takes `readonly` and the
  // result is handed to the sidebar as `visibleItems`; returning the input
  // would mean an in-place `.sort()` / `.reverse()` downstream silently
  // reorders `unifiedItems` itself — the memoized array behind the calendar,
  // the agenda, the statistics and the keyboard cursor — with no re-render to
  // make it visible. Every other branch allocates anyway.
  if (!query && status === "all" && !loopOnly && !kinds) return items.slice()

  return items.filter((item) => {
    if (kinds && !kinds.has(item.kind)) return false
    if (!matchesStatus(item, status)) return false
    if (loopOnly && !isLoopItem(item)) return false
    if (query && !matchesSearch(item, query)) return false
    return true
  })
}

/**
 * Counts for the status segmented control. Each bucket is counted against the
 * *kind-filtered* list the caller passes in, so the numbers on the control
 * always describe the list the user is about to see.
 */
export function countUnifiedByStatus(
  items: readonly UnifiedScheduledItem[]
): Record<UnifiedStatusFilter, number> & { loop: number } {
  const counts = { all: 0, active: 0, paused: 0, loop: 0 }
  for (const item of items) {
    counts.all++
    if (item.status === "active") counts.active++
    else if (item.status === "paused") counts.paused++
    if (isLoopItem(item)) counts.loop++
  }
  return counts
}

/** Per-kind totals and per-kind active totals, derived from one pass. */
export function countUnifiedByKind(items: readonly UnifiedScheduledItem[]): {
  countsByKind: Record<ScheduledItemKind, number>
  activeCountsByKind: Record<ScheduledItemKind, number>
} {
  const countsByKind = emptyKindRecord()
  const activeCountsByKind = emptyKindRecord()
  for (const item of items) {
    countsByKind[item.kind]++
    if (item.status === "active") activeCountsByKind[item.kind]++
  }
  return { countsByKind, activeCountsByKind }
}

function emptyKindRecord(): Record<ScheduledItemKind, number> {
  return SCHEDULED_ITEM_KINDS.reduce(
    (acc, kind) => {
      acc[kind] = 0
      return acc
    },
    {} as Record<ScheduledItemKind, number>
  )
}

/**
 * The headline reading for the overview, computed from the same unified list
 * the sidebar renders.
 *
 * `successRate` is deliberately `null` — not `0` — when nothing has ever run.
 * A red "0%" on a fresh install reads as "everything is failing"; "—" reads as
 * "nothing to report yet", which is the truth.
 *
 * Run counters come from the sources that keep them (app / plugin / connector
 * rows carry lifetime `successCount` / `failureCount`); sources that don't
 * report runs contribute to the task counts but not to the rate, and
 * `reportingItems` lets the UI say so instead of implying full coverage.
 */
export interface UnifiedStatistics {
  totalItems: number
  activeItems: number
  pausedItems: number
  /** Everything that is neither active nor paused (disabled / expired / unknown). */
  otherItems: number
  totalRuns: number
  successfulRuns: number
  failedRuns: number
  /** Whole-percent success rate, or `null` when no run has been recorded. */
  successRate: number | null
  /** How many items contributed run counters to the rate above. */
  reportingItems: number
  countsByKind: Record<ScheduledItemKind, number>
  activeCountsByKind: Record<ScheduledItemKind, number>
}

const NEUTRAL_STATUSES: ReadonlySet<UnifiedItemStatus> = new Set(["active", "paused"])

export function deriveUnifiedStatistics(items: readonly UnifiedScheduledItem[]): UnifiedStatistics {
  const countsByKind = emptyKindRecord()
  const activeCountsByKind = emptyKindRecord()

  let activeItems = 0
  let pausedItems = 0
  let otherItems = 0
  let successfulRuns = 0
  let failedRuns = 0
  let reportingItems = 0

  for (const item of items) {
    countsByKind[item.kind]++
    if (item.status === "active") {
      activeItems++
      activeCountsByKind[item.kind]++
    } else if (item.status === "paused") {
      pausedItems++
    }
    if (!NEUTRAL_STATUSES.has(item.status)) otherItems++

    const success = item.successCount
    const failure = item.failureCount
    if (success !== undefined || failure !== undefined) {
      reportingItems++
      successfulRuns += success ?? 0
      failedRuns += failure ?? 0
    }
  }

  const totalRuns = successfulRuns + failedRuns

  return {
    totalItems: items.length,
    activeItems,
    pausedItems,
    otherItems,
    totalRuns,
    successfulRuns,
    failedRuns,
    successRate: totalRuns > 0 ? Math.round((successfulRuns / totalRuns) * 100) : null,
    reportingItems,
    countsByKind,
    activeCountsByKind,
  }
}

/**
 * Everything the sidebar needs to render one filter row and the list beneath
 * it, derived in one place so the numbers on the controls and the rows on
 * screen can never tell different stories.
 *
 * Facet counts follow the standard faceted-search rule: each facet is counted
 * against the list filtered by *every other* criterion but not by itself.
 * Without that, pinning one kind would zero the others and the user could
 * never widen the selection back out.
 */
export interface UnifiedFacets {
  /** The rows to render — every criterion applied. */
  visibleItems: UnifiedScheduledItem[]
  /** Counts for the status control (kind + loop + search applied). */
  statusCounts: Record<UnifiedStatusFilter, number> & { loop: number }
  /** Counts for the kind menu (status + loop + search applied, kinds not). */
  countsByKind: Record<ScheduledItemKind, number>
  /** How many `/loop` items survive everything except the loop toggle itself. */
  loopCount: number
}

export function deriveUnifiedFacets(
  items: readonly UnifiedScheduledItem[],
  criteria: UnifiedFilterCriteria = {}
): UnifiedFacets {
  const { search, status, kinds, loopOnly } = criteria

  const visibleItems = filterUnifiedItems(items, criteria)
  const statusCounts = countUnifiedByStatus(filterUnifiedItems(items, { search, kinds, loopOnly }))
  const { countsByKind } = countUnifiedByKind(
    filterUnifiedItems(items, { search, status, loopOnly })
  )
  const loopCount = countUnifiedByStatus(filterUnifiedItems(items, { search, status, kinds })).loop

  return { visibleItems, statusCounts, countsByKind, loopCount }
}

/**
 * The next runs across every source, soonest first.
 *
 * The overview's "upcoming" block used to read the app-only store's
 * `upcomingTasks`, so a schedule made mostly of workflow triggers and backups
 * showed "nothing upcoming" while those very items sat in the list below it.
 *
 * Only `active` items with a known future `nextRunAt` qualify: a paused item
 * has no next run, and an item whose `nextRunAt` is in the past is stale
 * (mid-run, or a source that has not refreshed yet) rather than upcoming.
 *
 * `now` defaults to the wall clock, not to `0` — a zero default reads as "no
 * lower bound" and quietly turns the staleness rule above into a no-op, so a
 * caller that forgets it gets a list led by runs that fired hours ago.
 */
export function selectUpcomingItems(
  items: readonly UnifiedScheduledItem[],
  options: { limit?: number; now?: number } = {}
): UnifiedScheduledItem[] {
  const now = options.now ?? Date.now()
  const limit = options.limit
  const upcoming = items
    .filter(
      (item) => item.status === "active" && item.nextRunAt !== undefined && item.nextRunAt >= now
    )
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
  return limit !== undefined ? upcoming.slice(0, limit) : upcoming
}
