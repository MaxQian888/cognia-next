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
  /** Previous run this one replaces (a `retry`). Linked by the control plane too. */
  parentRunId?: string
  startedAt: number
}

export interface SquadRunRecords {
  runId: string
  executionRunId: string
  /** False when both rows already existed (an idempotent retry). */
  created: boolean
  run: AgentTeamRunRecord
  executionRun: ExecutionRun
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
    async () => {
      const [existingRun, existingExecution] = await Promise.all([
        db.agentTeamRuns.get(seed.runId),
        db.executionRuns.get(executionRunId),
      ])
      if (existingRun && existingRun.teamId !== seed.teamId) {
        throw new Error(`Squad run ${seed.runId} belongs to another Squad`)
      }
      let run = existingRun
      if (!run) {
        run = {
          id: seed.runId,
          teamId: seed.teamId,
          ...(seed.projectId ? { projectId: seed.projectId } : {}),
          objective: seed.objective,
          status: "queued",
          priority: seed.priority ?? 0,
          queueEnteredAt: seed.startedAt,
          decisionVersion: 0,
          ...(seed.environmentVersionId ? { environmentVersionId: seed.environmentVersionId } : {}),
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
        executionRun = (await db.executionRuns.get(executionRunId)) ?? executionRun
      }
      return {
        runId: seed.runId,
        executionRunId,
        created: !existingRun || !existingExecution,
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
