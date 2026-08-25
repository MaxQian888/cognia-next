/**
 * Transport Types
 */

import type { LogLevel } from "./log-level"
import type { LogEntry, StructuredLogEntry } from "./log-entry"

export type TransportHealthStatus = "healthy" | "degraded" | "offline"

/**
 * Why a transport lost an entry. Closed on purpose.
 *
 * `droppedEntries` on its own is a number with no story: "the collector is
 * unreachable" and "we are producing faster than we can ship" and "the app
 * shut down mid-flush" all read as the same integer, so the number tells an
 * operator that something was lost but never what to do about it.
 *
 * - `ship-failed`        a flush to the destination failed outright.
 * - `overflow-evicted`   the buffer was full and older entries made way.
 * - `entry-rejected`     one entry could not be encoded or passed validation.
 * - `shutdown-discarded` the buffer was abandoned at shutdown or reset.
 * - `retention-pruned`   a retention sweep removed already-stored records.
 */
export const LOG_DROP_REASONS = [
  "ship-failed",
  "overflow-evicted",
  "entry-rejected",
  "shutdown-discarded",
  "retention-pruned",
] as const

export type LogDropReason = (typeof LOG_DROP_REASONS)[number]

/** Per-reason drop counts. Absent keys mean zero. */
export type LogDropCounts = Partial<Record<LogDropReason, number>>

export interface TransportHealthSnapshot {
  transport: string
  status: TransportHealthStatus
  queueDepth: number
  retryCount: number
  /** Total entries lost. Always equals the sum of {@link droppedByReason}. */
  droppedEntries: number
  /**
   * The same loss, attributed. Optional so a transport that has not adopted
   * the taxonomy still type-checks — but every transport in this repo does,
   * and `dropCountsSumTo` is the invariant that keeps the two agreeing.
   */
  droppedByReason?: LogDropCounts
  lastSuccessAt?: string
  lastFailureAt?: string
  lastError?: string
  updatedAt: string
}

/** Add `count` drops under `reason`, in place. Non-positive counts are ignored. */
export function recordDrop(counts: LogDropCounts, reason: LogDropReason, count = 1): LogDropCounts {
  if (!Number.isFinite(count) || count <= 0) return counts
  counts[reason] = (counts[reason] ?? 0) + count
  return counts
}

/** Total across every reason. */
export function totalDrops(counts: LogDropCounts | undefined): number {
  if (!counts) return 0
  let total = 0
  for (const reason of LOG_DROP_REASONS) total += counts[reason] ?? 0
  return total
}

/**
 * Whether a snapshot's attributed drops account for all of them. False means
 * some loss is unexplained, which is the thing worth noticing.
 */
export function dropCountsSumTo(snapshot: TransportHealthSnapshot): boolean {
  return totalDrops(snapshot.droppedByReason) === snapshot.droppedEntries
}

export interface TransportDiagnosticEvent {
  code: string
  message: string
  level?: LogLevel
  data?: Record<string, unknown>
  sourceTransport?: string
}

/**
 * Transport interface for log output
 */
export interface Transport {
  /** Transport name for identification */
  name: string
  /** Log a single entry */
  log(entry: StructuredLogEntry): void | Promise<void>
  /** Flush buffered entries */
  flush?(): void | Promise<void>
  /** Close and cleanup */
  close?(): void | Promise<void>
  /** Report transport health snapshot */
  getHealth?(): TransportHealthSnapshot
  /** Optional sync pending count for lightweight polling */
  getPendingCount?(): number
}

/**
 * Legacy transport interface (originally lived in `@/types/system/logger`).
 */
export interface LogTransport {
  name: string
  log: (entry: LogEntry) => void | Promise<void>
  flush?: () => void | Promise<void>
}
