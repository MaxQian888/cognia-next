/**
 * The two rows a Squad run is made of, created together or not at all.
 *
 * ADR-0169 makes run creation fail-closed and transactional. Before it, the
 * `AgentTeamRunRecord` was written by the coordinator's `prepareRun` some time
 * after dispatch, and the `ExecutionRun` by whichever caller remembered to,
 * "best-effort", inside a `catch {}`. A run could therefore be executing with
 * no journal row, which is exactly the run nobody could list, pause or stop.
 *
 * Here both rows land in ONE Dexie transaction, before any child dispatch. If
 * the transaction fails, nothing executes. Retries with the same `runId` find
 * the rows and return them unchanged, so an idempotency key never yields two
 * live runs.
 */

import { appendRunEventInsideTransaction } from "@/lib/db/execution-runs"
import { getDb } from "@/lib/db/schema"
import { getAgentTeamRun, updateAgentTeamRunIfCurrent } from "@/lib/db/agent-team-runtime"
import { agentTeamExecutionRunId } from "@/lib/execution/agent-team-bridge"
import type { AgentTeamRunRecord, AgentTeamRunStatus } from "@/types/agent/agent-team-runtime"
import type { ExecutionRun } from "@/types/execution/run"

/** Run statuses that hold a live run open. A team with one cannot start another. */
export const LIVE_SQUAD_RUN_STATUSES: ReadonlySet<AgentTeamRunStatus> = new Set<AgentTeamRunStatus>(
  ["queued", "running", "pausing", "paused", "sleeping", "recovering", "needs_input"]
)

export const TERMINAL_SQUAD_RUN_STATUSES: ReadonlySet<AgentTeamRunStatus> =
  new Set<AgentTeamRunStatus>(["completed", "failed", "cancelled", "terminated"])

export interface SquadRunSeed {
  runId: string
  teamId: string
  objective: string
  projectId?: string
  /** The conversation that asked for the run, when there is one. */
  sessionId?: string
  /** Trigger origin. Recorded on the opening event so a surface can say who started it. */
  origin: string
  priority?: number
  environmentVersionId?: string
  executionConstraints?: AgentTeamRunRecord["executionConstraints"]
  /** Previous run this one replaces (a `retry`). Linked by the control plane too. */
  parentRunId?: string
  startedAt: number
}

export interface SquadRunRecords {
  runId: string
  executionRunId: string
  /** False when both rows already existed (an idempotent retry). */
  created: boolean
  replacedRunId?: string
  run: AgentTeamRunRecord
  executionRun: ExecutionRun
}

export class SquadRunConflictError extends Error {
  constructor(readonly runId: string) {
    super(`Squad already has a live run: ${runId}`)
    this.name = "SquadRunConflictError"
  }
}

/**
 * Create both rows atomically. Throws when the transaction cannot commit. The
 * caller treats a throw as "the run does not exist" and starts nothing.
 */
