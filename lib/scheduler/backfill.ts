/**
 * Backfill slot enumeration — pure helpers for re-running past schedule slots
 * over a [start, end] range (Temporal backfill semantics).
 *
 * Only cron and interval triggers have a deterministic historical schedule;
 * once/event triggers enumerate to an empty list. The engine method
 * `backfillTask` (task-scheduler.ts) executes the enumerated slots
 * sequentially with `triggerSource: "backfill"` and never touches the live
 * `nextRunAt` cadence. The UI uses this enumerator for its slot-count preview.
 */

import type { ScheduledTask } from "@/types/scheduler"
import { getNextCronTime } from "./cron-parser"

/** Hard cap on enumerated slots to prevent runaway ranges. */
export const BACKFILL_MAX_SLOTS = 1000

/**
 * Enumerate the schedule slots of `task` that fall inside [start, end]
 * (inclusive), oldest first, capped at `maxSlots`.
 *
 * - cron: walks `getNextCronTime` from just before `start` (timezone-aware).
 * - interval: phase-anchored on `createdAt` (the same base
 *   `calculateNextRunTime` uses), slots at `createdAt + k*intervalMs`, k ≥ 1.
 * - once/event: no deterministic historical schedule → empty.
 * - `end` before `start`: empty.
 */
export function enumerateBackfillSlots(
  task: ScheduledTask,
  start: Date,
  end: Date,
  maxSlots: number = BACKFILL_MAX_SLOTS
): Date[] {
  if (end.getTime() < start.getTime() || maxSlots <= 0) return []
  const trigger = task.trigger

  if (trigger.type === "cron" && trigger.cronExpression) {
    const slots: Date[] = []
    // getNextCronTime returns the next occurrence strictly after the cursor,
    // so starting 1ms early makes `start` itself eligible.
    let cursor = new Date(start.getTime() - 1)
    while (slots.length < maxSlots) {
      const next = getNextCronTime(trigger.cronExpression, cursor, trigger.timezone)
      if (!next || next.getTime() > end.getTime()) break
      slots.push(next)
      cursor = next
    }
    return slots
  }

  if (trigger.type === "interval" && trigger.intervalMs && trigger.intervalMs > 0) {
    const intervalMs = trigger.intervalMs
    const baseMs = task.createdAt.getTime()
    // First slot is base + 1 interval; find the first k whose slot is >= start.
    const k0 = Math.max(1, Math.ceil((start.getTime() - baseMs) / intervalMs))
    const slots: Date[] = []
    for (
      let t = baseMs + k0 * intervalMs;
      t <= end.getTime() && slots.length < maxSlots;
      t += intervalMs
    ) {
      if (t >= start.getTime()) slots.push(new Date(t))
    }
    return slots
  }

  return []
}
