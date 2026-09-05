/**
 * Backfill legacy Squad run history into the canonical run records (ADR-0169).
 *
 * Before the cutover a legacy-runtime Squad wrote its run history ONLY as a
 * `workflowRuns` row under a `__team__:<teamId>:<nonce>` workflow id. The
 * cockpit, the CLI and the fleet each queried that table live to show it. With
 * one runtime there is one record: every such row is copied once into an
 * `agentTeamRuns` record plus an `ExecutionRun` with the events its status
 * implies, and the live compatibility queries are gone.
 *
 * Rules:
 *   - Idempotent. A row whose execution run already exists is skipped, so
 *     running this on every boot is free after the first.
 *   - Completed history is immutable. Terminal rows get their terminal event
 *     and nothing else.
 *   - A non-terminal legacy row cannot be resumed: its lifecycle lived in a
 *     process that is gone and left no checkpoint. It becomes
 *     `recovery_required` with the reason code `legacy_run_not_resumable`, and
 *     the control machine lets it restart as a NEW durable run (`retry`) or
 *     terminate (`stop`), never resume.
 *   - No free text crosses. The workflow row's error text stays where it is.
 */

import { getDb } from "@/lib/db/schema"
import { appendRunEventInsideTransaction } from "@/lib/db/execution-runs"
import { agentTeamExecutionRunId } from "@/lib/execution/agent-team-bridge"
import { parseTeamWorkflowId } from "@/lib/ai/agent/team/team-workflow-id"
import type { AgentTeamRunRecord, AgentTeamRunStatus } from "@/types/agent/agent-team-runtime"
import type { ExecutionRun, RunEventType } from "@/types/execution/run"
import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"

export const LEGACY_RUN_NOT_RESUMABLE = "legacy_run_not_resumable"

export interface LegacyRunBackfillOutcome {
  scanned: number
  imported: number
  skipped: number
  /** Non-terminal legacy rows that became `recovery_required`. */
  recoveryRequired: number
}

interface Mapped {
  durableStatus: AgentTeamRunStatus
  executionStatus: ExecutionRun["status"]
  terminalEvent: RunEventType | null
  recoveryReason?: string
}

/** How a legacy workflow-run status lands in the canonical records. */
export function mapLegacyRunStatus(status: RunStatus): Mapped {
  switch (status) {
    case "succeeded":
      return {
        durableStatus: "completed",
        executionStatus: "completed",
        terminalEvent: "run.completed",
      }
    case "failed":
      return { durableStatus: "failed", executionStatus: "failed", terminalEvent: "run.failed" }
    case "cancelled":
      return {
        durableStatus: "cancelled",
        executionStatus: "cancelled",
        terminalEvent: "run.cancelled",
      }
    default:
      // pending / running / waiting / paused: the process that ran it is gone.
      return {
        durableStatus: "needs_input",
        executionStatus: "recovery_required",
        terminalEvent: "run.recovery_required",
        recoveryReason: LEGACY_RUN_NOT_RESUMABLE,
      }
  }
}

/** Whether a workflow row is a legacy Squad run (not an "on team finished" fan-out). */
export function isLegacyTeamRun(row: WorkflowRunRow): boolean {
  if (row.triggerKind !== "trigger.team") return false
  const payload = row.triggerPayload as { teamId?: unknown; event?: unknown } | undefined
  if (!payload || typeof payload.teamId !== "string" || payload.event !== undefined) return false
  return parseTeamWorkflowId(row.workflowId) !== null
}

/**
 * Import one legacy row. Returns what happened so the caller can count.
 * Idempotent on the execution run id.
 */
export async function backfillLegacyTeamRun(
  row: WorkflowRunRow,
  now: number = Date.now()
): Promise<"imported" | "skipped"> {
  const db = getDb()
  const teamId = (row.triggerPayload as { teamId: string }).teamId
  const executionRunId = agentTeamExecutionRunId(row.id)
  const mapped = mapLegacyRunStatus(row.status)
  const startedAt = row.startedAt
  const endedAt = row.completedAt

  return db.transaction(
    "rw",
    db.agentTeamRuns,
    db.executionRuns,
    db.executionRunEvents,
    async () => {
      if (await db.executionRuns.get(executionRunId)) return "skipped"

      const existingRecord = await db.agentTeamRuns.get(row.id)
      if (!existingRecord) {
        const record: AgentTeamRunRecord = {
          id: row.id,
          teamId,
          ...(row.projectId ? { projectId: row.projectId } : {}),
          objective: row.title || row.workflowSnapshot?.name || row.workflowId,
          status: mapped.durableStatus,
          priority: 0,
          decisionVersion: 0,
          ...(mapped.recoveryReason ? { recoveryReason: mapped.recoveryReason } : {}),
          createdAt: startedAt,
          startedAt,
          ...(endedAt !== undefined ? { completedAt: endedAt } : {}),
          updatedAt: endedAt ?? now,
        }
        await db.agentTeamRuns.add(record)
      }

      const executionRun: ExecutionRun = {
        id: executionRunId,
        kind: "team",
        sourceId: row.id,
        ...(row.projectId ? { projectId: row.projectId } : {}),
        title: row.title || row.workflowSnapshot?.name || row.workflowId,
        status: "queued",
        currentRevision: 0,
        startedAt,
        updatedAt: startedAt,
      }
      await db.executionRuns.add(executionRun)
      await appendRunEventInsideTransaction(db, executionRunId, {
        id: `execution-event:${row.id}:started`,
        ts: startedAt,
        type: "run.started",
        visibility: "summary",
        payload: { teamId, origin: "legacy_backfill" },
        sourceEventId: `agent-team:${row.id}:started`,
      })
      if (mapped.terminalEvent) {
        await appendRunEventInsideTransaction(db, executionRunId, {
          id: `execution-event:${row.id}:backfill:${mapped.terminalEvent}`,
          ts: endedAt ?? now,
          type: mapped.terminalEvent,
          visibility: "summary",
          payload: mapped.recoveryReason
            ? { reason: mapped.recoveryReason }
            : { reason: "legacy_backfill" },
          sourceEventId: `agent-team:${row.id}:backfill`,
        })
      }
      return "imported"
    }
  )
}

/** Import every legacy Squad run this database still holds. */
export async function backfillLegacyTeamRunHistory(
  now: number = Date.now()
): Promise<LegacyRunBackfillOutcome> {
  const rows = await getDb().workflowRuns.where("triggerKind").equals("trigger.team").toArray()
  const outcome: LegacyRunBackfillOutcome = {
    scanned: rows.length,
    imported: 0,
    skipped: 0,
    recoveryRequired: 0,
  }
  for (const row of rows) {
    if (!isLegacyTeamRun(row)) {
      outcome.skipped += 1
      continue
    }
    const result = await backfillLegacyTeamRun(row, now).catch(() => "skipped" as const)
    if (result === "imported") {
      outcome.imported += 1
      if (mapLegacyRunStatus(row.status).recoveryReason) outcome.recoveryRequired += 1
    } else {
      outcome.skipped += 1
    }
  }
  return outcome
}
