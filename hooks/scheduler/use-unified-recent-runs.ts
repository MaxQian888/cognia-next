"use client"

/**
 * Cross-kind execution-run fan-in.
 *
 * Five sources back the unified scheduler page; their execution histories
 * live in five different Dexie stores. This hook subscribes to each via
 * `useLiveQuery` (pattern from `components/workflow/runs/run-detail.tsx`),
 * normalises every row through a dedicated mapper, merges the results, and
 * truncates to `limit` newest-first. The dashboard widget and the
 * `RunDetailSheet` both consume this single output so neither has to know
 * which source produced any given row.
 *
 * Filtering by `kind` or by a specific `itemUnifiedId` happens in-memory
 * after the fan-in — keeping the Dexie queries simple and avoiding per-kind
 * branching at the index level.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { getDb } from "@/lib/db/schema"
import { listBackupHistory, type BackupHistoryRow } from "@/lib/db/backup-history"
import type { TaskExecution, TaskExecutionLog } from "@/types/scheduler"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { PluginScheduledJobRow } from "@/lib/db/plugin-types"
import type { ConnectorAuditRow } from "@/lib/db/connector-types"
import { makeUnifiedId, type ScheduledItemKind } from "@/types/scheduler/unified"
import type {
  UnifiedExecutionRun,
  UnifiedRunLog,
  UnifiedRunStatus,
} from "@/types/scheduler/unified-runs"

export interface UseUnifiedRecentRunsOptions {
  /** Cap the merged list (newest-first). Default 20. */
  limit?: number
  /** Restrict to a single kind. */
  filterKind?: ScheduledItemKind
  /** Restrict to runs whose `itemUnifiedId` matches. */
  filterItemId?: string
}

export interface UseUnifiedRecentRunsResult {
  runs: UnifiedExecutionRun[]
  isLoading: boolean
}

const DEFAULT_LIMIT = 20

export function useUnifiedRecentRuns(
  options: UseUnifiedRecentRunsOptions = {}
): UseUnifiedRecentRunsResult {
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT

  // app + system — schedulerDb.executions (deserialized to TaskExecution via
  // schedulerDb.getRecentExecutions, which handles the Date / JSON unpacking).
  const taskExecutions = useLiveQuery(async () => schedulerDb.getRecentExecutions(limit), [limit])

  // workflow — getDb().workflowRuns
  const workflowRuns = useLiveQuery(
    async () => getDb().workflowRuns.orderBy("startedAt").reverse().limit(limit).toArray(),
    [limit]
  )

  // backup — backupHistory (already a thin wrapper around Dexie ordering)
  const backupRows = useLiveQuery(async () => listBackupHistory({ limit }), [limit])

  // plugin — pluginScheduledJobs (only carries lastRunAt; no per-run rows)
  const pluginJobs = useLiveQuery(async () => getDb().pluginScheduledJobs.toArray(), [])

  // connector — connectorAudit (delivery.* + adapter.* events ordered by `at`)
  const auditRows = useLiveQuery(
    async () => getDb().connectorAudit.orderBy("at").reverse().limit(limit).toArray(),
    [limit]
  )

  const runs = useMemo(() => {
    const merged: UnifiedExecutionRun[] = []
    if (taskExecutions) merged.push(...taskExecutions.map(toUnifiedFromTaskExecution))
    if (workflowRuns) merged.push(...workflowRuns.map(toUnifiedFromWorkflowRun))
    if (backupRows) merged.push(...backupRows.map(toUnifiedFromBackupHistory))
    if (pluginJobs) merged.push(...pluginJobs.flatMap(toUnifiedFromPluginJob))
    if (auditRows) merged.push(...auditRows.map(toUnifiedFromAudit))

    merged.sort((a, b) => b.startedAt - a.startedAt)

    let filtered = merged
    if (options.filterKind) {
      filtered = filtered.filter((r) => r.kind === options.filterKind)
    }
    if (options.filterItemId) {
      filtered = filtered.filter((r) => r.itemUnifiedId === options.filterItemId)
    }
    return filtered.slice(0, limit)
  }, [
    taskExecutions,
    workflowRuns,
    backupRows,
    pluginJobs,
    auditRows,
    limit,
    options.filterKind,
    options.filterItemId,
  ])

  const isLoading =
    taskExecutions === undefined ||
    workflowRuns === undefined ||
    backupRows === undefined ||
    pluginJobs === undefined ||
    auditRows === undefined

  return { runs, isLoading }
}

// ── Per-source mappers ───────────────────────────────────────────────────────

/**
 * Map a scheduler-db `TaskExecution` to a unified run. `taskType` carrying
 * a `connection:` prefix routes the run to the `connector` kind so it joins
 * the connector source's items in the UI.
 */
