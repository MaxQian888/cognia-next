/**
 * Pure summarisation of the companion-sync snapshot for the `/me/sync` page.
 *
 * `snapshotSyncStates()` is a flat per-table map in handler order. The page
 * needs three things the map does not give it: a status per row, the rows
 * ordered so what needs attention is read first, and one overall verdict
 * with an overall "last synced" stamp for the summary header. Keeping that
 * here (no React, no orchestrator import) means the ordering and the verdict
 * are pinned by a unit test instead of by whatever the JSX happens to do.
 */

export type SyncRowStatus = "error" | "synced" | "never"

export interface SyncRowInput {
  lastSyncAt: number | null
  lastError: string | null
}

export interface SyncRowSummary {
  table: string
  status: SyncRowStatus
  lastSyncAt: number | null
  lastError: string | null
}

/**
 * - `healthy`: every table has synced and none carries an error.
 * - `failing`: at least one table carries an error.
 * - `partial`: no errors, some tables synced, some never.
 * - `never`: nothing has synced yet (a freshly paired phone).
 * - `empty`: the snapshot has no tables at all.
 */
export type SyncOverallStatus = "healthy" | "failing" | "partial" | "never" | "empty"

export interface SyncSnapshotSummary {
  /** Every row, attention first: errors, then never-synced, then synced (newest first). */
  rows: SyncRowSummary[]
  /** Rows carrying an error, in the same order they appear in `rows`. */
  failing: SyncRowSummary[]
  /** Rows without an error (never-synced first, then synced newest first). */
  rest: SyncRowSummary[]
  total: number
  syncedCount: number
  failingCount: number
  neverCount: number
  /** Most recent successful sync across every table, or `null`. */
  lastSyncAt: number | null
  overall: SyncOverallStatus
}

export function rowStatus(state: SyncRowInput): SyncRowStatus {
  if (state.lastError) return "error"
  return state.lastSyncAt ? "synced" : "never"
}

const STATUS_RANK: Record<SyncRowStatus, number> = { error: 0, never: 1, synced: 2 }

export function summarizeSyncSnapshot(
  snapshot: Readonly<Record<string, SyncRowInput>>
): SyncSnapshotSummary {
  const rows: SyncRowSummary[] = Object.entries(snapshot).map(([table, state]) => ({
    table,
    status: rowStatus(state),
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
  }))

  // Stable sort: rank first, then newest sync first, then handler order
  // (Array.prototype.sort is stable, so equal keys keep their input order).
  rows.sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (rank !== 0) return rank
    return (b.lastSyncAt ?? 0) - (a.lastSyncAt ?? 0)
  })

  const failing = rows.filter((r) => r.status === "error")
  const rest = rows.filter((r) => r.status !== "error")
  // A table that failed may still have a previous good sync; count that
  // for the "last synced" stamp, but not toward `syncedCount`, which
  // answers "how many tables are currently in a good state".
  const syncedCount = rows.filter((r) => r.status === "synced").length
  const neverCount = rows.filter((r) => r.status === "never").length
  const lastSyncAt = rows.reduce<number | null>(
    (acc, r) =>
      r.lastSyncAt !== null && (acc === null || r.lastSyncAt > acc) ? r.lastSyncAt : acc,
    null
  )

  let overall: SyncOverallStatus
  if (rows.length === 0) overall = "empty"
  else if (failing.length > 0) overall = "failing"
  else if (syncedCount === rows.length) overall = "healthy"
  else if (syncedCount === 0) overall = "never"
  else overall = "partial"

  return {
    rows,
    failing,
    rest,
    total: rows.length,
    syncedCount,
    failingCount: failing.length,
    neverCount,
    lastSyncAt,
    overall,
  }
}
