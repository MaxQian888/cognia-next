/**
 * Recent evidence loaded once per aggregation run and shared by the probe
 * summaries, the component evaluation and the snapshot builder.
 */

import {
  MINUTE_MS,
  type CheckObservation,
  type CheckResult,
  type ProfileId,
  type ReasonCode,
} from "../../../../../lib/status/contract"

/** Long enough for four 300 s cadence slots plus grace. */
export const RECENT_RUN_WINDOW_MS = 35 * MINUTE_MS
/** Reference slots examined for streaks (outage, recovery, resolve). */
export const RECENT_SLOT_MINUTES = 20

export interface RecentRun {
  probeId: string
  profileId: ProfileId
  scheduledMinute: number
  scheduledAtMs: number
  finishedAtMs: number
  checks: CheckObservation[]
}

export interface ReferenceSlot {
  minute: number
  probeId: string
  results: Record<
    "http" | "auth" | "data",
    { result: CheckResult; reason: ReasonCode | null; ms: number | null }
  >
}

export interface RecentEvidence {
  runs: RecentRun[]
  slots: Map<number, ReferenceSlot>
}

interface RunRow {
  probe_id: string
  profile_id: ProfileId
  scheduled_minute: number
  scheduled_at: number
  finished_at: number
  checks_json: string
}

interface SlotRowFull {
  minute: number
  probe_id: string
  http: CheckResult
  auth: CheckResult
  data: CheckResult
  http_ms: number | null
  auth_ms: number | null
  data_ms: number | null
  http_reason: ReasonCode | null
  auth_reason: ReasonCode | null
  data_reason: ReasonCode | null
}

export async function loadRecentEvidence(db: D1Database, nowMs: number): Promise<RecentEvidence> {
  const nowMinute = Math.floor(nowMs / MINUTE_MS)
  const [runs, slots] = await db.batch([
    db
      .prepare(
        `SELECT probe_id, profile_id, scheduled_minute, scheduled_at, finished_at, checks_json
         FROM probe_runs WHERE received_at >= ? AND scheduled_at >= ?
         ORDER BY scheduled_at`
      )
      .bind(nowMs - RECENT_RUN_WINDOW_MS - 10 * MINUTE_MS, nowMs - RECENT_RUN_WINDOW_MS),
    db
      .prepare(
        `SELECT minute, probe_id, http, auth, data, http_ms, auth_ms, data_ms, http_reason, auth_reason, data_reason
         FROM reference_slots WHERE minute >= ? ORDER BY minute`
      )
      .bind(nowMinute - RECENT_SLOT_MINUTES - 2),
  ])
  const slotMap = new Map<number, ReferenceSlot>()
  for (const row of (slots.results ?? []) as unknown as SlotRowFull[]) {
    slotMap.set(row.minute, {
      minute: row.minute,
      probeId: row.probe_id,
      results: {
        http: { result: row.http, reason: row.http_reason, ms: row.http_ms },
        auth: { result: row.auth, reason: row.auth_reason, ms: row.auth_ms },
        data: { result: row.data, reason: row.data_reason, ms: row.data_ms },
      },
    })
  }
  return {
    runs: ((runs.results ?? []) as unknown as RunRow[]).map((row) => ({
      probeId: row.probe_id,
      profileId: row.profile_id,
      scheduledMinute: row.scheduled_minute,
      scheduledAtMs: row.scheduled_at,
      finishedAtMs: row.finished_at,
      checks: JSON.parse(row.checks_json) as CheckObservation[],
    })),
    slots: slotMap,
  }
}

/** The observer itself worked: no check reported a runner error. */
export function runSucceeded(run: Pick<RecentRun, "checks">): boolean {
  return !run.checks.some((check) => check.reason === "runner_error")
}
