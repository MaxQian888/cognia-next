"use client"

/**
 * Durable operations for a Squad run, inside the run cockpit.
 *
 * Steering a child, retrying it on another host, approving a delivery stack,
 * generating a retrospective and acting on its learning proposals were a tab of
 * `/agent-teams/workspace`. ADR-0140 retired that route without moving them, so
 * every durable control a running Squad has was reachable by URL only, and then
 * not at all once the route became a redirect.
 *
 * # It names the run
 *
 * `DurableOperations` falls back to the Squad's most recent run when given no
 * `runId`, which was right in a workspace showing one Squad and wrong here: the
 * cockpit reads one run at a time, and the newest is frequently not it. The run
 * is resolved from `row.sourceId` and passed explicitly, so the panel answers
 * about the run the reader actually opened.
 *
 * Keyed on `sourceId`, never `runId`: see `run-coordination-tab.tsx`.
 */

import { useCallback } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"

import { DurableOperations } from "@/components/agent/workspace/durable-operations"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useClientLiveQuery } from "@/hooks/data"
import { getAgentTeamRun } from "@/lib/db/agent-team-runtime"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"

export interface RunOperationsTabProps {
  row: UnifiedExecutionRow
}

export function RunOperationsTab({ row }: RunOperationsTabProps) {
  const t = useTranslations("agentRuns")
  const router = useRouter()

  const teamRun = useClientLiveQuery(
    () => (row.sourceId ? getAgentTeamRun(row.sourceId) : Promise.resolve(undefined)),
    [row.sourceId],
    undefined
  )
  const team = useAgentTeamStore((s) => (teamRun ? s.teams[teamRun.teamId] : undefined))

  // The panel's three "open something" callbacks pointed at tabs of the retired
  // workspace. The editor and the terminal live on the workspace surface now,
  // which is also where reclaimed agent branches went. The browser has its own
  // route. Sending the reader there beats a button that does nothing.
  const openWorkspace = useCallback(() => router.push("/workspace"), [router])
  const openBrowser = useCallback(() => router.push("/browser"), [router])

  if (!teamRun || !team) {
    return (
      <p
        className="py-4 text-center text-xs text-muted-foreground"
        data-testid="run-operations-unavailable"
      >
        {t("operations.unavailable")}
      </p>
    )
  }

  return (
    <div data-testid="run-operations">
      <DurableOperations
        team={team}
        runId={teamRun.id}
        onOpenEditor={openWorkspace}
        onOpenTerminal={openWorkspace}
        onOpenBrowser={openBrowser}
      />
    </div>
  )
}

export default RunOperationsTab
