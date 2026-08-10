"use client"

import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import { STAGGER_CHILD, STAGGER_CONTAINER, useReducedMotionVariants } from "@/lib/ui/motion"
import { ActivityIcon, ChevronDownIcon, HistoryIcon } from "lucide-react"

import { ScrollArea } from "@/components/ui/scroll-area"
import { StatusBadge } from "@/components/status-badge"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type {
  AgentTeam,
  AgentTeamEvent,
  AgentTeammate,
  TeamExecutionReport,
} from "@/types/agent/agent-team"
import { ConsensusPanel } from "./consensus-panel"
import { DelegationsPanel } from "./delegations-panel"
import { TeamRunsList } from "../team/runs-list"
import {
  ReportKpiCards,
  ReportTaskline,
  ReportTokenBurn,
  ReportPluginSlot,
} from "./activity-report"

export interface AgentTeamActivityProps {
  events: AgentTeamEvent[]
  /** Latest execution report for the team (when a run has executed). */
  report?: TeamExecutionReport
  /** Team + roster — enable the rich report (KPI / taskline / token-burn). */
  team?: AgentTeam
  teammates?: AgentTeammate[]
}

/** Render the execution-report checkpoint timeline (chronological). */
function ReportTimeline({ report }: { report: TeamExecutionReport }) {
  const t = useTranslations("agentTeamsWorkspace.activity.report")
  const ordered = [...report.checkpoints].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )
  return (
    <Card className="space-y-2 p-3" data-testid="activity-report-timeline">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t("title")}</p>
        <Badge variant="outline" className="text-[10px]">
          {t("status", { status: report.status })}
        </Badge>
      </div>
      {ordered.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("emptyCheckpoints")}</p>
      ) : (
        <ol className="space-y-1">
          {ordered.map((cp) => (
            <li key={cp.id} className="flex items-start gap-2 rounded-md border px-2 py-1 text-xs">
              <Badge variant="secondary" className="font-mono text-[10px]">
                {cp.type}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate">{cp.summary}</p>
                <p className="text-[10px] text-muted-foreground">
                  {new Date(cp.timestamp).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

export function AgentTeamActivity({
  events,
  report,
  team,
  teammates = [],
}: AgentTeamActivityProps) {
  const t = useTranslations("agentTeamsWorkspace.activity")
  const tReport = useTranslations("agentTeamsWorkspace.activity.report")
  // Shared list-entrance variants (`@/lib/ui/motion`); the container supplies
  // the stagger so rows no longer carry a hand-computed per-index delay.
  const childVariants = useReducedMotionVariants(STAGGER_CHILD)

  // Live teammate-progress rows are surfaced in a dedicated pulsing block,
  // one per task (latest frame wins — the store already replaces in place).
  // They are kept OUT of the chronological event list to avoid churn.
  const liveByTask = new Map<string, AgentTeamEvent>()
  for (const e of events) {
    if (e.type !== "progress_update" || !e.taskId) continue
    const prev = liveByTask.get(e.taskId)
    if (!prev || new Date(e.timestamp).getTime() >= new Date(prev.timestamp).getTime()) {
      liveByTask.set(e.taskId, e)
    }
  }
  const liveRows = [...liveByTask.values()].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )

  // Newest events first, progress frames excluded (rendered above).
  const ordered = [...events]
    .filter((e) => e.type !== "progress_update")
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  return (
    <div className="space-y-4">
      {report ? (
        <div className="space-y-4" data-testid="activity-report">
          <ReportKpiCards report={report} />
          <ReportTaskline report={report} teammates={teammates} />
          <ReportTokenBurn report={report} />
          {team ? <ReportPluginSlot report={report} team={team} /> : null}
          <Collapsible className="group/collapsible rounded-md border px-3 py-2">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="h-auto w-full justify-between px-0 py-1 text-xs">
                {tReport("checkpoints.toggle")}
                <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]/collapsible:rotate-180" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <ReportTimeline report={report} />
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : null}
      {liveRows.length > 0 ? (
        <div className="space-y-1" data-testid="activity-live">
          {liveRows.map((event) => {
            const d = event.data ?? {}
            const phase = String(d.phase ?? "running")
            const isLive = phase === "start" || phase === "running"
            const name = String(d.teammateName ?? event.teammateId ?? "")
            const tool = typeof d.currentTool === "string" ? d.currentTool : undefined
            const tools = Number(d.toolCount) || 0
            const chars = Number(d.charCount) || 0
            const secs = Math.round((Number(d.elapsedMs) || 0) / 1000)
            return (
              <div
                key={event.taskId}
                data-testid={`activity-live-${event.taskId}`}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
              >
                <StatusBadge
                  value={phase}
                  pulse={isLive}
                  labelNamespace="agentTeamsWorkspace.activity.progressPhase"
                  className="text-[11px]"
                />
                {name ? <span className="font-medium">{name}</span> : null}
                {tool ? (
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {tool}
                  </Badge>
                ) : null}
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {phase === "start"
                    ? t("liveProgressStarting")
                    : t("liveProgress", { tools, chars, secs })}
                </span>
              </div>
            )
          })}
        </div>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="space-y-3 p-4" data-testid="activity-events">
          <p className="flex items-center gap-2 text-sm font-medium">
            <ActivityIcon className="size-4 text-muted-foreground" aria-hidden />
            {t("eventsTitle")}
          </p>
          {ordered.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center gap-2 py-8 text-center text-muted-foreground"
              data-testid="activity-empty"
            >
              <ActivityIcon className="size-6 opacity-60" />
              <p className="text-sm">{t("empty")}</p>
            </div>
          ) : (
            <ScrollArea className="max-h-[60vh] rounded-md border">
              <motion.ul
                className="divide-y"
                data-testid="workspace-activity"
                variants={STAGGER_CONTAINER}
                initial="initial"
                animate="animate"
              >
                {ordered.map((event, i) => (
                  <motion.li
                    key={`${event.type}-${event.timestamp.toISOString?.() ?? i}`}
                    variants={childVariants}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                    data-testid={`activity-row-${i}`}
                  >
                    <StatusBadge
                      value={event.type}
                      labelNamespace="agentTeamsWorkspace.activity.eventKind"
                      className="text-[11px] font-mono"
                    />
                    <span
                      className="font-mono text-[10px] text-muted-foreground"
                      title={new Date(event.timestamp).toLocaleString()}
                    >
                      {new Date(event.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </motion.li>
                ))}
              </motion.ul>
            </ScrollArea>
          )}
        </Card>
        {team ? (
          <Card className="space-y-3 p-4" data-testid="activity-runs">
            <p className="flex items-center gap-2 text-sm font-medium">
              <HistoryIcon className="size-4 text-muted-foreground" aria-hidden />
              {t("runsTitle")}
            </p>
            <TeamRunsList teamId={team.id} />
          </Card>
        ) : null}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <ConsensusPanel />
        <DelegationsPanel />
      </div>
    </div>
  )
}
