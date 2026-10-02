/**
 * Time-driven maintenance transitions, run by the minute job under its
 * lease: `scheduled → in_progress` at the planned start, and
 * `in_progress → awaiting_confirmation` at the planned end when no operator
 * completed it. Every transition is a guarded CAS on the expected revision
 * plus the job lease, so two overlapping runners cannot both apply it and a
 * runner that lost its lease applies nothing.
 *
 * `started` notifies subscribers once (event ID keyed by revision); a window
 * whose planned end already passed when the job catches up is not announced
 * as starting. `awaiting_confirmation` is an operator matter and sends no
 * subscriber mail; its exclusion still stops at the planned end.
 */

import { logEvent } from "../platform/http"
import { leaseGuard, leaseHeld } from "../platform/lease"
import type { JobContext } from "../seams"
import { committed } from "../incidents/store"
import {
  planWindowChange,
  readDueWindows,
  readMaintenanceUpdates,
  type MaintenanceRow,
} from "./store"

/** Windows advanced per state per run. */
export const ADVANCE_BATCH = 50

async function advance(
  job: JobContext,
  row: MaintenanceRow,
  next: "in_progress" | "awaiting_confirmation"
): Promise<boolean> {
  const db = job.env.DB
  const announce = next === "in_progress" && row.ends_at > job.nowMs
  const plan = planWindowChange(db, {
    current: row,
    currentUpdates: await readMaintenanceUpdates(db, row.id),
    expectedRevision: row.revision,
    state: next,
    startsAtMs: row.starts_at,
    endsAtMs: row.ends_at,
    actualEndAtMs: null,
    kind: next === "in_progress" ? "started" : "awaiting_confirmation",
    message: null,
    atMs: job.nowMs,
    event: announce ? { phase: "started", endKind: null } : null,
    requireState: [row.state],
    extraGuard: leaseGuard(job.lease, job.nowMs),
  })
  const applied = committed(await db.batch(plan.statements))
  logEvent("maintenance.advance", {
    maintenanceId: row.id,
    state: next,
    applied,
    fence: job.lease.fence,
  })
  return applied
}

export async function advanceMaintenance(job: JobContext): Promise<void> {
  const db = job.env.DB
  // A zero-row CAS is either an operator edit that won the race (skip the
  // window; the next run re-reads it) or a lost lease (stop the run).
  const stillHeld = () => leaseHeld(db, job.lease, job.nowMs)
  for (const row of await readDueWindows(db, "scheduled", job.nowMs, ADVANCE_BATCH)) {
    if (!(await advance(job, row, "in_progress")) && !(await stillHeld())) return
  }
  for (const row of await readDueWindows(db, "in_progress", job.nowMs, ADVANCE_BATCH)) {
    if (!(await advance(job, row, "awaiting_confirmation")) && !(await stillHeld())) return
  }
}
