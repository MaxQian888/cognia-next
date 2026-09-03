/**
 * Stored row shapes for the scheduler's two tables (schema v219).
 *
 * These live here rather than in `lib/scheduler/scheduler-db.ts` because
 * `schema.ts` needs them to type the `Table<...>` handles, and the scheduler
 * module imports `getDb()` from `schema.ts`. A value import in the other
 * direction would close a cycle, so a types-only module breaks it.
 *
 * Every field except the indexed ones is encrypted at rest: the table is
 * declared `contentProtection: "encrypted-content"` in
 * `lib/data-governance/table-catalog.ts`, and
 * `lib/db/encrypted-content-middleware.ts` keeps only the indexed property
 * roots in plaintext metadata. So `payload` (prompts, objectives),
 * `notification` (webhook URLs, IM targets), `trigger`, `config` and
 * `lastError` never touch the disk in the clear, while `[status+nextRunAt]`
 * and friends stay queryable.
 */

/** A scheduled task as persisted. Dates are ISO strings, objects are JSON. */
export interface DBScheduledTask {
  id: string
  name: string
  description?: string
  type: string
  trigger: string // JSON serialized TaskTrigger
  /** Denormalized event trigger discriminator for the `[status+eventType]` index. */
  eventType: string
  payload?: string // JSON serialized Record<string, unknown>
  config: string // JSON serialized TaskExecutionConfig
  notification: string // JSON serialized TaskNotificationConfig
  createdBy?: string // JSON serialized ScheduledTaskCreator
  /**
   * Denormalized `createdBy.kind` for the `[createdBySource+status]` index.
   *
   * `createdBy` is an encrypted JSON blob, so a per-source quota
   * (`SchedulerPermissionPolicy.maxTasksPerSource`) cannot be answered without
   * this column. Counting it in JavaScript would mean decrypting every row on
   * every agent write. Same technique the `eventType` column already uses.
   */
  createdBySource: string
  /** Owning workspace. Soft FK onto `projects`. */
  projectId?: string
  status: string
  tags?: string // JSON serialized string[]
  endAt?: string // ISO date string
  promotion?: string // JSON serialized ScheduledTaskPromotion (promotedAt as ISO)
  onSuccessTaskIds?: string // JSON serialized string[]
  onFailureTaskIds?: string // JSON serialized string[]
  consecutiveFailures?: number
  lastRunAt?: string // ISO date string
  nextRunAt?: string // ISO date string
  runCount: number
  successCount: number
  failureCount: number
  lastError?: string
  lastTerminalReason?: string
  lastTerminalAt?: string // ISO date string
  createdAt: string // ISO date string
  updatedAt: string // ISO date string
}

/** One execution attempt of a scheduled task, as persisted. */
export interface DBTaskExecution {
  id: string
  taskId: string
  taskName: string
  taskType: string
  status: string
  input?: string // JSON serialized
  output?: string // JSON serialized
  error?: string
  retryAttempt: number
  duration?: number
  scheduledFor?: string // ISO date string
  triggerSource?: string
  terminalReason?: string
  retryScheduledAt?: string // ISO date string
  startedAt: string // ISO date string
  completedAt?: string // ISO date string
  logs: string // JSON serialized TaskExecutionLog[]
}
