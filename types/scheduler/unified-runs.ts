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
 *   - plugin       → SchedulerDB `executions` for `type: "plugin"` tasks
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
  /** What initiated the run (app-task executions only; e.g. "backfill"). */
  triggerSource?: string
  /**
   * The structured reason the run ended (app-task executions only), e.g.
   * `needs-approval` for a `failed` run that stopped for want of an approver.
   */
  terminalReason?: string
  origin: {
    tableName: string
    nativeId: string
  }
}

/**
 * What a `needs-approval` run was waiting on, read back from its result
 * (`status: "needs_approval"` output of a scheduled chat / agent / skill or
 * goal run). Either list may be empty: a turn can be refused tools in a
 * trusted workspace, or run restricted without asking for anything.
 */
export interface RunApprovalRequest {
  /** Distinct tools the unattended responder refused, in first-refused order. */
  tools: string[]
  /** Workspace roots the run was restricted for. */
  untrustedRoots: string[]
  /** Trust could not be read, so the roots are unverified rather than untrusted. */
  unverified: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `null` unless the run failed with terminal reason `needs-approval`. */
export function runApprovalRequest(run: UnifiedExecutionRun): RunApprovalRequest | null {
  if (run.status !== "failed" || run.terminalReason !== "needs-approval") return null
  const result = isRecord(run.result) ? run.result : {}
  const denials = Array.isArray(result.needsApproval) ? result.needsApproval : []
  const tools = new Set<string>()
  for (const denial of denials) {
    if (isRecord(denial) && typeof denial.toolName === "string" && denial.toolName) {
      tools.add(denial.toolName)
    }
  }
  const trust = isRecord(result.workspaceTrust) ? result.workspaceTrust : {}
  const roots = Array.isArray(trust.untrustedRoots) ? trust.untrustedRoots : []
  return {
    tools: [...tools],
    untrustedRoots: roots.filter((root): root is string => typeof root === "string" && !!root),
    unverified: trust.unverified === true,
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
