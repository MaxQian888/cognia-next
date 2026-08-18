"use client"

/**
 * Extension point for plugin-supplied report analytics. Plugins that register
 * a component for the `agent.team.report` UI slot mount their custom sections
 * here, beneath the native KPI / taskline / token-burn cards. When no plugin
 * has contributed, the muted placeholder renders as the slot fallback.
 *
 * Context bag (ids + redacted aggregates only — PII red-line): `teamId`,
 * `reportId`, `status`, `traceSessionId`, `completedTasks`, `totalTokens`.
 */

import { useTranslations } from "next-intl"

import { Card } from "@/components/ui/card"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import type { TeamExecutionReport } from "@/types/agent/agent-team"

export interface ReportPluginSlotProps {
  report: TeamExecutionReport
}

export function PluginReportSlotPlaceholder() {
  const t = useTranslations("agentTeamsWorkspace.activity.report.pluginSlot")
  return (
    <Card className="p-3" data-testid="report-plugin-slot-placeholder">
      <p className="text-[11px] text-muted-foreground">{t("placeholder")}</p>
    </Card>
  )
}

export function ReportPluginSlot({ report }: ReportPluginSlotProps) {
  return (
    <PluginExtensionSlot
      point="agent.team.report"
      className="space-y-4"
      context={{
        teamId: report.teamId,
        reportId: report.id,
        status: report.status,
        traceSessionId: report.traceSessionId,
        completedTasks: report.summary?.completedTasks,
        totalTokens: report.summary?.totalTokens,
      }}
      fallback={<PluginReportSlotPlaceholder />}
    />
  )
}
