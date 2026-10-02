/**
 * Hourly and daily rollups of the reference minute slots.
 *
 * A rollup stores counts only — pass / fail per component, the part of them
 * inside maintenance exclusion windows, and a latency histogram of
 * successful attempts — never a percentage. Expected and excluded slot
 * counts are arithmetic (observation start, due time, windows) and are
 * computed when a snapshot is built, so a rollup never has to be rewritten
 * just because time passed.
 *
 * Rebuilds are driven by `dirty_hours` (ingestion, late observations,
 * retroactive maintenance edits) and run under the aggregation lease; a mark
 * is cleared only if its sequence did not move during the rebuild.
 */

import {
  COMPONENT_IDS,
  DAY_MS,
  HOUR_MS,
  type CheckResult,
  type ComponentId,
} from "../../../../../lib/status/contract"
import {
  addLatencySample,
  emptyLatencyHistogram,
  isMinuteExcluded,
  joinOverallResult,
  mergeLatencyHistograms,
  mergeMinuteWindows,
  type MinuteWindow,
} from "../../../../../lib/status/derive"
import { leaseGuard } from "../platform/lease"
import { logEvent } from "../platform/http"
import type { JobContext, MaintenanceModule } from "../seams"

export const ROLLUP_VERSION = 1
/** Raw minute slots are kept 90 days; older hours cannot be rebuilt. */
export const SLOT_RETENTION_MS = 90 * DAY_MS
/** Hourly rollups (with latency histograms) are kept 8 days. */
export const HOURLY_RETENTION_MS = 8 * DAY_MS
/** Dirty hours processed per aggregation run. */
export const MAX_HOURS_PER_RUN = 48

export interface CountRollup {
  /** pass / fail */
  p: number
  f: number
  /** pass / fail inside an exclusion window */
  xp: number
  xf: number
}

export interface ComponentRollup extends CountRollup {
  /** Latency histogram of successful attempts (hourly rollups only). */
  h: number[] | null
}

export interface Rollup {
  v: typeof ROLLUP_VERSION
  c: Record<ComponentId, ComponentRollup>
  /** The joined overall series. */
  o: CountRollup
}

export interface SlotRow {
  minute: number
  http: CheckResult
  auth: CheckResult
  data: CheckResult
  http_ms: number | null
  auth_ms: number | null
  data_ms: number | null
}

const COLUMN: Record<
  ComponentId,
  { result: "http" | "auth" | "data"; ms: "http_ms" | "auth_ms" | "data_ms" }
> = {
  signalingHttp: { result: "http", ms: "http_ms" },
  signalingAuth: { result: "auth", ms: "auth_ms" },
  relayData: { result: "data", ms: "data_ms" },
}

export function emptyRollup(withHistogram: boolean): Rollup {
  const component = (): ComponentRollup => ({
    p: 0,
    f: 0,
    xp: 0,
    xf: 0,
    h: withHistogram ? emptyLatencyHistogram() : null,
  })
  return {
    v: ROLLUP_VERSION,
    c: { signalingHttp: component(), signalingAuth: component(), relayData: component() },
    o: { p: 0, f: 0, xp: 0, xf: 0 },
  }
}

export type ExclusionWindows = Record<ComponentId, MinuteWindow[]>

/** Per-component merged windows plus their union for the overall series. */
export function mergeExclusions(windows: ExclusionWindows): {
  perComponent: ExclusionWindows
  overall: MinuteWindow[]
} {
  const perComponent = {} as ExclusionWindows
  for (const id of COMPONENT_IDS) perComponent[id] = mergeMinuteWindows(windows[id] ?? [])
  // A maintenance window on any component excludes the joined minute: the
  // overall series cannot claim an outage-free minute the operator declared.
  const overall = mergeMinuteWindows(COMPONENT_IDS.flatMap((id) => perComponent[id]))
  return { perComponent, overall }
}

function tally(target: CountRollup, result: CheckResult, excluded: boolean): void {
  if (result === "pass") {
    target.p += 1
    if (excluded) target.xp += 1
  } else if (result === "fail") {
    target.f += 1
    if (excluded) target.xf += 1
  }
}

