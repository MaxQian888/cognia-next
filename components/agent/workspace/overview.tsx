"use client"

import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { PlanApprovalPanel } from "@/components/agent/plan-approval-panel"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

export interface AgentTeamOverviewProps {
  team: AgentTeam
  teammates: AgentTeammate[]
  onStart?: () => void
  onAbort?: () => void
}

export function AgentTeamOverview({ team, teammates, onStart, onAbort }: AgentTeamOverviewProps) {
  const t = useTranslations("agentTeamsWorkspace.overview")
  const lead = teammates.find((m) => m.id === team.leadId)
  const workers = teammates.filter((m) => m.role === "teammate")
  const tokens = team.totalTokenUsage?.totalTokens ?? 0
  const budget =
    team.config.tokenBudget && team.config.tokenBudget > 0 ? team.config.tokenBudget : 0
  const usagePct = budget > 0 ? Math.min(100, Math.round((tokens / budget) * 100)) : 0

  return (
    <Card className="space-y-3 p-4" data-testid="workspace-overview">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-semibold">{team.name}</p>
          <p className="text-xs text-muted-foreground">{team.description}</p>
        </div>
        <Badge variant="outline" data-testid="team-status">
          {t("status")}: {team.status}
        </Badge>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("lead")}</p>
          <p className="text-sm">{lead?.name ?? t("noLead")}</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("teammates")}</p>
          <p className="text-sm">{workers.length}</p>
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">
          {t("tokenUsage")}: {tokens}
          {budget > 0 ? ` / ${budget}` : ""}
        </p>
        {budget > 0 && <Progress value={usagePct} data-testid="token-usage-bar" />}
      </div>

      {team.config.requirePlanApproval && lead?.status === "awaiting_approval" && (
        <PlanApprovalPanel team={team} lead={lead} />
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        {team.status === "executing" || team.status === "planning" ? (
          <button
            type="button"
            className="rounded-md border px-3 py-1 text-xs hover:bg-muted"
            onClick={onAbort}
            data-testid="abort-team"
          >
            {t("abortTeam")}
          </button>
        ) : (
          <button
            type="button"
            className="rounded-md border bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
            onClick={onStart}
            data-testid="start-team"
          >
            {t("startTeam")}
          </button>
        )}
      </div>
    </Card>
  )
}
