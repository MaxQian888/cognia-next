"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { PlanApprovalPanel } from "@/components/agent/plan-approval-panel"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

export interface AgentTeamOverviewProps {
  team: AgentTeam
  teammates: AgentTeammate[]
  onStart?: () => void
  onAbort?: () => void
  onUpdateTeam?: (updates: Partial<AgentTeam>) => void
}

export function AgentTeamOverview({
  team,
  teammates,
  onStart,
  onAbort,
  onUpdateTeam,
}: AgentTeamOverviewProps) {
  const t = useTranslations("agentTeamsWorkspace.overview")
  const lead = teammates.find((m) => m.id === team.leadId)
  const workers = teammates.filter((m) => m.role === "teammate")
  const tokens = team.totalTokenUsage?.totalTokens ?? 0
  const budget =
    team.config.tokenBudget && team.config.tokenBudget > 0 ? team.config.tokenBudget : 0
  const usagePct = budget > 0 ? Math.min(100, Math.round((tokens / budget) * 100)) : 0

  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(team.name)
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState(team.description ?? "")

  const commitName = () => {
    if (nameDraft.trim() && nameDraft.trim() !== team.name) {
      onUpdateTeam?.({ name: nameDraft.trim() })
    }
    setEditingName(false)
  }

  const commitDesc = () => {
    if (descDraft.trim() !== (team.description ?? "")) {
      onUpdateTeam?.({ description: descDraft.trim() || undefined })
    }
    setEditingDesc(false)
  }

  const duration = team.totalDuration
    ? `${Math.floor(team.totalDuration / 60000)}m ${Math.floor((team.totalDuration % 60000) / 1000)}s`
    : null

  return (
    <div className="space-y-4" data-testid="workspace-overview">
      {/* Identity card */}
      <Card className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            {editingName ? (
              <span className="flex items-center gap-1">
                <Input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="h-8 text-sm font-semibold"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitName()
                    if (e.key === "Escape") setEditingName(false)
                  }}
                  autoFocus
                />
                <Button size="icon" variant="ghost" className="size-7" onClick={commitName}>
                  ✓
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => setEditingName(false)}
                >
                  ✕
                </Button>
              </span>
            ) : (
              <button
                type="button"
                className="text-left text-sm font-semibold hover:text-primary transition-colors"
                onClick={() => {
                  setNameDraft(team.name)
                  setEditingName(true)
                }}
                title={t("editName")}
              >
                {team.name}
              </button>
            )}
            {editingDesc ? (
              <span className="flex items-start gap-1">
                <Textarea
                  rows={2}
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  className="text-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditingDesc(false)
                  }}
                  autoFocus
                />
                <span className="flex shrink-0 gap-0.5">
                  <Button size="icon" variant="ghost" className="size-7" onClick={commitDesc}>
                    ✓
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => setEditingDesc(false)}
                  >
                    ✕
                  </Button>
                </span>
              </span>
            ) : (
              <button
                type="button"
                className="block text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => {
                  setDescDraft(team.description ?? "")
                  setEditingDesc(true)
                }}
                title={t("editDescription")}
              >
                {team.description || "Add description..."}
              </button>
            )}
          </div>
          <Badge
            variant={
              team.status === "executing" || team.status === "planning"
                ? "default"
                : team.status === "failed"
                  ? "destructive"
                  : "outline"
            }
            data-testid="team-status"
            className="shrink-0 inline-flex items-center gap-1.5"
          >
            {(team.status === "executing" || team.status === "planning") && (
              <span
                aria-hidden
                className="inline-block size-2 rounded-full bg-emerald-400 animate-pulse"
              />
            )}
            {t("status")}: {team.status}
          </Badge>
        </div>
      </Card>

      {/* Config summary + Runtime */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="space-y-2 p-4">
          <p className="text-xs font-medium text-muted-foreground">{t("configSummary")}</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <span className="text-muted-foreground">Mode</span>
            <span>{team.config.executionMode ?? "coordinated"}</span>
            <span className="text-muted-foreground">Pattern</span>
            <span className="truncate">
              {team.config.preferredExecutionPattern ?? "manager_worker"}
            </span>
            <span className="text-muted-foreground">Concurrency</span>
            <span>{team.config.maxConcurrentTeammates ?? 5}</span>
            <span className="text-muted-foreground">Budget</span>
            <span>{budget > 0 ? budget.toLocaleString() : "unlimited"}</span>
            <span className="text-muted-foreground">Plan approval</span>
            <span>{team.config.requirePlanApproval ? "Yes" : "No"}</span>
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
          <div className="pt-2">
            <p className="mb-1 text-[11px] text-muted-foreground">
              {t("tokenUsage")}: {tokens.toLocaleString()}
              {budget > 0 ? ` / ${budget.toLocaleString()}` : ""}
            </p>
            {budget > 0 && <Progress value={usagePct} data-testid="token-usage-bar" />}
          </div>
        </Card>
      </div>

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
          <Button size="sm" onClick={onStart} data-testid="start-team">
            {t("startTeam")}
          </Button>
        )}
      </div>
    </div>
  )
}
