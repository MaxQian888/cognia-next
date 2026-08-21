"use client"

/**
 * Derive a single team's status from the DURABLE `workflowRuns` row rather than
 * the optimistic in-memory `agent-team-store` mirror (ADR-0022 "PR 5" follow-up).
 *
 * The store's `team.status` is written optimistically by `agentTeamManager.start`
 * and mirrored back at terminal — it is a UI convenience, not the source of
 * truth. The newest `workflowRuns` row under this team's
 * `teamWorkflowIdPrefix` is the durable record. This hook joins the two: the
 * live store status wins while it is non-terminal (so an in-flight run shows
 * immediately, before its run row lands or updates); otherwise the newest run
 * row's status is the truth; with no run row yet, the store status is the only
 * signal.
 */
import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import { teamWorkflowIdPrefix } from "@/lib/ai/agent/team/team-workflow-id"
import type { AgentTeam, TeamStatus } from "@/types/agent/agent-team"
import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"

/** Store statuses backed by a live controller (non-terminal). */
const LIVE_STORE_STATUSES: ReadonlySet<TeamStatus> = new Set(["planning", "executing", "paused"])

/** Map a durable workflow-run status onto the equivalent team status. */
export function workflowRunStatusToTeamStatus(status: RunStatus): TeamStatus {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
      return "executing"
    case "paused":
      return "paused"
    case "succeeded":
      return "completed"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    default:
      return "failed"
  }
}

/**
 * Pure status derivation (see hook docstring). Exposed for unit testing without
 * React / Dexie.
 */
export function deriveTeamStatus(
  storeStatus: TeamStatus,
  newestRunStatus: RunStatus | undefined
): TeamStatus {
  if (LIVE_STORE_STATUSES.has(storeStatus)) return storeStatus
  if (newestRunStatus) return workflowRunStatusToTeamStatus(newestRunStatus)
  return storeStatus
}

/** Pick the status of the most-recently-started run row (pure; exposed for tests). */
export function pickNewestRunStatus(rows: WorkflowRunRow[]): RunStatus | undefined {
  if (rows.length === 0) return undefined
  let newest = rows[0]
  for (const row of rows) if (row.startedAt > newest.startedAt) newest = row
  return newest.status
}

export function useTeamLiveStatus(team: AgentTeam): TeamStatus {
  const prefix = teamWorkflowIdPrefix(team.id)
  const newestRunStatus = useLiveQuery(
    async () =>
      pickNewestRunStatus(
        await getDb().workflowRuns.where("workflowId").startsWith(prefix).toArray()
      ),
    [prefix]
  )

  return useMemo(
    () => deriveTeamStatus(team.status, newestRunStatus),
    [team.status, newestRunStatus]
  )
}