export async function createSquadRunRecords(seed: SquadRunSeed): Promise<SquadRunRecords> {
  const db = getDb()
  const executionRunId = agentTeamExecutionRunId(seed.runId)
  return db.transaction(
    "rw",
    db.agentTeamRuns,
    db.executionRuns,
    db.executionRunEvents,
    db.notificationProjectionWork,
    async () => {
      const [existingRun, existingExecution] = await Promise.all([
        db.agentTeamRuns.get(seed.runId),
        db.executionRuns.get(executionRunId),
      ])
      if (existingRun && existingRun.teamId !== seed.teamId) {
        throw new Error(`Squad run ${seed.runId} belongs to another Squad`)
      }
      if (!existingRun && !existingExecution && seed.parentRunId) {
        const replacements = await db.executionRuns
          .where("parentRunId")
          .equals(seed.parentRunId)
          .toArray()
        const replacement = replacements.find((row) => row.kind === "team")
        if (replacement) {
          const run = await db.agentTeamRuns.get(replacement.sourceId)
          if (!run || run.teamId !== seed.teamId) {
            throw new Error("Squad replacement history is incomplete or belongs to another Squad")
          }
          return {
            runId: run.id,
            executionRunId: replacement.id,
            created: false,
            run,
            executionRun: replacement,
          }
        }
      }
      let replacedRunId: string | undefined
      if (!existingRun && !existingExecution) {
        const live = (await db.agentTeamRuns.where("teamId").equals(seed.teamId).toArray()).filter(
          (row) => LIVE_SQUAD_RUN_STATUSES.has(row.status)
        )
        const parentId = seed.parentRunId?.replace(/^execution:team:/, "")
        for (const row of live) {
          if (row.id !== parentId || !["paused", "sleeping", "needs_input"].includes(row.status)) {
            throw new SquadRunConflictError(row.id)
          }
          replacedRunId = row.id
          await db.agentTeamRuns.update(row.id, {
            status: "cancelled",
            completedAt: seed.startedAt,
            updatedAt: seed.startedAt,
          })
          const parentExecutionId = agentTeamExecutionRunId(row.id)
          const parentExecution = await db.executionRuns.get(parentExecutionId)
          if (
            parentExecution &&
            !["completed", "failed", "cancelled"].includes(parentExecution.status)
          ) {
            await appendRunEventInsideTransaction(db, parentExecutionId, {
              id: `execution-event:${row.id}:replaced:${seed.runId}`,
              ts: seed.startedAt,
              type: "run.cancelled",
              visibility: "summary",
              payload: { reason: "replaced", replacementRunId: seed.runId },
              sourceEventId: `agent-team:${row.id}:replaced:${seed.runId}`,
            })
          }
        }
      }
      let run = existingRun
      if (!run) {
        run = {
          id: seed.runId,
          teamId: seed.teamId,
          ...(seed.projectId ? { projectId: seed.projectId } : {}),
          objective: seed.objective,
          status: existingExecution
            ? ["completed", "failed", "cancelled"].includes(existingExecution.status)
              ? (existingExecution.status as AgentTeamRunStatus)
              : "needs_input"
            : "queued",
          priority: seed.priority ?? 0,
          queueEnteredAt: seed.startedAt,
          decisionVersion: 0,
          ...(seed.environmentVersionId ? { environmentVersionId: seed.environmentVersionId } : {}),
          ...(seed.executionConstraints && !existingExecution
            ? { executionConstraints: seed.executionConstraints }
            : {}),
          ...(existingExecution ? { recoveryReason: "missing_execution_constraints" } : {}),
          resourceUsage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            wallTimeMs: 0,
            toolTimeMs: 0,
            attempts: 0,
            failures: 0,
          },
          createdAt: seed.startedAt,
          updatedAt: seed.startedAt,
        }
        await db.agentTeamRuns.add(run)
      }
      let executionRun = existingExecution
      if (!executionRun) {
        executionRun = {
          id: executionRunId,
          kind: "team",
          sourceId: seed.runId,
          ...(seed.parentRunId ? { parentRunId: seed.parentRunId } : {}),
          ...(seed.projectId ? { projectId: seed.projectId } : {}),
          ...(seed.sessionId ? { sessionId: seed.sessionId } : {}),
          title: seed.objective,
          status: "queued",
          currentRevision: 0,
          startedAt: seed.startedAt,
          updatedAt: seed.startedAt,
        }
        await db.executionRuns.add(executionRun)
        await appendRunEventInsideTransaction(db, executionRunId, {
          id: `execution-event:${seed.runId}:started`,
          ts: seed.startedAt,
          type: "run.started",
          visibility: "summary",
          // Ids and codes only. The objective is the row title, and free text
          // never enters the journal.
          payload: { teamId: seed.teamId, origin: seed.origin },
          sourceEventId: `agent-team:${seed.runId}:started`,
        })
        if (isTerminalSquadRunStatus(run.status)) {
          const status = run.status === "terminated" ? "cancelled" : run.status
          await appendRunEventInsideTransaction(db, executionRunId, {
            id: `execution-event:${seed.runId}:restored-terminal`,
            ts: run.completedAt ?? run.updatedAt,
            type: `run.${status}` as "run.completed" | "run.failed" | "run.cancelled",
            visibility: "summary",
            payload: { reason: "restored_terminal_history" },
            sourceEventId: `agent-team:${seed.runId}:restored-terminal`,
          })
        }
        executionRun = (await db.executionRuns.get(executionRunId)) ?? executionRun
      }
      return {
        runId: seed.runId,
        executionRunId,
        created: !existingRun && !existingExecution,
        ...(replacedRunId ? { replacedRunId } : {}),
        run,
        executionRun,
      }
    }
  )
}

/** The team's live run, if one exists. Newest first when several somehow do. */
export async function findLiveSquadRun(teamId: string): Promise<AgentTeamRunRecord | undefined> {
  const rows = await getDb().agentTeamRuns.where("teamId").equals(teamId).toArray()
  return rows
    .filter((row) => LIVE_SQUAD_RUN_STATUSES.has(row.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

export function isLiveSquadRunStatus(status: AgentTeamRunStatus): boolean {
  return LIVE_SQUAD_RUN_STATUSES.has(status)
}

export function isTerminalSquadRunStatus(status: AgentTeamRunStatus): boolean {
  return TERMINAL_SQUAD_RUN_STATUSES.has(status)
}

/** A late failure cannot resurrect a run that an operator already stopped. */
export async function parkActiveSquadRun(
  runId: string,
  reason: string,
  now: number
): Promise<boolean> {
  const run = await getAgentTeamRun(runId)
  if (!run || isTerminalSquadRunStatus(run.status)) return false
  return updateAgentTeamRunIfCurrent(runId, run, {
    status: "needs_input",
    recoveryReason: reason,
    updatedAt: now,
  })
}
