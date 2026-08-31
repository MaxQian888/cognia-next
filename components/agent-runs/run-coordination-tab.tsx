"use client"

/**
 * Consensus and delegations for a Squad run, inside the run cockpit.
 *
 * Both panels were tabs of `/agent-teams/workspace`, a route ADR-0140 retired
 * and took out of navigation. They describe one run's coordination, so the run
 * detail is where they belong.
 *
 * # Keyed on `sourceId`, never `runId`
 *
 * `lib/execution/monitor-model.ts` documents the trap: while a team run is live
 * the row can arrive as `source: "broker"` with NO `runId` and no
 * `allowedActions`. A section keyed on `row.runId` is therefore blank exactly
 * while the run is worth looking at. `sourceId` is the native id the producing
 * engine knows, which for a team run is the `agentTeamRuns` row, and that row
 * is what names the team.
 *
 * # Says "not here" rather than showing an empty list
 *
 * Mobile syncs `executionRuns` and nothing else, so on a phone the team-run
 * record is simply absent. An empty consensus list there would claim the run
 * reached no decisions, which is a different statement from "this device does
 * not carry them".
 */

import { useTranslations } from "next-intl"

import { ConsensusPanel } from "@/components/agent/workspace/consensus-panel"
import { DelegationsPanel } from "@/components/agent/workspace/delegations-panel"
import { useClientLiveQuery } from "@/hooks/data"
import { getAgentTeamRun } from "@/lib/db/agent-team-runtime"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"

/** Whether a row is a Squad run at all. Nothing else has coordination. */
export function isSquadRun(row: UnifiedExecutionRow): boolean {
  return row.kind === "team"
}

export interface RunCoordinationTabProps {
  row: UnifiedExecutionRow
}

export function RunCoordinationTab({ row }: RunCoordinationTabProps) {
  const t = useTranslations("agentRuns")

  const teamRun = useClientLiveQuery(
    () => (row.sourceId ? getAgentTeamRun(row.sourceId) : Promise.resolve(undefined)),
    [row.sourceId],
    undefined
  )

  // `undefined` while the query is in flight AND when the record is genuinely
  // absent. Both read the same to a user, and both mean "nothing to show yet"
  // rather than "there was nothing", which is why the copy says unavailable.
  if (!teamRun) {
    return (
      <p
        className="py-4 text-center text-xs text-muted-foreground"
        data-testid="run-coordination-unavailable"
      >
        {t("coordination.unavailable")}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="run-coordination">
      <ConsensusPanel teamId={teamRun.teamId} />
      <DelegationsPanel teamId={teamRun.teamId} />
    </div>
  )
}
