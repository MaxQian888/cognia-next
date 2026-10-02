/**
 * Core retention (plan §7): raw runs 14 days, reference slots 90 days,
 * hourly rollups 8 days, daily rollups 400 days, operator operations and
 * audit 180 days. Deletes are bounded per run and fence-guarded; whatever is
 * left is picked up by the next hourly run.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../../../lib/status/contract"
import { HOURLY_RETENTION_MS, SLOT_RETENTION_MS } from "./aggregate/rollup"
import { leaseGuard } from "./platform/lease"
import type { JobContext } from "./seams"

export const RAW_RUN_RETENTION_MS = 14 * DAY_MS
export const DAILY_ROLLUP_RETENTION_MS = 400 * DAY_MS
export const ADMIN_RECORD_RETENTION_MS = 180 * DAY_MS
export const MAX_DELETES_PER_TABLE = 2_000

export async function runCoreRetention(job: JobContext): Promise<Record<string, number>> {
  const db = job.env.DB
  const now = job.nowMs
  const targets: Array<{ table: string; column: string; cutoff: number }> = [
    { table: "probe_runs", column: "received_at", cutoff: now - RAW_RUN_RETENTION_MS },
    {
      table: "reference_slots",
      column: "minute",
      cutoff: Math.floor((now - SLOT_RETENTION_MS) / MINUTE_MS),
    },
    {
      table: "hourly_rollups",
      column: "hour",
      cutoff: Math.floor((now - HOURLY_RETENTION_MS) / HOUR_MS),
    },
    {
      table: "daily_rollups",
      column: "day",
      cutoff: Math.floor((now - DAILY_ROLLUP_RETENTION_MS) / DAY_MS),
    },
    { table: "admin_operations", column: "created_at", cutoff: now - ADMIN_RECORD_RETENTION_MS },
    { table: "audit_events", column: "at", cutoff: now - ADMIN_RECORD_RETENTION_MS },
  ]
  const statements = targets.map(({ table, column, cutoff }) => {
    const guard = leaseGuard(job.lease, now)
    return db
      .prepare(
        `DELETE FROM ${table} WHERE rowid IN (
           SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ${MAX_DELETES_PER_TABLE}
         ) AND ${guard.sql}`
      )
      .bind(cutoff, ...guard.params)
  })
  const results = await db.batch(statements)
  return Object.fromEntries(
    targets.map((target, index) => [target.table, results[index]?.meta.changes ?? 0])
  )
}
