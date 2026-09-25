import type { BackupHistoryRow } from "@/lib/db/backup-history"
import type { ConnectorAuditRow } from "@/lib/db/connector-types"
import type { TaskExecution, TaskExecutionLog } from "@/types/scheduler"
import {
  makeUnifiedId,
  unifiedKindForTaskType,
  type ScheduledItemKind,
} from "@/types/scheduler/unified"
import type {
  UnifiedExecutionRun,
  UnifiedRunLog,
  UnifiedRunStatus,
} from "@/types/scheduler/unified-runs"
import type { WorkflowRunRow } from "@/types/workflow/visual"

/** A run is listed under its task's kind: the one ownership rule, not a copy of it. */
export function taskExecutionKind(taskType: string): "app" | "plugin" | "connector" {
  return unifiedKindForTaskType(taskType)
}

export function toUnifiedFromTaskExecution(exec: TaskExecution): UnifiedExecutionRun {
  const kind = taskExecutionKind(exec.taskType)
  return {
    unifiedId: makeUnifiedId(kind, exec.id),
    kind,
    itemUnifiedId: makeUnifiedId(kind, exec.taskId),
    itemName: exec.taskName,
    status: mapTaskExecStatus(exec.status),
    startedAt: exec.startedAt.getTime(),
    finishedAt: exec.completedAt?.getTime(),
    durationMs: exec.duration,
    payload: exec.input,
    result: exec.output,
    error: exec.error ? { message: exec.error } : undefined,
    logs: exec.logs.map(mapTaskExecLog),
    triggerSource: exec.triggerSource,
    ...(exec.terminalReason ? { terminalReason: exec.terminalReason } : {}),
    origin: { tableName: "scheduledTaskRuns", nativeId: exec.id },
  }
}

export function toUnifiedFromWorkflowRun(row: WorkflowRunRow): UnifiedExecutionRun {
  return {
    unifiedId: makeUnifiedId("workflow", row.id),
    kind: "workflow",
    itemUnifiedId: makeUnifiedId("workflow", row.workflowId),
    itemName: row.title ?? row.workflowSnapshot.name ?? row.workflowId,
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
 * The outbound queue's rollup item id, spelled here rather than imported from
 * `connector-source.ts` (which imports this module).
 */
export const CONNECTOR_QUEUE_ITEM_ID = makeUnifiedId("connector", "outbound:queue")

/**
 * An audit row is a delivery the outbound queue made or failed to make, so it
 * belongs to the queue rollup item. It used to point at `connector:<adapterId>`,
 * an id no item has ever carried, so no detail could show these runs and the
 * run sheet had nothing to open.
 */
export function toUnifiedFromAudit(row: ConnectorAuditRow): UnifiedExecutionRun {
  return {
    unifiedId: makeUnifiedId("connector", row.id),
    kind: "connector",
    itemUnifiedId: CONNECTOR_QUEUE_ITEM_ID,
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

export function mapTaskExecStatus(status: TaskExecution["status"]): UnifiedRunStatus {
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
  }
}

function mapWorkflowStatus(status: WorkflowRunRow["status"]): UnifiedRunStatus {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
    case "paused":
      return "running"
    case "succeeded":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
  }
}

function mapAuditKind(kind: ConnectorAuditRow["kind"]): UnifiedRunStatus {
  if (kind === "delivery.success" || kind.startsWith("inbound.")) return "succeeded"
  if (kind === "delivery.error" || kind === "delivery.deadlettered" || kind === "adapter.error") {
    return "failed"
  }
  if (
    kind === "delivery.downgraded" ||
    kind.startsWith("circuit.") ||
    kind === "rate_limit.tripped"
  ) {
    return "skipped"
  }
  return "succeeded"
}

function mapTaskExecLog(log: TaskExecutionLog): UnifiedRunLog {
  return { ts: log.timestamp.getTime(), level: log.level, message: log.message }
}

export function filterRunsByKind(
  runs: UnifiedExecutionRun[],
  kind: ScheduledItemKind
): UnifiedExecutionRun[] {
  return runs.filter((run) => run.kind === kind)
}