export function toUnifiedFromTaskExecution(exec: TaskExecution): UnifiedExecutionRun {
  const isConnector = typeof exec.taskType === "string" && exec.taskType.startsWith("connection:")
  const kind: ScheduledItemKind = isConnector ? "connector" : "app"
  return {
    unifiedId: makeUnifiedId(kind, exec.id),
    kind,
    itemUnifiedId: makeUnifiedId(kind, exec.taskId),
    itemName: exec.taskName,
    status: mapTaskExecStatus(exec.status),
    startedAt: exec.startedAt.getTime(),
    finishedAt: exec.completedAt ? exec.completedAt.getTime() : undefined,
    durationMs: exec.duration,
    payload: exec.input,
    result: exec.output,
    error: exec.error ? { message: exec.error } : undefined,
    logs: exec.logs.map(mapTaskExecLog),
    triggerSource: exec.triggerSource,
    origin: { tableName: "schedulerDb.executions", nativeId: exec.id },
  }
}

export function toUnifiedFromWorkflowRun(row: WorkflowRunRow): UnifiedExecutionRun {
  return {
    unifiedId: makeUnifiedId("workflow", row.id),
    kind: "workflow",
    itemUnifiedId: makeUnifiedId("workflow", row.workflowId),
    itemName: row.workflowSnapshot.name ?? row.workflowId,
    status: mapWorkflowStatus(row.status),
    startedAt: row.startedAt,
    finishedAt: row.completedAt,
    durationMs: row.completedAt ? row.completedAt - row.startedAt : undefined,
    payload: row.triggerPayload,
    result: row.output,
    error: row.error
      ? { message: row.error.message, stack: row.error.stack, code: row.error.code }
      : undefined,
    origin: { tableName: "workflowRuns", nativeId: row.id },
  }
}

export function toUnifiedFromBackupHistory(row: BackupHistoryRow): UnifiedExecutionRun {
  return {
    unifiedId: makeUnifiedId("backup", row.id),
    kind: "backup",
    itemUnifiedId: makeUnifiedId("backup", "default"),
    itemName: row.filename ?? "Backup",
    status: row.success ? "succeeded" : "failed",
    startedAt: row.completedAt,
    finishedAt: row.completedAt,
    durationMs: 0,
    payload: { type: row.type, encryption: row.encryption, sizeBytes: row.sizeBytes },
    error: row.success ? undefined : { message: row.errorMessage ?? "Backup failed" },
    origin: { tableName: "backupHistory", nativeId: row.id },
  }
}

/**
 * Plugin scheduled jobs don't persist per-run history; we surface the
 * `lastRunAt` field as a single synthetic run per job so the dashboard
 * still shows recent plugin activity. Jobs with no `lastRunAt` produce
 * no entry.
 */
export function toUnifiedFromPluginJob(job: PluginScheduledJobRow): UnifiedExecutionRun[] {
  if (typeof job.lastRunAt !== "number") return []
  const status: UnifiedRunStatus = job.status === "error" ? "failed" : "succeeded"
  return [
    {
      unifiedId: makeUnifiedId("plugin", `${job.id}:${job.lastRunAt}`),
      kind: "plugin",
      itemUnifiedId: makeUnifiedId("plugin", job.id),
      itemName: `${job.pluginId} · ${job.handler}`,
      status,
      startedAt: job.lastRunAt,
      finishedAt: job.lastRunAt,
      durationMs: 0,
      payload: job.args,
      origin: { tableName: "pluginScheduledJobs", nativeId: job.id },
    },
  ]
}

export function toUnifiedFromAudit(row: ConnectorAuditRow): UnifiedExecutionRun {
  return {
    unifiedId: makeUnifiedId("connector", row.id),
    kind: "connector",
    itemUnifiedId: makeUnifiedId("connector", row.adapterId),
    itemName: row.adapterId,
    status: mapAuditKind(row.kind),
    startedAt: row.at,
    finishedAt: row.at,
    durationMs: 0,
    payload: row.fields,
    error:
      row.kind.startsWith("delivery.error") || row.kind === "delivery.deadlettered"
        ? { message: row.message ?? row.reason ?? "Delivery failure", code: row.reason }
        : undefined,
    origin: { tableName: "connectorAudit", nativeId: row.id },
  }
}

// ── Status mappers ───────────────────────────────────────────────────────────

function mapTaskExecStatus(status: TaskExecution["status"]): UnifiedRunStatus {
  switch (status) {
    case "pending":
    case "running":
      return "running"
    case "completed":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "skipped":
      return "skipped"
    default:
      return "failed"
  }
}

function mapWorkflowStatus(status: WorkflowRunRow["status"]): UnifiedRunStatus {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
      return "running"
    case "paused":
      return "running"
    case "succeeded":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    default:
      return "failed"
  }
}

function mapAuditKind(kind: ConnectorAuditRow["kind"]): UnifiedRunStatus {
  if (kind === "delivery.success") return "succeeded"
  if (kind === "delivery.error" || kind === "delivery.deadlettered") return "failed"
  if (kind === "delivery.downgraded") return "skipped"
  if (kind.startsWith("inbound.")) return "succeeded"
  if (kind.startsWith("circuit.")) return "skipped"
  if (kind === "rate_limit.tripped") return "skipped"
  if (kind === "adapter.error") return "failed"
  return "succeeded"
}

function mapTaskExecLog(log: TaskExecutionLog): UnifiedRunLog {
  return {
    ts: log.timestamp.getTime(),
    level: log.level,
    message: log.message,
  }
}
