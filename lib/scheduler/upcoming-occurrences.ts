/**
 * Upcoming-occurrence projection — the shared data engine behind the scheduler
 * dashboard's calendar and timeline views.
 *
 * Given the active scheduled tasks and a forward window, it enumerates the
 * concrete future run instants for each task by expanding its trigger:
 *   - `cron`     → {@link getNextCronTimes} (timezone-aware)
 *   - `interval` → arithmetic stepping from the task's next anchor
 *   - `once`     → the single `runAt`, if it falls inside the window
 *   - `event`    → skipped (no deterministic schedule)
 *
 * Only `active` tasks are projected; paused / disabled / expired tasks have no
 * future runs. Per-task enumeration is capped so a high-frequency cron (e.g.
 * "every minute") cannot blow up the result set.
 */

import type { ScheduledTask, ScheduledTaskStatus, ScheduledTaskType } from "@/types/scheduler"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"
import { getNextCronTimes } from "./cron-parser"

/** A single projected future run of a task. */
export interface Occurrence {
  /**
   * Routing id. App-only projections carry the `ScheduledTask` id; unified
   * projections carry the `unifiedId`, so the surface that renders them can
   * hand it straight back to the page's selection handler.
   */
  taskId: string
  taskName: string
  taskType: ScheduledTaskType
  triggerType: ScheduledTask["trigger"]["type"]
  status: ScheduledTaskStatus
  /**
   * Which source scheduled this run — drives the per-kind accent in the
   * calendar and agenda. App-only projections report `app`/`plugin`.
   */
  kind: ScheduledItemKind
  /** The instant this run is projected to fire. */
  date: Date
}

export interface OccurrenceWindow {
  /** Window start (defaults to "now" supplied by the caller). */
  from: Date
  /** Window length in days (exclusive upper bound). */
  days: number
  /** Hard cap on occurrences enumerated per task. Defaults to 100. */
  maxPerTask?: number
}

const DEFAULT_MAX_PER_TASK = 100
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The shape the projection reduces to — a trigger description plus the
 * scheduler's own idea of when the item fires next. Keeping the expansion in
 * one place is what lets the calendar and the agenda show workflow / backup /
 * connector runs on exactly the same terms as app tasks.
 */
interface ScheduleSpec {
  type: ScheduledTask["trigger"]["type"]
  cron?: string
  intervalMs?: number
  runAtMs?: number
  timezone?: string
  /** Epoch ms of the next scheduled fire, when the source knows it. */
  nextRunAtMs?: number
}

function expandSchedule(
  spec: ScheduleSpec,
  from: Date,
  windowEnd: Date,
  maxPerTask: number
): Date[] {
  if (spec.type === "cron" && spec.cron) {
    // Enumerate up to maxPerTask future fires, then keep those in the window.
    return getNextCronTimes(spec.cron, maxPerTask, from, spec.timezone).filter(
      (d) => d >= from && d < windowEnd
    )
  }

  if (spec.type === "interval" && spec.intervalMs && spec.intervalMs > 0) {
    const out: Date[] = []
    // Anchor on the task's known next run when it is still in the future;
    // otherwise step forward from the window start. This keeps the projected
    // phase aligned with what the scheduler will actually do.
    const anchorMs =
      spec.nextRunAtMs !== undefined && spec.nextRunAtMs > from.getTime()
        ? spec.nextRunAtMs
        : from.getTime() + spec.intervalMs
    for (
      let t = anchorMs;
      t < windowEnd.getTime() && out.length < maxPerTask;
      t += spec.intervalMs
    ) {
      if (t >= from.getTime()) out.push(new Date(t))
    }
    return out
  }

  if (spec.type === "once" && spec.runAtMs !== undefined) {
    const at = spec.runAtMs
    return at >= from.getTime() && at < windowEnd.getTime() ? [new Date(at)] : []
  }

  // event triggers (and malformed triggers) have no deterministic schedule.
  return []
}

/**
 * Cross-source projection over every registered scheduler source.
 *
 * The calendar and agenda used to receive the app-only `ScheduledTask[]`, so a
 * workspace whose schedule was mostly workflow triggers and backups rendered
 * an almost-empty month. They now project every source through the same
 * expansion, and each occurrence carries its `kind` so the surface can tint
 * the row by origin.
 *
 * Only `active` items are projected — a paused workflow trigger has no next
 * run, exactly as a paused app task has none. Items whose source reports a
 * `nextRunAt` but no expandable trigger (event-driven rows, opaque OS tasks)
 * still contribute that single known instant, so an OS-scheduled task is not
 * silently missing from the month.
 */
