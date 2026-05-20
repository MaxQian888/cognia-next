/**
 * Wiki rebuild cron-bridge — reconciles `ExternalBridgeSettings.wikiSchedule`
 * with the single `wiki-rebuild` scheduler row. Idempotent; safe to call on
 * every settings save. An `mode === "off"` schedule deletes the row.
 *
 * Modeled on `lib/twin/cron/cron-bridge.ts`. The row id is a fixed singleton
 * (`wiki-rebuild::singleton`) because the External Bridge owns one wiki
 * source today (cognia-self); when Phase 3 lands user-supplied repos, each
 * repo will get its own keyed row.
 */

import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { validateCronExpression } from "@/lib/scheduler/cron-parser"
import type { ScheduledTask, TaskExecutionConfig, TaskNotificationConfig } from "@/types/scheduler"
import type { WikiScheduleSettings } from "@/types/wiki"

export const WIKI_REBUILD_TASK_ID = "wiki-rebuild::singleton"

/** Preset cron expressions for the schedule UI. */
const DAILY_CRON = "0 3 * * *" // 03:00 daily
const WEEKLY_CRON = "0 3 * * 0" // 03:00 every Sunday

/**
 * Resolve a schedule's `mode` into the concrete cron expression that will
 * drive the scheduler row. Returns `null` when the mode is "off", or when
 * "custom" was selected without a valid expression — callers treat both as
 * "delete the row" and surface the invalid case via the bridge result.
 */
export function resolveCronExpression(schedule: WikiScheduleSettings): string | null {
  switch (schedule.mode) {
    case "off":
      return null
    case "daily":
      return DAILY_CRON
    case "weekly":
      return WEEKLY_CRON
    case "custom": {
      const expr = schedule.customCron?.trim() ?? ""
      if (!expr) return null
      if (!validateCronExpression(expr).valid) return null
      return expr
    }
  }
}

function defaultConfig(): TaskExecutionConfig {
  return {
    timeout: 30 * 60_000, // 30 minutes — wiki rebuilds can be long on big repos
    maxRetries: 1,
    retryDelay: 5 * 60_000,
    maxRetryDelay: 60 * 60_000,
    runMissedOnStartup: false,
    allowConcurrent: false,
  }
}

function defaultNotification(): TaskNotificationConfig {
  return { onStart: false, onComplete: false, onError: true }
}

function buildTask(
  cronExpression: string,
  schedule: WikiScheduleSettings,
  existing: ScheduledTask | null
): ScheduledTask {
  const now = new Date()
  return {
    id: WIKI_REBUILD_TASK_ID,
    name: "External Bridge — wiki rebuild",
    description: "Cron-driven Cognia wiki re-index (External Bridge).",
    type: "wiki-rebuild",
    trigger: {
      type: "cron",
      cronExpression,
      timezone: schedule.timezone,
    },
    payload: { force: schedule.force === true },
    config: existing?.config ?? defaultConfig(),
    notification: existing?.notification ?? defaultNotification(),
    status: "active",
    tags: existing?.tags ?? ["external-bridge", "wiki"],
    runCount: existing?.runCount ?? 0,
    successCount: existing?.successCount ?? 0,
    failureCount: existing?.failureCount ?? 0,
    lastError: existing?.lastError,
    lastRunAt: existing?.lastRunAt,
    nextRunAt: existing?.nextRunAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export interface SyncWikiCronResult {
  action: "created" | "updated" | "deleted" | "skipped" | "invalid"
  invalidExpression?: string
}

export async function syncWikiCronToScheduler(
  schedule: WikiScheduleSettings | undefined
): Promise<SyncWikiCronResult> {
  const existing = await schedulerDb.getTask(WIKI_REBUILD_TASK_ID)

  if (!schedule || schedule.mode === "off") {
    if (existing) {
      await schedulerDb.deleteTask(WIKI_REBUILD_TASK_ID)
      return { action: "deleted" }
    }
    return { action: "skipped" }
  }

  if (schedule.mode === "custom") {
    const raw = schedule.customCron?.trim() ?? ""
    if (!raw) return { action: "skipped" }
    if (!validateCronExpression(raw).valid) {
      // Leave any existing row alone; surface the validation error so the
      // UI can show the user a precise message instead of silently dropping
      // the bad expression.
      return { action: "invalid", invalidExpression: raw }
    }
  }

  const cronExpression = resolveCronExpression(schedule)
  if (cronExpression === null) {
    // Unreachable in practice — we handled "off" above and "custom" with a
    // bad expression returns "invalid" before getting here — defensive
    // return keeps the bridge total.
    return { action: "skipped" }
  }

  const next = buildTask(cronExpression, schedule, existing)
  if (existing) {
    await schedulerDb.updateTask(next)
    return { action: "updated" }
  }
  await schedulerDb.createTask(next)
  return { action: "created" }
}
