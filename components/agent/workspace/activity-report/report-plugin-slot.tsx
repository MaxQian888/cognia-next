"use client"

/**
 * Extension point for plugin-supplied report analytics. Renders a muted
 * placeholder today; a future `analytics-renderer-registry` plugin capability
 * can inject custom report sections here without touching this file beyond
 * swapping the placeholder for the registry read.
 */

import { useTranslations } from "next-intl"

import { Card } from "@/components/ui/card"
import type { AgentTeam, TeamExecutionReport } from "@/types/agent/agent-team"

export interface ReportPluginSlotProps {
  report: TeamExecutionReport
  team: AgentTeam
}

export function PluginReportSlotPlaceholder() {
  const t = useTranslations("agentTeamsWorkspace.activity.report.pluginSlot")
  return (
    <Card className="p-3" data-testid="report-plugin-slot-placeholder">
      <p className="text-[11px] text-muted-foreground">{t("placeholder")}</p>
    </Card>
  )
}

export function ReportPluginSlot(_props: ReportPluginSlotProps) {
  // No analytics-renderer registry is wired this iteration — render the
  // placeholder. The extension seam stays here so adding the registry later
  // is a localized change.
  return <PluginReportSlotPlaceholder />
}
