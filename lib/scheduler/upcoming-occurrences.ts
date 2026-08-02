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
import { getNextCronTimes } from "./cron-parser"

/** A single projected future run of a task. */
export interface Occurrence {
  taskId: string
  taskName: string
  taskType: ScheduledTaskType
  triggerType: ScheduledTask["trigger"]["type"]
  status: ScheduledTaskStatus
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
 * Project the concrete future run instants of every active task inside the
 * window, sorted ascending by date. Stable: ties broken by task name then id.
 */
export function computeUpcomingOccurrences(
  tasks: ScheduledTask[],
  window: OccurrenceWindow
): Occurrence[] {
  const { from, days } = window
  const maxPerTask = window.maxPerTask ?? DEFAULT_MAX_PER_TASK
  const windowEnd = new Date(from.getTime() + days * DAY_MS)
  const out: Occurrence[] = []

  for (const task of tasks) {
    if (task.status !== "active") continue
    const dates = expandTrigger(task, from, windowEnd, maxPerTask)
    for (const date of dates) {
      out.push({
        taskId: task.id,
        taskName: task.name,
        taskType: task.type,
        triggerType: task.trigger.type,
        status: task.status,
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

/** Expand a single task's trigger into in-window run instants. */
function expandTrigger(
  task: ScheduledTask,
  from: Date,
  windowEnd: Date,
  maxPerTask: number
): Date[] {
  const { trigger } = task

  if (trigger.type === "cron" && trigger.cronExpression) {
    // Enumerate up to maxPerTask future fires, then keep those in the window.
    return getNextCronTimes(trigger.cronExpression, maxPerTask, from, trigger.timezone).filter(
      (d) => d >= from && d < windowEnd
    )
  }

  if (trigger.type === "interval" && trigger.intervalMs && trigger.intervalMs > 0) {
    const out: Date[] = []
    // Anchor on the task's known next run when it is still in the future;
    // otherwise step forward from the window start. This keeps the projected
    // phase aligned with what the scheduler will actually do.
    const anchorMs =
      task.nextRunAt && task.nextRunAt.getTime() > from.getTime()
        ? task.nextRunAt.getTime()
        : from.getTime() + trigger.intervalMs
    for (
      let t = anchorMs;
      t < windowEnd.getTime() && out.length < maxPerTask;
      t += trigger.intervalMs
    ) {
      if (t >= from.getTime()) out.push(new Date(t))
    }
    return out
  }

  if (trigger.type === "once" && trigger.runAt) {
    const at = trigger.runAt
    return at >= from && at < windowEnd ? [new Date(at.getTime())] : []
  }

  // event triggers (and malformed triggers) have no deterministic schedule.
  return []
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
 * assumed already sorted (as returned by {@link computeUpcomingOccurrences}).
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
