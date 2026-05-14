/**
 * Twin cron-bridge (M5).
 *
 * Reconciles the user-authored `TwinRuntimeSettings.cron` field with the
 * scheduler's task table. Each twin can carry up to two scheduled tasks:
 *
 *   • <twinId>::ingest   — cron-driven `enqueueIngestJob`
 *   • <twinId>::distill  — cron-driven `enqueueDistillJob`
 *
 * The bridge is idempotent: call `syncTwinCronToScheduler` whenever the
 * settings row changes, and the scheduler row converges to match. An
 * empty schedule (or `enabled: false`) deletes the row.
 *
 * The actual cron firing happens inside the existing TS scheduler
 * (`lib/scheduler/task-scheduler.ts`) — on Tauri this is reinforced by
 * the workflow Rust daemon, but the TS path is what drives the Twin
 * executor in either runtime.
 */

import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { validateCronExpression } from "@/lib/scheduler/cron-parser"
import type { ScheduledTask, TaskExecutionConfig, TaskNotificationConfig } from "@/types/scheduler"
import type { TwinCronSettings } from "@/types/twin"

/** Suffix used to derive the per-side task id from a twinId. */
const INGEST_SUFFIX = "::ingest"
const DISTILL_SUFFIX = "::distill"

function defaultConfig(): TaskExecutionConfig {
  return {
    timeout: 600_000,
    maxRetries: 2,
    retryDelay: 30_000,
    maxRetryDelay: 600_000,
    runMissedOnStartup: false,
    allowConcurrent: false,
  }
}

function defaultNotification(): TaskNotificationConfig {
  return { onStart: false, onComplete: false, onError: true }
}

function buildTask(
  twinId: string,
  kind: "ingest" | "distill",
  cronExpression: string,
  timezone: string | undefined,
  existing: ScheduledTask | null
): ScheduledTask {
  const id = `twin::${twinId}${kind === "ingest" ? INGEST_SUFFIX : DISTILL_SUFFIX}`
  const now = new Date()
  return {
    id,
    name: kind === "ingest" ? `Twin ${twinId} — auto-ingest` : `Twin ${twinId} — auto-distill`,
    description: `Cron-driven ${kind} for twin ${twinId} (M5 cron-bridge).`,
    type: "twin",
    trigger: {
      type: "cron",
      cronExpression,
      timezone,
    },
    payload: { twinId, kind },
    config: existing?.config ?? defaultConfig(),
    notification: existing?.notification ?? defaultNotification(),
    status: "active",
    tags: existing?.tags ?? ["twin", twinId],
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

export interface SyncTwinCronResult {
  ingest: "created" | "updated" | "deleted" | "skipped"
  distill: "created" | "updated" | "deleted" | "skipped"
  invalidExpressions: string[]
}

/**
 * Reconcile the scheduler tasks for one twin against its current
 * `TwinCronSettings`. Idempotent — safe to call on every settings save.
 *
 * When `cron` is `undefined` or `enabled === false`, both task rows are
 * deleted. Individual sides can be turned off by setting their cron
 * expression to `""`.
 */
export async function syncTwinCronToScheduler(
  twinId: string,
  cron: TwinCronSettings | undefined
): Promise<SyncTwinCronResult> {
  const ingestId = `twin::${twinId}${INGEST_SUFFIX}`
  const distillId = `twin::${twinId}${DISTILL_SUFFIX}`
  const existingIngest = await schedulerDb.getTask(ingestId)
  const existingDistill = await schedulerDb.getTask(distillId)
  const result: SyncTwinCronResult = {
    ingest: "skipped",
    distill: "skipped",
    invalidExpressions: [],
  }
  const enabled = Boolean(cron?.enabled)

  // ───── Ingest side ─────
  const ingestExpr = cron?.ingestSchedule?.trim() ?? ""
  if (enabled && ingestExpr) {
    if (!validateCronExpression(ingestExpr).valid) {
      result.invalidExpressions.push(`ingest: ${ingestExpr}`)
    } else {
      const next = buildTask(twinId, "ingest", ingestExpr, cron?.timezone, existingIngest)
      if (existingIngest) {
        await schedulerDb.updateTask(next)
        result.ingest = "updated"
      } else {
        await schedulerDb.createTask(next)
        result.ingest = "created"
      }
    }
  } else if (existingIngest) {
    await schedulerDb.deleteTask(ingestId)
    result.ingest = "deleted"
  }

  // ───── Distill side ─────
  const distillExpr = cron?.distillSchedule?.trim() ?? ""
  if (enabled && distillExpr) {
    if (!validateCronExpression(distillExpr).valid) {
      result.invalidExpressions.push(`distill: ${distillExpr}`)
    } else {
      const next = buildTask(twinId, "distill", distillExpr, cron?.timezone, existingDistill)
      if (existingDistill) {
        await schedulerDb.updateTask(next)
        result.distill = "updated"
      } else {
        await schedulerDb.createTask(next)
        result.distill = "created"
      }
    }
  } else if (existingDistill) {
    await schedulerDb.deleteTask(distillId)
    result.distill = "deleted"
  }

  return result
}

/** Cron preset shortcuts the Settings UI exposes. Plain strings only. */
export const CRON_PRESETS = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at 03:00", value: "0 3 * * *" },
  { label: "Weekly Mon 09:00", value: "0 9 * * 1" },
] as const

export type CronPreset = (typeof CRON_PRESETS)[number]
