"use client"

/**
 * The execution report for a Squad run, inside the run cockpit.
 *
 * The KPI cards, the taskline, the token burn and the `agent.team.report`
 * plugin slot were the report half of `/agent-teams/workspace`'s activity tab.
 * ADR-0140 retired that route and moved the coordination half (consensus,
 * delegations) here, leaving the report half behind, so four built components
 * and a declared plugin extension point had nothing rendering them. A plugin
 * could contribute a report panel and it would never appear, with `audit:slots`
 * green throughout because that gate scans files rather than the render graph.
 *
 * Keyed on `row.sourceId`, never `row.runId`, for the reason
 * `run-coordination-tab.tsx` documents: while a team run is live the row can
 * arrive as `source: "broker"` with no `runId` at all.
 *
 * # It says whose report this is
 *
 * `TeamExecutionReport` carries a `teamId` and no run id, so the store holds
 * one report per Squad: the latest. This tab therefore cannot promise the
 * report belongs to the run being read, and says so instead of implying it.
 * Pinning a report to a run means giving the type a run id, which is a change
 * to the report writer, not to its reader.
 */

import { useTranslations } from "next-intl"

import {
  ReportKpiCards,
  ReportPluginSlot,
  ReportTaskline,
  ReportTokenBurn,
} from "@/components/agent/workspace/activity-report"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useClientLiveQuery } from "@/hooks/data"
import { getAgentTeamRun } from "@/lib/db/agent-team-runtime"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"

export interface RunReportTabProps {
  row: UnifiedExecutionRow
}

export function RunReportTab({ row }: RunReportTabProps) {
  const t = useTranslations("agentRuns")

  const teamRun = useClientLiveQuery(
    () => (row.sourceId ? getAgentTeamRun(row.sourceId) : Promise.resolve(undefined)),
    [row.sourceId],
    undefined
  )
  const teamId = teamRun?.teamId
  const report = useAgentTeamStore((s) => (teamId ? s.teams[teamId]?.executionReport : undefined))
  const teammates = useAgentTeamStore((s) => s.teammates)

  // `undefined` covers both "still loading" and "this device does not carry the
  // record". Mobile syncs `executionRuns` and nothing else, so on a phone the
  // Squad run row is simply absent, and an empty report there would claim the
  // run produced none.
  if (!teamRun) {
    return (
      <p
        className="py-4 text-center text-xs text-muted-foreground"
        data-testid="run-report-unavailable"
      >
        {t("report.unavailable")}
      </p>
    )
  }

  if (!report) {
    return (
      <p className="py-4 text-center text-xs text-muted-foreground" data-testid="run-report-none">
        {t("report.none")}
      </p>
    )
  }

  const roster = Object.values(teammates).filter((member) => member.teamId === teamId)

  return (
    <div className="flex flex-col gap-3" data-testid="run-report">
      <p className="text-[11px] text-muted-foreground" data-testid="run-report-scope">
        {t("report.latestForSquad")}
      </p>
      <ReportKpiCards report={report} />
      <ReportTokenBurn report={report} />
      <ReportTaskline report={report} teammates={roster} />
      {/* Plugin-contributed report panels. Its declared host was
          `activity-report/report-plugin-slot.tsx`, reached only from the
          retired workspace's activity tab. */}
      <ReportPluginSlot report={report} />
    </div>
  )
}

export default RunReportTab
