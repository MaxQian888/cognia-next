"use client"

/**
 * Cross-kind agent-run fan-in (Scheduler Phase D).
 *
 * Aggregates the four agent-run sources — persistent goals (`chatGoals`),
 * agent-team runs (`workflowRuns` with the `__team__:` prefix), unified plans
 * (`agentPlans`), and scheduled agent tasks (scheduler executions of
 * `goal` / `agent-team` / `plan`) — into one newest-first `AgentRun[]`. Mirrors
 * `hooks/scheduler/use-unified-recent-runs.ts`: one `useLiveQuery` per Dexie
 * source, normalize through the pure mappers in `types/agent-runs/agent-run.ts`,
 * merge, filter in-memory.
 *
 * Live team status is joined from the in-memory `agent-team-store`: a team's
 * NEWEST run is annotated with the store's live status when that status is
 * non-terminal, so an in-flight team shows as running even before its
 * `workflowRuns` row is updated. Older runs keep their persisted status.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import { listAllGoals } from "@/lib/db/goals"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store/store"
import type { AgentTeam, TeamStatus } from "@/types/agent/agent-team"
import type { TaskExecution } from "@/types/scheduler"
import {
  compareAgentRuns,
  isTeamWorkflowId,
  parseTeamWorkflowId,
  toAgentRunFromGoal,
  toAgentRunFromPlan,
  toAgentRunFromTaskExecution,
  toAgentRunFromTeamRun,
  type AgentRun,
  type AgentRunKind,
} from "@/types/agent-runs/agent-run"

const DEFAULT_LIMIT = 50

/** Scheduler task types that represent an agent run. */
const AGENT_TASK_TYPES = new Set(["goal", "agent-team", "plan"])

/** Team statuses with a live controller (non-terminal). */
const LIVE_TEAM_STATUSES = new Set<TeamStatus>(["planning", "executing", "paused"])

export interface UseAgentRunsOptions {
  /** Cap the merged list (newest-first). Default 50. */
  limit?: number
  /** Restrict to a single kind. */
  filterKind?: AgentRunKind
  /** Case-insensitive title substring filter. */
  query?: string
}

export interface UseAgentRunsResult {
  runs: AgentRun[]
  isLoading: boolean
}

export function useAgentRuns(options: UseAgentRunsOptions = {}): UseAgentRunsResult {
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT

  const goals = useLiveQuery(async () => listAllGoals(limit), [limit])
  const plans = useLiveQuery(
    async () => getDb().agentPlans.orderBy("createdAt").reverse().limit(limit).toArray(),
    [limit]
  )
  const teamRuns = useLiveQuery(
    async () => getDb().workflowRuns.orderBy("startedAt").reverse().limit(limit).toArray(),
    [limit]
  )
  const taskExecutions = useLiveQuery(async () => schedulerDb.getRecentExecutions(limit), [limit])
  const teams = useAgentTeamStore((s) => s.teams)

  const runs = useMemo(() => {
    const merged: AgentRun[] = []

    if (goals) merged.push(...goals.map(toAgentRunFromGoal))
    if (plans) merged.push(...plans.map(toAgentRunFromPlan))

    if (teamRuns) {
      const teamRows = teamRuns.filter((r) => isTeamWorkflowId(r.workflowId))
      // The newest run per team is the one a live store status may annotate.
      const newestRunIdByTeam = new Map<string, string>()
      for (const row of teamRows) {
        const teamId = parseTeamWorkflowId(row.workflowId)?.teamId
        if (!teamId) continue
        const prev = newestRunIdByTeam.get(teamId)
        if (!prev) newestRunIdByTeam.set(teamId, row.id)
        // teamRows is already startedAt-desc, so the first seen is the newest.
      }
      for (const row of teamRows) {
        const teamId = parseTeamWorkflowId(row.workflowId)?.teamId
        const team: AgentTeam | undefined = teamId ? teams[teamId] : undefined
        const isNewest = teamId ? newestRunIdByTeam.get(teamId) === row.id : false
        const liveStatus =
          isNewest && team && LIVE_TEAM_STATUSES.has(team.status) ? team.status : undefined
        merged.push(toAgentRunFromTeamRun(row, liveStatus))
      }
    }

    if (taskExecutions) {
      const agentExecs = taskExecutions.filter((e: TaskExecution) =>
        AGENT_TASK_TYPES.has(e.taskType)
      )
      merged.push(...agentExecs.map(toAgentRunFromTaskExecution))
    }

    merged.sort(compareAgentRuns)

    let filtered = merged
    if (options.filterKind) {
      filtered = filtered.filter((r) => r.kind === options.filterKind)
    }
    if (options.query && options.query.trim()) {
      const q = options.query.trim().toLowerCase()
      filtered = filtered.filter((r) => r.title.toLowerCase().includes(q))
    }
    return filtered.slice(0, limit)
  }, [goals, plans, teamRuns, taskExecutions, teams, limit, options.filterKind, options.query])

  const isLoading =
    goals === undefined ||
    plans === undefined ||
    teamRuns === undefined ||
    taskExecutions === undefined

  return { runs, isLoading }
}