/** Pure: roll a set of minute slots up into one rollup. */
export function computeRollup(
  slots: readonly SlotRow[],
  exclusions: { perComponent: ExclusionWindows; overall: MinuteWindow[] },
  withHistogram: boolean
): Rollup {
  const rollup = emptyRollup(withHistogram)
  for (const slot of slots) {
    for (const id of COMPONENT_IDS) {
      const column = COLUMN[id]
      const result = slot[column.result]
      const component = rollup.c[id]
      tally(component, result, isMinuteExcluded(slot.minute, exclusions.perComponent[id]))
      const ms = slot[column.ms]
      // Successful attempts only: a failure is a gap, never zero milliseconds.
      if (component.h && result === "pass" && ms !== null && Number.isFinite(ms)) {
        addLatencySample(component.h, ms)
      }
    }
    const overall = joinOverallResult(COMPONENT_IDS.map((id) => slot[COLUMN[id].result]))
    tally(rollup.o, overall, isMinuteExcluded(slot.minute, exclusions.overall))
  }
  return rollup
}

/** Pure: sum rollups (histograms merged bucket-wise when all have one). */
export function sumRollups(rollups: readonly Rollup[], withHistogram: boolean): Rollup {
  const total = emptyRollup(withHistogram)
  for (const rollup of rollups) {
    for (const id of COMPONENT_IDS) {
      const source = rollup.c[id]
      const target = total.c[id]
      target.p += source.p
      target.f += source.f
      target.xp += source.xp
      target.xf += source.xf
      if (target.h && source.h) target.h = mergeLatencyHistograms([target.h, source.h])
    }
    total.o.p += rollup.o.p
    total.o.f += rollup.o.f
    total.o.xp += rollup.o.xp
    total.o.xf += rollup.o.xf
  }
  return total
}

export function parseRollup(json: string): Rollup | null {
  try {
    const parsed = JSON.parse(json) as Rollup
    return parsed && parsed.v === ROLLUP_VERSION ? parsed : null
  } catch {
    return null
  }
}

export interface RebuildResult {
  rebuiltHours: number
  rebuiltDays: number
  skippedHours: number
}

/**
 * Rebuild up to MAX_HOURS_PER_RUN dirty hours, newest first, then the
 * daily rollups of every day left with no dirty hour. An hour older than the
 * hourly retention is rebuilt together with its whole day (the other hourly
 * rows of that day no longer exist to sum); an hour older than slot
 * retention cannot be rebuilt and its mark is dropped with a log line rather
 * than overwriting history with zeros.
 */