export function computeUnifiedOccurrences(
  items: readonly UnifiedScheduledItem[],
  window: OccurrenceWindow
): Occurrence[] {
  const { from, days } = window
  const maxPerTask = window.maxPerTask ?? DEFAULT_MAX_PER_TASK
  const windowEnd = new Date(from.getTime() + days * DAY_MS)
  const out: Occurrence[] = []

  for (const item of items) {
    if (item.status !== "active") continue
    const summary = item.triggerSummary
    let dates = expandSchedule(
      {
        type: summary.type,
        cron: summary.cron,
        intervalMs: summary.intervalMs,
        runAtMs: summary.runAtMs,
        timezone: summary.timezone,
        nextRunAtMs: item.nextRunAt,
      },
      from,
      windowEnd,
      maxPerTask
    )

    // Fall back to the single instant the source already knows about, so an
    // item with an opaque or event trigger is not dropped from the view.
    if (
      dates.length === 0 &&
      item.nextRunAt !== undefined &&
      item.nextRunAt >= from.getTime() &&
      item.nextRunAt < windowEnd.getTime()
    ) {
      dates = [new Date(item.nextRunAt)]
    }

    for (const date of dates) {
      out.push({
        taskId: item.unifiedId,
        taskName: item.name,
        // Unified rows have no `ScheduledTaskType`; the trigger type is the
        // only classification the shared row markup actually renders.
        taskType: "custom",
        triggerType: summary.type,
        status: "active",
        kind: item.kind,
        date,
      })
    }
  }

  out.sort((a, b) => {
    const d = a.date.getTime() - b.date.getTime()
    if (d !== 0) return d
    const n = a.taskName.localeCompare(b.taskName)
    if (n !== 0) return n
    return a.taskId.localeCompare(b.taskId)
  })

  return out
}

/** A day bucket of occurrences (local calendar day). */
export interface OccurrenceDay {
  /** Local `YYYY-MM-DD` key. */
  key: string
  /** Midnight (local) of the day. */
  date: Date
  occurrences: Occurrence[]
}

/** Local `YYYY-MM-DD` key for a date (used to bucket occurrences by day). */
export function dayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/**
 * Group a sorted occurrence list into per-day buckets (ascending). Input is
 * assumed already sorted (as returned by {@link computeUnifiedOccurrences}).
 */
export function groupOccurrencesByDay(occurrences: Occurrence[]): OccurrenceDay[] {
  const days: OccurrenceDay[] = []
  let current: OccurrenceDay | null = null

  for (const occ of occurrences) {
    const key = dayKey(occ.date)
    if (!current || current.key !== key) {
      const midnight = new Date(occ.date)
      midnight.setHours(0, 0, 0, 0)
      current = { key, date: midnight, occurrences: [] }
      days.push(current)
    }
    current.occurrences.push(occ)
  }

  return days
}

/**
 * Every projected run of a single task inside one bucket (normally one day).
 * Collapsing per task is what keeps a high-frequency trigger (every 5 minutes)
 * from rendering as N visually identical rows in the calendar / timeline.
 */
export interface OccurrenceTaskGroup {
  taskId: string
  taskName: string
  taskType: ScheduledTaskType
  triggerType: ScheduledTask["trigger"]["type"]
  status: ScheduledTaskStatus
  kind: ScheduledItemKind
  /** Ascending, de-duplicated run instants for this task in the bucket. */
  times: Date[]
}

/**
 * Collapse a sorted occurrence list into one entry per task, preserving the
 * input order (i.e. groups are ordered by each task's earliest run). Exact
 * duplicate instants for the same task are dropped — two triggers can project
 * onto the same minute, and the user should see that run once.
 */
export function groupOccurrencesByTask(occurrences: Occurrence[]): OccurrenceTaskGroup[] {
  const byTask = new Map<string, OccurrenceTaskGroup>()

  for (const occ of occurrences) {
    const existing = byTask.get(occ.taskId)
    if (!existing) {
      byTask.set(occ.taskId, {
        taskId: occ.taskId,
        taskName: occ.taskName,
        taskType: occ.taskType,
        triggerType: occ.triggerType,
        status: occ.status,
        kind: occ.kind,
        times: [occ.date],
      })
      continue
    }
    if (existing.times.some((d) => d.getTime() === occ.date.getTime())) continue
    existing.times.push(occ.date)
  }

  return Array.from(byTask.values())
}

/** Map of `YYYY-MM-DD` → occurrence count, for calendar density rendering. */
export function countOccurrencesByDay(occurrences: Occurrence[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const occ of occurrences) {
    const key = dayKey(occ.date)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}
