/**
 * Cross-kind execution-run type. The scheduler page surfaces "recent runs"
 * for every kind that ships its own execution history, normalized through
 * this shape so the dashboard widget and the run-detail sheet stay
 * kind-agnostic.
 *
 * Source tables vary by kind:
 *   - app / system → `schedulerDb.executions` (TaskExecution)
 *   - workflow     → `getDb().workflowRuns` (WorkflowRunRow)
 *   - backup       → `listBackupHistory()` (BackupHistoryRow)
 *   - plugin       → `getDb().pluginScheduledJobs` (lastRunAt only)
 *   - connector    → `getDb().connectorAudit` (AuditEntry)
 */

import type { RunStatus } from "@/types/workflow/visual"
import type { ScheduledItemKind } from "./unified"

/**
 * Cross-source run status. Mostly aligned with the workflow `RunStatus` so
 * the existing `RunStatusPill` component can render it after a one-line
 * mapping. `skipped` is connector / plugin specific and renders as
 * `cancelled` in the pill.
 */
export type UnifiedRunStatus = "running" | "succeeded" | "failed" | "cancelled" | "skipped"

/**
 * One log line attached to a unified execution run. Sources that don't ship
 * structured logs (e.g. backup) leave this empty.
 */
export interface UnifiedRunLog {
  ts: number
  level: "debug" | "info" | "warn" | "error"
  message: string
}

/**
 * Normalized execution-run record. Optional fields stay `undefined` when the
 * underlying source doesn't carry that field; consumers branch on presence,
 * not magic sentinel values.
 */
export interface UnifiedExecutionRun {
  /** Stable id `${kind}:${nativeId}` — use as the React key. */
  unifiedId: string
  kind: ScheduledItemKind
  /** Back-reference to the scheduled item that produced this run. */
  itemUnifiedId: string
  itemName: string
  status: UnifiedRunStatus
  /** Epoch ms when the run started. Always present. */
  startedAt: number
  /** Epoch ms when the run finished. Undefined for in-flight runs. */
  finishedAt?: number
  /** Convenience — `finishedAt - startedAt` when both are present. */
  durationMs?: number
  /** Optional trigger payload captured at run start. */
  payload?: unknown
  /** Optional result payload captured at run finish. */
  result?: unknown
  /** Error block, populated when status === "failed". */
  error?: { message: string; stack?: string; code?: string }
  /** Structured logs; sources that don't capture logs leave this empty. */
  logs?: UnifiedRunLog[]
  origin: {
    tableName: string
    nativeId: string
  }
}

/**
 * Map a `UnifiedRunStatus` to the workflow `RunStatus` accepted by the
 * existing `RunStatusPill` component. `skipped` collapses to `cancelled`
 * because the pill has no skip glyph.
 */
export function toRunStatusPill(status: UnifiedRunStatus): RunStatus {
  switch (status) {
    case "running":
      return "running"
    case "succeeded":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "skipped":
      return "cancelled"
  }
}
