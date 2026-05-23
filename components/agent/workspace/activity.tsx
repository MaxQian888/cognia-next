"use client"

import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { ActivityIcon } from "lucide-react"

import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { StatusBadge } from "@/components/status-badge"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type {
  AgentTeam,
  AgentTeamEvent,
  AgentTeammate,
  TeamExecutionReport,
} from "@/types/agent/agent-team"
import { ConsensusPanel } from "./consensus-panel"
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
  const prefersReducedMotion = useReducedMotion()

  if (events.length === 0 && !report) {
    return (
      <div className="space-y-4">
        <Empty data-testid="activity-empty">
          <EmptyMedia variant="icon">
            <ActivityIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{t("empty")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
        <ConsensusPanel />
      </div>
    )
  }

  // Newest events first.
  const ordered = [...events].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )

  return (
    <div className="space-y-4">
      {report ? (
        <div className="space-y-4" data-testid="activity-report">
          <ReportKpiCards report={report} />
          <ReportTaskline report={report} teammates={teammates} />
          <ReportTokenBurn report={report} />
          {team ? <ReportPluginSlot report={report} team={team} /> : null}
          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium">
              {tReport("checkpoints.toggle")}
            </summary>
            <div className="pt-2">
              <ReportTimeline report={report} />
            </div>
          </details>
        </div>
      ) : null}
      <ScrollArea className="max-h-[60vh] rounded-md border">
        <ul className="divide-y" data-testid="workspace-activity">
          {ordered.map((event, i) => (
            <motion.li
              key={`${event.type}-${event.timestamp.toISOString?.() ?? i}`}
              initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.15,
                ease: "easeOut",
                delay: prefersReducedMotion ? 0 : Math.min(i * 0.025, 0.12),
              }}
              className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
              data-testid={`activity-row-${i}`}
            >
              <StatusBadge
                value={event.type}
                labelNamespace="agentTeamsWorkspace.activity.eventKind"
                className="text-[11px] font-mono"
              />
              <span className="font-mono text-[10px] text-muted-foreground">
                {new Date(event.timestamp).toISOString()}
              </span>
            </motion.li>
          ))}
        </ul>
      </ScrollArea>
      <ConsensusPanel />
    </div>
  )
}
