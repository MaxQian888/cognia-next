/**
 * Scheduled occurrences (ADR-0224 A9).
 *
 * A scheduled task's occurrence is its slot: the instant the schedule named.
 * Everything that identifies a scheduled run is derived from the slot, never
 * from when a host got around to it, so a run fired late (a laptop that slept
 * through the slot, an OS wake that came minutes after it) keeps the identity
 * of the slot it belongs to.
 *
 * - {@link scheduledOccurrenceExecutionId} gives an automatic fire of a slot a
 *   deterministic execution id, so the second fire of the same slot on this
 *   host finds the first one's row instead of running again.
 * - {@link latestElapsedSlot} names the slot an OS-promoted wake belongs to.
 * - {@link scheduledBotTickRecordId} keys a Bot's timed tick on its slot.
 */

import { alignOccurrenceInstant } from "@/lib/workflow/runtime/trigger-idempotency"
import type { TaskExecutionTriggerSource } from "@/types/scheduler"

/**
 * Trigger sources that fire a slot on their own. A run-now, a backfill, a
 * retry or an event is a start somebody asked for, and two of them are two
 * runs.
 */
const SLOT_FIRE_SOURCES: ReadonlySet<TaskExecutionTriggerSource> = new Set(["schedule", "catch-up"])

/**
 * The execution id of an automatic fire of a slot, or `undefined` for a start
 * that is not one. The id holds only characters a file name can, because
 * task workspaces name directories after executions.
 */
export function scheduledOccurrenceExecutionId(input: {
  taskId: string
  triggerSource: TaskExecutionTriggerSource
  scheduledFor?: Date
}): string | undefined {
  if (!SLOT_FIRE_SOURCES.has(input.triggerSource)) return undefined
  const slot = input.scheduledFor?.getTime()
  if (slot === undefined || !Number.isFinite(slot)) return undefined
  return `occ-${input.taskId}-${alignOccurrenceInstant(slot)}`
}

/** Longest walk through a schedule's slots before giving up. */
const MAX_SLOT_STEPS = 100_000

/**
 * The latest slot at or before `now`, walking forward from the task's
 * persisted `nextRunAt`. `undefined` when no slot has elapsed (the wake came
 * early or the schedule has no slot due), so the caller decides what an
 * unanchored wake means.
 */
export function latestElapsedSlot(input: {
  nextRunAt: Date | undefined
  now: Date
  next: (after: Date) => Date | undefined
}): Date | undefined {
  let slot = input.nextRunAt
  if (!slot || slot.getTime() > input.now.getTime()) return undefined
  for (let step = 0; step < MAX_SLOT_STEPS; step += 1) {
    const following = input.next(slot)
    if (!following || following.getTime() > input.now.getTime()) return slot
    if (following.getTime() <= slot.getTime()) return slot
    slot = following
  }
  return slot
}

/**
 * The source record id of a Bot's timed tick. A tick fired for a slot is that
 * slot's, so a second fire of the same slot lands on the same delivery. A
 * tick started by hand, or a retry (whose `scheduledFor` is the retry time,
 * not a slot), is its own event.
 */
export function scheduledBotTickRecordId(input: {
  installationId: string
  triggerId: string
  triggerSource: TaskExecutionTriggerSource
  scheduledFor?: Date
  oneOff: (prefix: string) => string
}): string {
  const prefix = `${input.installationId}-${input.triggerId}`
  const slot = input.scheduledFor?.getTime()
  if (SLOT_FIRE_SOURCES.has(input.triggerSource) && slot !== undefined && Number.isFinite(slot)) {
    return `${prefix}@${alignOccurrenceInstant(slot)}`
  }
  return input.oneOff(prefix)
}
