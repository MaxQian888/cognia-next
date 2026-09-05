"use client"

/**
 * One Squad's status, from its DURABLE run record (ADR-0169).
 *
 * The store's `team.status` is a mirror the lifecycle runner writes, kept so
 * synchronous callers (board guards, presence) do not each open a query. The
 * newest `agentTeamRuns` row is the record. This hook joins the two: the live
 * mirror wins while it is non-terminal (an in-flight run shows at once, before
 * its row updates), otherwise the newest run row's status is the truth, and
 * with no run row yet the mirror is the only signal.
 *
 * It used to read `workflowRuns` under a `__team__:` id. That was the legacy
 * runtime's only record, and it is gone with it.
 */
import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { AgentTeam, TeamStatus } from "@/types/agent/agent-team"
import type { AgentTeamRunRecord, AgentTeamRunStatus } from "@/types/agent/agent-team-runtime"

/** Store statuses backed by a live lifecycle (non-terminal). */
const LIVE_STORE_STATUSES: ReadonlySet<TeamStatus> = new Set(["planning", "executing", "paused"])

/** Map a durable run status onto the equivalent team status. */
export function runRecordStatusToTeamStatus(status: AgentTeamRunStatus): TeamStatus {
  switch (status) {
    case "queued":
    case "running":
    case "recovering":
      return "executing"
    case "pausing":
    case "paused":
    case "sleeping":
    case "needs_input":
      return "paused"
    case "completed":
      return "completed"
    case "failed":
      return "failed"
    case "cancelled":
    case "terminated":
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
  newestRunStatus: AgentTeamRunStatus | undefined
): TeamStatus {
  if (LIVE_STORE_STATUSES.has(storeStatus)) return storeStatus
  if (newestRunStatus) return runRecordStatusToTeamStatus(newestRunStatus)
  return storeStatus
}

/** Pick the status of the most recently updated run record. Pure, exposed for tests. */
export function pickNewestRunStatus(rows: AgentTeamRunRecord[]): AgentTeamRunStatus | undefined {
  if (rows.length === 0) return undefined
  let newest = rows[0]!
  for (const row of rows) if (row.updatedAt > newest.updatedAt) newest = row
  return newest.status
}

export function useTeamLiveStatus(team: AgentTeam): TeamStatus {
  const newestRunStatus = useLiveQuery(
    async () =>
      pickNewestRunStatus(await getDb().agentTeamRuns.where("teamId").equals(team.id).toArray()),
    [team.id]
  )

  return useMemo(
    () => deriveTeamStatus(team.status, newestRunStatus),
    [team.status, newestRunStatus]
  )
}
