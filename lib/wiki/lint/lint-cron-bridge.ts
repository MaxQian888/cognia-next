/**
 * Wiki-lint cron-bridge — reconciles `ExternalBridgeSettings.wikiLintSchedule`
 * with the single `wiki-lint::singleton` scheduler row. Mirrors
 * `lib/wiki/schedule/cron-bridge.ts` (and reuses its `resolveCronExpression`);
 * an `mode === "off"` schedule deletes the row.
 */

import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { validateCronExpression } from "@/lib/scheduler/cron-parser"
import { resolveCronExpression } from "@/lib/wiki/schedule/cron-bridge"
import type { ScheduledTask, TaskExecutionConfig, TaskNotificationConfig } from "@/types/scheduler"
import type { WikiScheduleSettings } from "@/types/wiki"

export const WIKI_LINT_TASK_ID = "wiki-lint::singleton"

function defaultConfig(): TaskExecutionConfig {
  return {
    timeout: 5 * 60_000, // lint is a fast local pass
    maxRetries: 1,
    retryDelay: 60_000,
    maxRetryDelay: 10 * 60_000,
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
    id: WIKI_LINT_TASK_ID,
    name: "External Bridge — wiki lint",
    description: "Cron-driven wiki health check (orphan pages + broken links).",
    type: "wiki-lint",
    trigger: {
      type: "cron",
      cronExpression,
      timezone: schedule.timezone,
    },
    payload: {},
    config: existing?.config ?? defaultConfig(),
    notification: existing?.notification ?? defaultNotification(),
    status: "active",
    tags: existing?.tags ?? ["external-bridge", "wiki", "lint"],
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

export interface SyncWikiLintCronResult {
  action: "created" | "updated" | "deleted" | "skipped" | "invalid"
  invalidExpression?: string
}

export async function syncWikiLintCronToScheduler(
  schedule: WikiScheduleSettings | undefined
): Promise<SyncWikiLintCronResult> {
  const existing = await schedulerDb.getTask(WIKI_LINT_TASK_ID)

  if (!schedule || schedule.mode === "off") {
    if (existing) {
      await schedulerDb.deleteTask(WIKI_LINT_TASK_ID)
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

  const cronExpression = resolveCronExpression(schedule)
  if (cronExpression === null) return { action: "skipped" }

  const next = buildTask(cronExpression, schedule, existing)
  if (existing) {
    await schedulerDb.updateTask(next)
    return { action: "updated" }
  }
  await schedulerDb.createTask(next)
  return { action: "created" }
}
