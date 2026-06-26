/**
 * Unified execution view model.
 *
 * The execution monitor answers one question — "what is running right now?" —
 * across three already-existing sources, with NO new persistence layer:
 *   1. the in-memory {@link ExecutionBroker} legs (every admitted AI turn:
 *      chat + the headless legs funneled through `run-and-capture`, which is
 *      where sub-agent / connector / goal / team work shows up — the
 *      BackgroundTaskRegistry's running sub-agents ARE these legs),
 *   2. the persisted `workflowRuns` table (Dexie liveQuery),
 *   3. the persisted scheduler `executions` table (Dexie liveQuery).
 *
 * This module is the pure merge: given the three source arrays it returns one
 * sorted, normalized row list. The panel feeds it live data; keeping the merge
 * pure makes it trivially testable and free of Dexie/React concerns.
 */

import type { ExecutionLegSnapshot } from "./types"
import type { WorkflowRunRow, RunStatus } from "@/types/workflow/visual"
import type { TaskExecution, TaskExecutionStatus } from "@/types/scheduler"

export type UnifiedExecutionStatus =
  | "queued"
  | "running"
  | "waiting"
  | "done"
  | "error"
  | "cancelled"

export type UnifiedExecutionSource = "broker" | "workflow" | "scheduled"

export interface UnifiedExecutionRow {
  /** Source-prefixed unique row id (stable React key). */
  rowId: string
  source: UnifiedExecutionSource
  /** Native id within the source (broker leg id / workflow run id / execution id). */
  nativeId: string
  /** Display kind — broker leg kind, `"workflow"`, or the scheduled task type. */
  kind: string
  label: string
  status: UnifiedExecutionStatus
  startedAt: number
  sessionId?: string
  runId?: string
  taskId?: string
  projectId?: string
  /** Broker leg id when this row can be cancelled through the broker. */
  legId?: string
  /** True when the panel's cancel affordance should be shown. */
  cancellable: boolean
}

export interface BuildMonitorModelInput {
  brokerLegs: ExecutionLegSnapshot[]
  workflowRuns?: WorkflowRunRow[]
  schedulerExecutions?: TaskExecution[]
  /** When set, keep only rows for this project (plus unscoped rows). */
  projectId?: string
}

/** Workflow run statuses that represent live/in-flight work. */
const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "running",
  "pending",
  "waiting",
  "paused",
])

/** Scheduler execution statuses that represent live/in-flight work. */
const ACTIVE_EXEC_STATUSES: ReadonlySet<TaskExecutionStatus> = new Set(["running", "pending"])

export function mapRunStatus(status: RunStatus): UnifiedExecutionStatus {
  switch (status) {
    case "running":
      return "running"
    case "pending":
      return "queued"
    case "waiting":
    case "paused":
      return "waiting"
    case "succeeded":
      return "done"
    case "failed":
      return "error"
    case "cancelled":
      return "cancelled"
  }
}

export function mapExecStatus(status: TaskExecutionStatus): UnifiedExecutionStatus {
  switch (status) {
    case "running":
      return "running"
    case "pending":
      return "queued"
    case "completed":
    case "skipped":
      return "done"
    case "failed":
      return "error"
    case "cancelled":
      return "cancelled"
  }
}

function inProject(rowProjectId: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true
  // Unscoped rows are global → always shown; scoped rows must match.
  return rowProjectId == null || rowProjectId === filter
}

/**
 * Merge the three live sources into one normalized, project-filtered row list,
 * sorted most-recent-first.
 */
export function buildExecutionMonitorModel(input: BuildMonitorModelInput): UnifiedExecutionRow[] {
  const rows: UnifiedExecutionRow[] = []

  for (const leg of input.brokerLegs) {
    if (!inProject(leg.projectId, input.projectId)) continue
    const status: UnifiedExecutionStatus = leg.cancelled ? "cancelled" : leg.state
    rows.push({
      rowId: `broker:${leg.id}`,
      source: "broker",
      nativeId: leg.id,
      kind: leg.kind,
      label: leg.label,
      status,
      startedAt: leg.startedAt,
      ...(leg.sessionId ? { sessionId: leg.sessionId } : {}),
      ...(leg.runId ? { runId: leg.runId } : {}),
      ...(leg.taskId ? { taskId: leg.taskId } : {}),
      ...(leg.projectId ? { projectId: leg.projectId } : {}),
      legId: leg.id,
      // A leg that has already been cancelled (awaiting its release) is no
      // longer actionable.
      cancellable: !leg.cancelled,
    })
  }

  for (const run of input.workflowRuns ?? []) {
    if (!ACTIVE_RUN_STATUSES.has(run.status)) continue
    if (!inProject(run.projectId, input.projectId)) continue
    rows.push({
      rowId: `workflow:${run.id}`,
      source: "workflow",
      nativeId: run.id,
      kind: "workflow",
      label: run.title || run.workflowSnapshot?.name || run.workflowId,
      status: mapRunStatus(run.status),
      startedAt: run.startedAt,
      runId: run.id,
      ...(run.projectId ? { projectId: run.projectId } : {}),
      cancellable: false,
    })
  }

  for (const exec of input.schedulerExecutions ?? []) {
    if (!ACTIVE_EXEC_STATUSES.has(exec.status)) continue
    rows.push({
      rowId: `scheduled:${exec.id}`,
      source: "scheduled",
      nativeId: exec.id,
      kind: exec.taskType,
      label: exec.taskName,
      status: mapExecStatus(exec.status),
      startedAt: exec.startedAt instanceof Date ? exec.startedAt.getTime() : Number(exec.startedAt),
      taskId: exec.taskId,
      cancellable: false,
    })
  }

  return rows.sort((a, b) => b.startedAt - a.startedAt || a.rowId.localeCompare(b.rowId))
}

/** Count of rows that are actively running (not queued / waiting / settled). */
export function countRunningRows(rows: UnifiedExecutionRow[]): number {
  return rows.reduce((n, r) => (r.status === "running" ? n + 1 : n), 0)
}
