/**
 * Attention Radar cron-bridge — reconciles `AppSettings.attentionRadar.schedule`
 * with the single `radar-report::singleton` scheduler row. Mirrors
 * `lib/wiki/schedule/cron-bridge.ts`; `mode === "off"` deletes the row.
 */

import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { validateCronExpression } from "@/lib/scheduler/cron-parser"
import type { ScheduledTask, TaskExecutionConfig, TaskNotificationConfig } from "@/types/scheduler"
import type { RadarScheduleSettings } from "@/types/radar"

export const RADAR_REPORT_TASK_ID = "radar-report::singleton"

const DAILY_CRON = "0 9 * * *" // 09:00 daily — a "morning briefing" feel
const WEEKLY_CRON = "0 9 * * 1" // 09:00 every Monday

export function resolveRadarCron(schedule: RadarScheduleSettings): string | null {
  switch (schedule.mode) {
    case "off":
      return null
    case "daily":
      return DAILY_CRON
    case "weekly":
      return WEEKLY_CRON
    case "custom": {
      const expr = schedule.customCron?.trim() ?? ""
      if (!expr || !validateCronExpression(expr).valid) return null
      return expr
    }
  }
}

function defaultConfig(): TaskExecutionConfig {
  return {
    timeout: 10 * 60_000,
    maxRetries: 1,
    retryDelay: 5 * 60_000,
    maxRetryDelay: 30 * 60_000,
    runMissedOnStartup: false,
    allowConcurrent: false,
  }
}

function defaultNotification(): TaskNotificationConfig {
  return { onStart: false, onComplete: false, onError: true }
}

function buildTask(
  cronExpression: string,
  schedule: RadarScheduleSettings,
  existing: ScheduledTask | null
): ScheduledTask {
  const now = new Date()
  return {
    id: RADAR_REPORT_TASK_ID,
    name: "Attention Radar — periodic report",
    description: "Cron-driven info-diet analysis over recent memories + captures.",
    type: "radar-report",
    trigger: { type: "cron", cronExpression, timezone: schedule.timezone },
    payload: {},
    config: existing?.config ?? defaultConfig(),
    notification: existing?.notification ?? defaultNotification(),
    status: "active",
    tags: existing?.tags ?? ["radar", "insights"],
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

export interface SyncRadarCronResult {
  action: "created" | "updated" | "deleted" | "skipped" | "invalid"
  invalidExpression?: string
}

export async function syncRadarCronToScheduler(
  schedule: RadarScheduleSettings | undefined
): Promise<SyncRadarCronResult> {
  const existing = await schedulerDb.getTask(RADAR_REPORT_TASK_ID)

  if (!schedule || schedule.mode === "off") {
    if (existing) {
      await schedulerDb.deleteTask(RADAR_REPORT_TASK_ID)
      return { action: "deleted" }
    }
    return { action: "skipped" }
  }

  if (schedule.mode === "custom") {
    const raw = schedule.customCron?.trim() ?? ""
    if (!raw) return { action: "skipped" }
    if (!validateCronExpression(raw).valid) {
      return { action: "invalid", invalidExpression: raw }
    }
  }

  const cronExpression = resolveRadarCron(schedule)
  if (cronExpression === null) return { action: "skipped" }

  const next = buildTask(cronExpression, schedule, existing)
  if (existing) {
    await schedulerDb.updateTask(next)
    return { action: "updated" }
  }
  await schedulerDb.createTask(next)
  return { action: "created" }
}
