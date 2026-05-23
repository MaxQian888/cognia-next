"use client"

/**
 * KPI summary cards for a team execution report: duration, total tokens,
 * success rate, and escalation count. Reuses the compact `formatNumber`
 * (token-usage-line) and `formatDuration` (lib/agent/utils) helpers.
 */

import { useTranslations } from "next-intl"

import { Card } from "@/components/ui/card"
import { formatNumber } from "@/components/agent/workspace/token-usage-line"
import { formatDuration } from "@/lib/agent/utils"
import type { TeamExecutionReport } from "@/types/agent/agent-team"

export interface ReportKpiCardsProps {
  report: TeamExecutionReport
}

function successRate(report: TeamExecutionReport): number {
  const s = report.summary
  if (!s) return 0
  const total = s.completedTasks + s.failedTasks + s.cancelledTasks
  if (total === 0) return 0
  return Math.round((s.completedTasks / total) * 100)
}

function escalationCount(report: TeamExecutionReport): number {
  return report.checkpoints.filter(
    (c) => c.type === "budget_escalated" || c.type === "approval_requested"
  ).length
}

export function ReportKpiCards({ report }: ReportKpiCardsProps) {
  const t = useTranslations("agentTeamsWorkspace.activity.report.kpi")
  const end = report.completedAt ? new Date(report.completedAt) : new Date()
  const durationMs = end.getTime() - new Date(report.createdAt).getTime()

  const cards = [
    { key: "duration", label: t("duration"), value: formatDuration(Math.max(0, durationMs)) },
    { key: "tokens", label: t("tokens"), value: formatNumber(report.summary?.totalTokens ?? 0) },
    { key: "successRate", label: t("successRate"), value: `${successRate(report)}%` },
    { key: "escalations", label: t("escalations"), value: String(escalationCount(report)) },
  ]

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="report-kpi-cards">
      {cards.map((c) => (
        <Card key={c.key} className="space-y-1 p-3 text-center">
          <p className="text-lg font-semibold">{c.value}</p>
          <p className="text-[10px] text-muted-foreground">{c.label}</p>
        </Card>
      ))}
    </div>
  )
}
