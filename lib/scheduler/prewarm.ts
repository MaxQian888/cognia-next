/**
 * Warming a scheduled task shortly before it is due.
 *
 * A schedule knows exactly when it will next run, which an interactive turn
 * never does. The work every run of a task type pays before it can do anything
 * useful (loading the executor's code, starting the agent host) can therefore
 * be done a little ahead, off the run's critical path, the way a pool of
 * pre-started workers takes cold start off a resume.
 *
 * The prewarm is armed through the same timing driver as the fire itself, so
 * it survives a hidden webview exactly as well as the run does, under an alarm
 * id of its own (`prewarm:<taskId>`) that the scheduler routes separately.
 *
 * A prewarm is strictly best-effort and must be idempotent: it never records
 * an execution, never consumes a slot, and a failure is logged and forgotten.
 * The run re-does anything the prewarm did not finish. Work whose effects need
 * the run's own workspace turn (environment setup writes into a leased root)
 * does not belong here.
 */

import type { ScheduledTask, ScheduledTaskType } from "@/types/scheduler"

/** How far ahead of the armed fire instant the prewarm is armed. */
export const PREWARM_LEAD_MS = 2 * 60_000

/** Not worth a separate alarm when the fire is closer than this. */
export const PREWARM_MIN_LEAD_MS = 5_000

/** A prewarm that has not settled by then is abandoned (its work continues on the run). */
export const PREWARM_TIMEOUT_MS = 5 * 60_000

const PREWARM_ALARM_PREFIX = "prewarm:"

/** Idempotent per task type. Must honour `signal` between steps. */
export type TaskPrewarmer = (task: ScheduledTask, signal: AbortSignal) => Promise<void>

const prewarmers = new Map<string, TaskPrewarmer>()

export function registerTaskPrewarmer(
  type: ScheduledTaskType | string,
  prewarmer: TaskPrewarmer
): void {
  prewarmers.set(type, prewarmer)
}

export function unregisterTaskPrewarmer(type: ScheduledTaskType | string): void {
  prewarmers.delete(type)
}

export function getTaskPrewarmer(type: string): TaskPrewarmer | undefined {
  return prewarmers.get(type)
}

export function prewarmAlarmId(taskId: string): string {
  return `${PREWARM_ALARM_PREFIX}${taskId}`
}

/** The task id a prewarm alarm belongs to, or `null` for an ordinary task alarm. */
export function parsePrewarmAlarmId(alarmId: string): string | null {
  return alarmId.startsWith(PREWARM_ALARM_PREFIX)
    ? alarmId.slice(PREWARM_ALARM_PREFIX.length) || null
    : null
}

/**
 * When to prewarm a fire armed for `fireAtMs`, or `null` when it is too close
 * to bother. A fire closer than the lead is prewarmed right away rather than
 * skipped: a two-minute interval still gets its host started before it runs.
 */
export function planPrewarmAt(fireAtMs: number, nowMs: number): number | null {
  if (fireAtMs - nowMs < PREWARM_MIN_LEAD_MS) return null
  return Math.max(nowMs, fireAtMs - PREWARM_LEAD_MS)
}
