/**
 * Execution Monitor view preferences ("围观设置") — the knobs that shape how the
 * live "what is running right now" list is presented, plus the pure functions
 * that apply them to a row list.
 *
 * Persisted on `AppSettings.executionMonitorPrefs` via `useSettingsStore.save()`
 * (same settings-singleton pattern as `discoverDefaults`), so the chosen view
 * follows the user across devices with no Dexie migration. The row *data* is
 * derived live in {@link buildExecutionMonitorModel}; only these presentation
 * knobs ride on the settings singleton.
 */

import {
  EXECUTION_FILTER_KINDS,
  executionRowFilterKind,
  type ExecutionFilterKind,
  type UnifiedExecutionRow,
  type UnifiedExecutionStatus,
} from "./monitor-model"

export type ExecutionMonitorSort = "recent" | "kind" | "status"

export const EXECUTION_MONITOR_SORTS: readonly ExecutionMonitorSort[] = [
  "recent",
  "kind",
  "status",
] as const

export interface ExecutionMonitorPrefs {
  /**
   * Kinds hidden from the list. Stored as a *deny* list (not an allow list) so
   * a future kind defaults to visible instead of silently disappearing.
   */
  hiddenKinds: ExecutionFilterKind[]
  /** Row ordering. `recent` (default) = newest first. */
  sort: ExecutionMonitorSort
  /** When true, rows are grouped under a per-kind subheader with a count. */
  groupByKind: boolean
  /** When true, each row shows a live elapsed-since-start timer. */
  showElapsed: boolean
}

export const DEFAULT_EXECUTION_MONITOR_PREFS: ExecutionMonitorPrefs = {
  hiddenKinds: [],
  sort: "recent",
  groupByKind: false,
  showElapsed: true,
}

/** Shape stored on the settings singleton (every field optional / untrusted). */
export type StoredExecutionMonitorPrefs = Partial<{
  hiddenKinds: string[]
  sort: string
  groupByKind: boolean
  showElapsed: boolean
}>

const FILTER_KIND_SET = new Set<string>(EXECUTION_FILTER_KINDS)
const SORT_SET = new Set<string>(EXECUTION_MONITOR_SORTS)

/**
 * Resolve untrusted stored prefs into a fully-populated, validated object,
 * dropping unknown kinds / sorts and de-duplicating the hidden set.
 */
export function resolveExecutionMonitorPrefs(
  raw: StoredExecutionMonitorPrefs | undefined
): ExecutionMonitorPrefs {
  if (!raw) return DEFAULT_EXECUTION_MONITOR_PREFS
  const hiddenKinds = Array.isArray(raw.hiddenKinds)
    ? [...new Set(raw.hiddenKinds.filter((k): k is ExecutionFilterKind => FILTER_KIND_SET.has(k)))]
    : []
  return {
    hiddenKinds,
    sort: SORT_SET.has(raw.sort as string)
      ? (raw.sort as ExecutionMonitorSort)
      : DEFAULT_EXECUTION_MONITOR_PREFS.sort,
    groupByKind: raw.groupByKind === true,
    showElapsed: raw.showElapsed !== false,
  }
}

/** True when every knob is still at its factory default. */
export function isDefaultExecutionMonitorPrefs(prefs: ExecutionMonitorPrefs): boolean {
  return (
    prefs.hiddenKinds.length === 0 &&
    prefs.sort === DEFAULT_EXECUTION_MONITOR_PREFS.sort &&
    prefs.groupByKind === DEFAULT_EXECUTION_MONITOR_PREFS.groupByKind &&
    prefs.showElapsed === DEFAULT_EXECUTION_MONITOR_PREFS.showElapsed
  )
}

/** Drop rows whose filterable kind is in the hidden set. */
export function filterExecutionRows(
  rows: UnifiedExecutionRow[],
  hiddenKinds: readonly ExecutionFilterKind[]
): UnifiedExecutionRow[] {
  if (hiddenKinds.length === 0) return rows
  const hidden = new Set<string>(hiddenKinds)
  return rows.filter((r) => !hidden.has(executionRowFilterKind(r)))
}

/** Status ordering for the `status` sort — most-active first. */
const STATUS_RANK: Record<UnifiedExecutionStatus, number> = {
  running: 0,
  waiting: 1,
  queued: 2,
  done: 3,
  error: 4,
  cancelled: 5,
}

const KIND_RANK: Record<ExecutionFilterKind, number> = Object.fromEntries(
  EXECUTION_FILTER_KINDS.map((k, i) => [k, i])
) as Record<ExecutionFilterKind, number>

/**
 * Return a new array sorted per `sort`. The incoming rows are already
 * newest-first (see {@link buildExecutionMonitorModel}); `kind` / `status`
 * re-bucket while keeping newest-first *within* each bucket, and `recent`
 * returns the list unchanged.
 */
export function sortExecutionRows(
  rows: UnifiedExecutionRow[],
  sort: ExecutionMonitorSort
): UnifiedExecutionRow[] {
  if (sort === "recent") return rows
  const withIndex = rows.map((row, index) => ({ row, index }))
  withIndex.sort((a, b) => {
    const primary =
      sort === "kind"
        ? KIND_RANK[executionRowFilterKind(a.row)] - KIND_RANK[executionRowFilterKind(b.row)]
        : STATUS_RANK[a.row.status] - STATUS_RANK[b.row.status]
    // Stable within a bucket: preserve the incoming newest-first order.
    return primary !== 0 ? primary : a.index - b.index
  })
  return withIndex.map((x) => x.row)
}

export interface ExecutionRowGroup {
  kind: ExecutionFilterKind
  rows: UnifiedExecutionRow[]
}

/**
 * Bucket rows by filterable kind, preserving first-seen order (so the group
 * order follows whatever sort was applied upstream).
 */
export function groupExecutionRowsByKind(rows: UnifiedExecutionRow[]): ExecutionRowGroup[] {
  const groups: ExecutionRowGroup[] = []
  const byKind = new Map<ExecutionFilterKind, ExecutionRowGroup>()
  for (const row of rows) {
    const kind = executionRowFilterKind(row)
    let group = byKind.get(kind)
    if (!group) {
      group = { kind, rows: [] }
      byKind.set(kind, group)
      groups.push(group)
    }
    group.rows.push(row)
  }
  return groups
}

/** Apply the hidden-kind filter then the sort, in one call. */
export function applyExecutionMonitorPrefs(
  rows: UnifiedExecutionRow[],
  prefs: ExecutionMonitorPrefs
): UnifiedExecutionRow[] {
  return sortExecutionRows(filterExecutionRows(rows, prefs.hiddenKinds), prefs.sort)
}
