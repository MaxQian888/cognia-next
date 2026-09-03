// Fixture builders for scheduler stories. Each builder returns a fully-valid
// object with realistic defaults; spread `over` to vary individual fields.
// Builders are deterministic (fixed base timestamps) so snapshots stay stable
// across renders, and dependency-free beyond the scheduler type module.
import type {
  ScheduledTask,
  ScheduledTaskType,
  TaskExecution,
  TaskExecutionLog,
  TaskExecutionStatus,
  TaskStatistics,
  TaskTrigger,
  TaskNotificationConfig,
  TaskExecutionConfig,
} from "@/types/scheduler"
import { DEFAULT_EXECUTION_CONFIG, DEFAULT_NOTIFICATION_CONFIG } from "@/types/scheduler"
import type {
  UnifiedScheduledItem,
  ScheduledItemKind,
  UnifiedItemStatus,
} from "@/types/scheduler/unified"
import { makeUnifiedId } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun, UnifiedRunStatus } from "@/types/scheduler/unified-runs"
import type {
  SystemTask,
  SystemTaskTrigger,
  SystemTaskAction,
} from "@/types/scheduler/system-scheduler"

// Fixed reference instant: 2026-06-01T09:00:00Z — keeps relative-time output stable.
const BASE = new Date("2026-06-01T09:00:00.000Z").getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

let taskSeq = 0
let execSeq = 0
let logSeq = 0

/** A cron trigger that fires every weekday at 9am. */
export function makeCronTrigger(over: Partial<TaskTrigger> = {}): TaskTrigger {
  return {
    type: "cron",
    cronExpression: "0 9 * * 1-5",
    timezone: "UTC",
    ...over,
  }
}

export function makeNotificationConfig(
  over: Partial<TaskNotificationConfig> = {}
): TaskNotificationConfig {
  return { ...DEFAULT_NOTIFICATION_CONFIG, ...over }
}

export function makeExecutionConfig(over: Partial<TaskExecutionConfig> = {}): TaskExecutionConfig {
  return { ...DEFAULT_EXECUTION_CONFIG, ...over }
}

/** Build a fully-populated `ScheduledTask` (app scheduler row). */
export function makeScheduledTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  taskSeq += 1
  const type: ScheduledTaskType = over.type ?? "chat"
  return {
    id: `task-${taskSeq}`,
    name: `Daily standup digest ${taskSeq}`,
    description: "Summarize overnight activity and post a digest.",
    type,
    trigger: makeCronTrigger(),
    payload: { prompt: "Summarize the overnight activity in three bullet points." },
    config: makeExecutionConfig(),
    notification: makeNotificationConfig(),
    status: "active",
    tags: ["digest", "daily"],
    runCount: 42,
    successCount: 40,
    failureCount: 2,
    lastRunAt: new Date(BASE - DAY),
    nextRunAt: new Date(BASE + DAY),
    lastError: undefined,
    createdAt: new Date(BASE - 30 * DAY),
    updatedAt: new Date(BASE - DAY),
    ...over,
  }
}

const LOG_LEVELS: TaskExecutionLog["level"][] = ["info", "warn", "error", "debug"]

export function makeExecutionLog(over: Partial<TaskExecutionLog> = {}): TaskExecutionLog {
  logSeq += 1
  return {
    id: `log-${logSeq}`,
    timestamp: new Date(BASE - HOUR + logSeq * MINUTE),
    level: LOG_LEVELS[logSeq % LOG_LEVELS.length],
    message: `Execution step ${logSeq} completed`,
    ...over,
  }
}

/** Build a `TaskExecution` record. Defaults to a completed run. */
export function makeTaskExecution(over: Partial<TaskExecution> = {}): TaskExecution {
  execSeq += 1
  const status: TaskExecutionStatus = over.status ?? "completed"
  const startedAt = over.startedAt ?? new Date(BASE - execSeq * HOUR)
  return {
    id: `exec-${execSeq}`,
    taskId: "task-1",
    taskName: "Daily standup digest",
    taskType: "chat",
    status,
    retryAttempt: 0,
    duration: 1_850,
    triggerSource: "schedule",
    startedAt,
    completedAt:
      status === "running" || status === "pending"
        ? undefined
        : new Date(startedAt.getTime() + 1_850),
    error: status === "failed" ? "Sidecar request timed out after 30s" : undefined,
    logs: [makeExecutionLog(), makeExecutionLog({ level: "info", message: "Done" })],
    ...over,
  }
}

export function makeTaskStatistics(over: Partial<TaskStatistics> = {}): TaskStatistics {
  return {
    totalTasks: 12,
    activeTasks: 8,
    pausedTasks: 4,
    totalExecutions: 340,
    successfulExecutions: 318,
    failedExecutions: 22,
    averageDuration: 2_140,
    upcomingExecutions: 6,
    ...over,
  }
}

let unifiedSeq = 0

