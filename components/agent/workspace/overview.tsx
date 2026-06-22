"use client"

import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { StatusBadge } from "@/components/status-badge"
import { EditableField } from "./editable-field"
import { PlanApprovalPanel } from "@/components/agent/team/plan-approval-panel"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { MotionReveal, useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { useUsageDisplayMode } from "@/hooks/usage/use-usage-display-mode"
import { useCountUp } from "@/hooks/usage/use-count-up"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

export interface AgentTeamOverviewProps {
  team: AgentTeam
  teammates: AgentTeammate[]
  onStart?: () => void
  /** Manual ultracode run — forces the pattern composition regardless of autoMode. */
  onStartUltracode?: () => void
  onAbort?: () => void
  onUpdateTeam?: (updates: Partial<AgentTeam>) => void
}

export function AgentTeamOverview({
  team,
  teammates,
  onStart,
  onStartUltracode,
  onAbort,
  onUpdateTeam,
}: AgentTeamOverviewProps) {
  const t = useTranslations("agentTeamsWorkspace.overview")
  const { mode } = useUsageDisplayMode()
  const { reduce } = useFlowMotion()
  const lead = teammates.find((m) => m.id === team.leadId)
  const workers = teammates.filter((m) => m.role === "teammate")
  const tokens = team.totalTokenUsage?.totalTokens ?? 0
  const promptTokens = team.totalTokenUsage?.promptTokens ?? 0
  const completionTokens = team.totalTokenUsage?.completionTokens ?? 0
  const animatedTokens = useCountUp(tokens, { disabled: reduce })
  const budget =
    team.config.tokenBudget && team.config.tokenBudget > 0 ? team.config.tokenBudget : 0
  const usagePct = budget > 0 ? Math.min(100, Math.round((tokens / budget) * 100)) : 0

  const commitName = (next: string) => {
    if (next && next !== team.name) {
      onUpdateTeam?.({ name: next })
    }
  }

  const commitDesc = (next: string) => {
    if (next !== (team.description ?? "")) {
      onUpdateTeam?.({ description: next || undefined })
    }
  }

  const duration = team.totalDuration
    ? `${Math.floor(team.totalDuration / 60000)}m ${Math.floor((team.totalDuration % 60000) / 1000)}s`
    : null

  const isLive = team.status === "executing" || team.status === "planning"

  return (
    <div className="space-y-4" data-testid="workspace-overview">
      {/* Identity card */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
          <div className="min-w-0 flex-1 space-y-2">
            <EditableField
              value={team.name}
              onSave={commitName}
              variant="input"
              editTooltipKey="editName"
              displayClassName="text-sm font-semibold"
              data-testid="team-name-edit"
            />
            <EditableField
              value={team.description ?? ""}
              onSave={commitDesc}
              variant="textarea"
              editTooltipKey="editDescription"
              emptyHintKey="emptyHint"
              displayClassName="text-xs text-muted-foreground hover:text-foreground"
              data-testid="team-description-edit"
            />
          </div>
          <StatusBadge
            value={team.status}
            labelNamespace="agentTeam.status"
            pulse={isLive}
            pulseClassName={isLive ? "bg-emerald-400 size-2" : undefined}
            className="shrink-0"
            data-testid="team-status"
          />
        </div>
      </Card>

      {/* Config summary + Runtime */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="space-y-2 p-4">
          <p className="text-xs font-medium text-muted-foreground">{t("configSummary")}</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <span className="text-muted-foreground">{t("mode")}</span>
            <span>{team.config.executionMode ?? "coordinated"}</span>
            <span className="text-muted-foreground">{t("pattern")}</span>
            <span className="truncate">
              {team.config.preferredExecutionPattern ?? "manager_worker"}
            </span>
            <span className="text-muted-foreground">{t("concurrency")}</span>
            <span>{team.config.maxConcurrentTeammates ?? 5}</span>
            <span className="text-muted-foreground">{t("budget")}</span>
            <span>{budget > 0 ? budget.toLocaleString() : t("unlimited")}</span>
            <span className="text-muted-foreground">{t("planApproval")}</span>
            <span>{team.config.requirePlanApproval ? t("yes") : t("no")}</span>
          </div>
        </Card>

        <Card className="space-y-2 p-4">
          <p className="text-xs font-medium text-muted-foreground">{t("runtime")}</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <span className="text-muted-foreground">{t("lead")}</span>
            <span>{lead?.name ?? t("noLead")}</span>
            <span className="text-muted-foreground">{t("teammates")}</span>
            <span>{workers.length}</span>
            {duration && (
              <>
                <span className="text-muted-foreground">{t("duration")}</span>
                <span>{duration}</span>
              </>
            )}
          </div>
          <MotionReveal className="pt-2">
            <p className="mb-1 text-[11px] text-muted-foreground">
              {t("tokenUsage")}: {Math.round(animatedTokens).toLocaleString()}
              {budget > 0 ? ` / ${budget.toLocaleString()}` : ""}
            </p>
            {budget > 0 && <Progress value={usagePct} data-testid="token-usage-bar" />}
            {mode === "detailed" && (promptTokens > 0 || completionTokens > 0) && (
              <div
                className="mt-1 grid grid-cols-2 gap-x-3 text-[10px] text-muted-foreground"
                data-testid="token-usage-split"
              >
                <span>
                  {t("tokenInput")}: {promptTokens.toLocaleString()}
                </span>
                <span>
                  {t("tokenOutput")}: {completionTokens.toLocaleString()}
                </span>
              </div>
            )}
          </MotionReveal>
        </Card>
      </div>

      {/* Routing assessment — how auto-orchestration sized this team (ADR-0022).
          Surfaced so the operator can see the recommended pattern + whether
          ultracode will engage before pressing Run. */}
      {team.routingAssessment && (
        <Card className="space-y-1 p-4" data-testid="routing-assessment">
          <p className="text-sm font-medium">{t("routing.title")}</p>
          <p className="text-xs text-muted-foreground">
            {t("routing.pattern", {
              pattern: team.selectedExecutionPattern ?? team.routingAssessment.recommendedPattern,
            })}
            {" · "}
            {t("routing.confidence", {
              pct: Math.round((team.routingAssessment.confidence ?? 0) * 100),
            })}
            {" · "}
            {team.config.ultracode?.enabled ? t("routing.ultracodeOn") : t("routing.ultracodeOff")}
          </p>
          {team.routingAssessment.reason && (
            <p className="text-[11px] text-muted-foreground">{team.routingAssessment.reason}</p>
          )}
        </Card>
      )}

      {/* Final synthesized result (ultracode runs write the report here) */}
      {team.finalResult && (
        <Card className="space-y-2 p-4" data-testid="team-final-result">
          <p className="text-sm font-medium">{t("finalResult")}</p>
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{team.finalResult}</p>
        </Card>
      )}

      {/* Plan approval */}
      {team.config.requirePlanApproval && lead?.status === "awaiting_approval" && (
        <PlanApprovalPanel team={team} lead={lead} />
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        {team.status === "executing" || team.status === "planning" ? (
          <Button variant="outline" size="sm" onClick={onAbort} data-testid="abort-team">
            {t("abortTeam")}
          </Button>
        ) : (
          <>
            {team.config.ultracode?.enabled && onStartUltracode && (
              <Button
                variant="outline"
                size="sm"
                onClick={onStartUltracode}
                data-testid="start-team-ultracode"
              >
                {t("startTeamUltracode")}
              </Button>
            )}
            <Button size="sm" onClick={onStart} data-testid="start-team">
              {t("startTeam")}
            </Button>
          </>
        )}
      </div>

      {/* Plugin-contributed team insight / governance panels. */}
      <PluginExtensionSlot
        point="agent.team.panel"
        className="space-y-4"
        context={{ teamId: team.id, status: team.status }}
      />
    </div>
  )
}