export async function rebuildDirtyHours(
  job: JobContext,
  maintenance: Pick<MaintenanceModule, "loadExclusionWindows">
): Promise<RebuildResult> {
  const db = job.env.DB
  const nowMs = job.nowMs
  const dirty = await db
    .prepare("SELECT hour, seq FROM dirty_hours ORDER BY hour DESC LIMIT ?")
    .bind(MAX_HOURS_PER_RUN)
    .all<{ hour: number; seq: number }>()
  const rows = dirty.results ?? []
  if (rows.length === 0) return { rebuiltHours: 0, rebuiltDays: 0, skippedHours: 0 }

  const slotCutoffHour = Math.floor((nowMs - SLOT_RETENTION_MS) / HOUR_MS)
  const hourlyCutoffHour = Math.floor((nowMs - HOURLY_RETENTION_MS) / HOUR_MS)
  const guard = () => leaseGuard(job.lease, job.nowMs)
  const statements: D1PreparedStatement[] = []
  let skippedHours = 0

  // Hours to (re)compute: recent ones individually, old ones by whole day.
  const targets = new Map<number, number>() // hour -> seq to clear (or -1 when not dirty)
  for (const row of rows) {
    // Bound the work per run; a whole-day expansion may overshoot by one day.
    if (targets.size >= MAX_HOURS_PER_RUN) break
    if (row.hour < slotCutoffHour) {
      skippedHours += 1
      logEvent("rollup.skip_expired_hour", { hour: row.hour })
      const g = guard()
      statements.push(
        db
          .prepare(`DELETE FROM dirty_hours WHERE hour = ? AND seq = ? AND ${g.sql}`)
          .bind(row.hour, row.seq, ...g.params)
      )
      continue
    }
    targets.set(row.hour, row.seq)
    if (row.hour < hourlyCutoffHour) {
      const dayStart = Math.floor((row.hour * HOUR_MS) / DAY_MS) * 24
      for (let hour = dayStart; hour < dayStart + 24; hour += 1) {
        if (!targets.has(hour)) targets.set(hour, -1)
      }
    }
  }

  const hours = [...targets.keys()].sort((left, right) => left - right)
  if (hours.length > 0) {
    const fromMs = hours[0] * HOUR_MS
    const toMs = (hours[hours.length - 1] + 1) * HOUR_MS
    const exclusions = mergeExclusions(
      await maintenance.loadExclusionWindows(job.env, fromMs, toMs)
    )
    // One round trip for every hour's slots.
    const slotResults = await db.batch(
      hours.map((hour) =>
        db
          .prepare(
            `SELECT minute, http, auth, data, http_ms, auth_ms, data_ms
             FROM reference_slots WHERE minute >= ? AND minute < ? ORDER BY minute`
          )
          .bind(hour * 60, hour * 60 + 60)
      )
    )
    const slotSets = slotResults.map((result) => (result.results ?? []) as unknown as SlotRow[])
    hours.forEach((hour, index) => {
      const rollup = computeRollup(slotSets[index], exclusions, true)
      const seq = targets.get(hour)!
      const g = guard()
      statements.push(
        db
          .prepare(
            `INSERT INTO hourly_rollups (hour, source_seq, rollup_json, updated_at)
             SELECT ?, ?, ?, ? WHERE ${g.sql}
             ON CONFLICT (hour) DO UPDATE SET source_seq = excluded.source_seq,
               rollup_json = excluded.rollup_json, updated_at = excluded.updated_at`
          )
          .bind(hour, Math.max(seq, 0), JSON.stringify(rollup), nowMs, ...g.params)
      )
      if (seq >= 0) {
        const clear = guard()
        statements.push(
          db
            .prepare(`DELETE FROM dirty_hours WHERE hour = ? AND seq = ? AND ${clear.sql}`)
            .bind(hour, seq, ...clear.params)
        )
      }
    })
  }
  if (statements.length > 0) await db.batch(statements)

  // Daily rollups for every touched day that has no dirty hour left.
  const days = [...new Set(hours.map((hour) => Math.floor((hour * HOUR_MS) / DAY_MS)))]
  let rebuiltDays = 0
  for (const day of days) {
    const firstHour = day * 24
    const [pending, hourly] = await db.batch([
      db
        .prepare("SELECT COUNT(*) AS n FROM dirty_hours WHERE hour >= ? AND hour < ?")
        .bind(firstHour, firstHour + 24),
      db
        .prepare("SELECT rollup_json, source_seq FROM hourly_rollups WHERE hour >= ? AND hour < ?")
        .bind(firstHour, firstHour + 24),
    ])
    const remaining = ((pending.results ?? [])[0] as { n: number } | undefined)?.n ?? 0
    if (remaining > 0) continue
    const hourlyRows = (hourly.results ?? []) as Array<{ rollup_json: string; source_seq: number }>
    const parsed = hourlyRows
      .map((row) => parseRollup(row.rollup_json))
      .filter((row): row is Rollup => row !== null)
    const daily = sumRollups(parsed, false)
    const sourceSeq = hourlyRows.reduce((max, row) => Math.max(max, row.source_seq), 0)
    const g = guard()
    await db
      .prepare(
        `INSERT INTO daily_rollups (day, source_seq, rollup_json, updated_at)
         SELECT ?, ?, ?, ? WHERE ${g.sql}
         ON CONFLICT (day) DO UPDATE SET source_seq = excluded.source_seq,
           rollup_json = excluded.rollup_json, updated_at = excluded.updated_at`
      )
      .bind(day, sourceSeq, JSON.stringify(daily), nowMs, ...g.params)
      .run()
    rebuiltDays += 1
  }
  return { rebuiltHours: hours.length, rebuiltDays, skippedHours }
}
