/**
 * Pure helpers for scheduler runtime policy decisions: overlap policy
 * resolution (with legacy `allowConcurrent` fallback), scheduling jitter,
 * lifecycle limits (endAt / maxRuns), and the time-based catch-up window.
 *
 * Kept side-effect free so the engine (`task-scheduler.ts`) can be tested
 * against deterministic inputs.
 */

import type { ScheduledTask, TaskExecutionConfig, TaskOverlapPolicy } from "@/types/scheduler"

/**
 * Resolve the effective overlap policy for a task config.
 * Explicit `overlapPolicy` wins; otherwise the legacy boolean maps
 * `allowConcurrent: true` → "allow", anything else → "skip".
 */
export function resolveOverlapPolicy(config: TaskExecutionConfig): TaskOverlapPolicy {
  if (config.overlapPolicy) return config.overlapPolicy
  return config.allowConcurrent ? "allow" : "skip"
}

/**
 * Apply random scheduling jitter to an armed fire time. Returns
 * `baseMs + floor(rng() * (jitterMs + 1))`, i.e. a uniform offset in
 * [0, jitterMs]. Non-positive / undefined jitter returns the base unchanged.
 * The canonical slot must never be jittered — only the armed epoch.
 */
export function applyJitter(
  baseMs: number,
  jitterMs: number | undefined,
  rng: () => number = Math.random
): number {
  if (!jitterMs || jitterMs <= 0) return baseMs
  return baseMs + Math.floor(rng() * (jitterMs + 1))
}

/** Whether the task's `endAt` bound has passed (inclusive). */
export function isPastEndAt(task: ScheduledTask, now: Date): boolean {
  return task.endAt instanceof Date && now.getTime() >= task.endAt.getTime()
}

/** Whether the task has consumed its `maxRuns` budget (failures count). */
export function isAtMaxRuns(task: ScheduledTask): boolean {
  const maxRuns = task.config.maxRuns
  if (typeof maxRuns !== "number" || maxRuns <= 0) return false
  return task.runCount >= maxRuns
}

/**
 * Whether a missed slot is older than the catch-up window and should be
 * skipped ("catchup-window-expired") instead of re-run. Undefined or
 * non-positive window = unlimited (today's behavior).
 */
export function isSlotOutsideCatchupWindow(
  slot: Date,
  now: Date,
  catchupWindowMs: number | undefined
): boolean {
  if (typeof catchupWindowMs !== "number" || catchupWindowMs <= 0) return false
  return now.getTime() - slot.getTime() > catchupWindowMs
}