/** Build a `UnifiedScheduledItem` for the cross-source scheduler page. */
export function makeUnifiedItem(over: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  unifiedSeq += 1
  const kind: ScheduledItemKind = over.kind ?? "app"
  const sourceId = over.sourceId ?? `src-${unifiedSeq}`
  const status: UnifiedItemStatus = over.status ?? "active"
  return {
    unifiedId: over.unifiedId ?? makeUnifiedId(kind, sourceId),
    kind,
    sourceId,
    name: `Scheduled item ${unifiedSeq}`,
    description: "A normalized cross-source scheduled item.",
    status,
    triggerSummary: { type: "cron", cron: "0 9 * * 1-5", timezone: "UTC" },
    nextRunAt: BASE + DAY,
    lastRunAt: BASE - DAY,
    successCount: 40,
    failureCount: 2,
    origin: { tableName: "scheduledTasks", deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...over,
  }
}

/** A small mixed set of unified items spanning every kind. */
export function makeUnifiedItemSet(): UnifiedScheduledItem[] {
  return [
    makeUnifiedItem({ kind: "app", name: "Overnight digest", status: "active" }),
    makeUnifiedItem({
      kind: "workflow",
      name: "Nightly ETL workflow",
      status: "active",
      triggerSummary: { type: "interval", intervalMs: 6 * HOUR },
    }),
    makeUnifiedItem({
      kind: "backup",
      name: "Weekly full backup",
      status: "paused",
      capabilities: { runNow: true, pause: true, edit: true, delete: false },
    }),
    makeUnifiedItem({ kind: "plugin", name: "Clipboard sweep", status: "active" }),
    makeUnifiedItem({
      kind: "system",
      name: "OS health check",
      status: "active",
      capabilities: { runNow: false, pause: false, edit: false, delete: true },
      triggerSummary: { type: "cron", cron: "0 */6 * * *" },
    }),
    makeUnifiedItem({
      kind: "connector",
      name: "Slack daily summary",
      status: "active",
      triggerSummary: { type: "once", runAtMs: BASE + 2 * DAY },
    }),
  ]
}

let unifiedRunSeq = 0

/** Build a `UnifiedExecutionRun` — the cross-source run record. */
export function makeUnifiedRun(over: Partial<UnifiedExecutionRun> = {}): UnifiedExecutionRun {
  unifiedRunSeq += 1
  const kind: ScheduledItemKind = over.kind ?? "app"
  const status: UnifiedRunStatus = over.status ?? "succeeded"
  const startedAt = over.startedAt ?? BASE - unifiedRunSeq * HOUR
  return {
    unifiedId: makeUnifiedId(kind, `run-${unifiedRunSeq}`),
    kind,
    itemUnifiedId: makeUnifiedId(kind, `src-${unifiedRunSeq}`),
    itemName: `Scheduled item ${unifiedRunSeq}`,
    status,
    startedAt,
    finishedAt: status === "running" ? undefined : startedAt + 1_850,
    durationMs: status === "running" ? undefined : 1_850,
    origin: { tableName: "scheduledTaskRuns", nativeId: `run-${unifiedRunSeq}` },
    ...over,
  }
}

/** A small mixed set of unified runs spanning several kinds and outcomes. */
export function makeUnifiedRunSet(): UnifiedExecutionRun[] {
  return [
    makeUnifiedRun({ kind: "app", itemName: "Overnight digest", status: "succeeded" }),
    makeUnifiedRun({ kind: "workflow", itemName: "Nightly ETL workflow", status: "failed" }),
    makeUnifiedRun({ kind: "backup", itemName: "Weekly full backup", status: "succeeded" }),
    makeUnifiedRun({ kind: "connector", itemName: "Slack daily summary", status: "running" }),
  ]
}

export function makeSystemTaskTrigger(over: Partial<SystemTaskTrigger> = {}): SystemTaskTrigger {
  return {
    type: "cron",
    expression: "0 9 * * *",
    timezone: "UTC",
    ...(over as object),
  } as SystemTaskTrigger
}

export function makeSystemTaskAction(over: Partial<SystemTaskAction> = {}): SystemTaskAction {
  return {
    type: "run_command",
    command: "node",
    args: ["scripts/cleanup.mjs"],
    working_dir: "/home/user/app",
    ...(over as object),
  } as SystemTaskAction
}

/** Build a `SystemTask` (OS-level scheduler row). */
export function makeSystemTask(over: Partial<SystemTask> = {}): SystemTask {
  return {
    id: "system-task-1",
    name: "Nightly disk cleanup",
    description: "Remove temp files and rotate logs.",
    trigger: makeSystemTaskTrigger(),
    action: makeSystemTaskAction(),
    run_level: "user",
    status: "enabled",
    requires_admin: false,
    tags: ["maintenance"],
    created_at: new Date(BASE - 10 * DAY).toISOString(),
    updated_at: new Date(BASE - DAY).toISOString(),
    last_run_at: new Date(BASE - DAY).toISOString(),
    next_run_at: new Date(BASE + DAY).toISOString(),
    metadata_state: "full",
    ...over,
  }
}

/** Reference instant exposed for stories that need a deterministic "now". */
export const FIXTURE_NOW = BASE
