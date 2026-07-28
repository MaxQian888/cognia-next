"use client"

import { useTranslations } from "next-intl"
import { CoinsIcon, GaugeIcon, ListChecksIcon, TimerIcon, UsersIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import { StatCard } from "@/components/scheduler/stat-card"
import { StatusBadge } from "@/components/status-badge"
import { formatNumber } from "./token-usage-line"
import { EditableField } from "./editable-field"
import { PlanApprovalPanel } from "@/components/agent/team/plan-approval-panel"
import { TeamRunControls } from "./team-run-controls"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { MotionReveal, useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { useUsageDisplayMode } from "@/hooks/usage/use-usage-display-mode"
import { useCountUp } from "@/hooks/usage/use-count-up"
import { useTeamLiveStatus } from "@/hooks/agent-runs/use-team-live-status"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useShallow } from "zustand/react/shallow"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

export interface AgentTeamOverviewProps {
  team: AgentTeam
  teammates: AgentTeammate[]
  onStart?: () => void
  /** Manual ultracode run — forces the pattern composition regardless of autoMode. */
  onStartUltracode?: () => void
  onAbort?: () => void
  /** Pause the live run (abort + mark paused; resumable). */
  onPause?: () => void
  /** Resume a paused team over its not-yet-done tasks. */
  onResume?: () => void
  /** Cancel a paused team for good (shutdown). */
  onStop?: () => void
  onUpdateTeam?: (updates: Partial<AgentTeam>) => void
  /**
   * Who draws the identity chrome — the status badge, the roster/token/duration
   * stats, and the run controls.
   *
   * `"self"` (default): this component draws them. Correct for surfaces with no
   * workspace header, i.e. the mobile workspace.
   *
   * `"header"`: an ancestor `WorkspaceHeader` already draws all five values, so
   * drawing them again repeats the same numbers twice within one viewport. The
   * desktop workspace passes this and lets the always-visible header own them.
   */
  chrome?: "self" | "header"
}

export function AgentTeamOverview({
  team,
  teammates,
  onStart,
  onStartUltracode,
  onAbort,
  onPause,
  onResume,
  onStop,
  onUpdateTeam,
  chrome = "self",
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

  // Task aggregates. A scalar pair on purpose: the selector re-runs on every
  // store delta (one per streamed token during a live run) but `useShallow`
  // only re-renders when a count actually moves. Feeds the progress tile and
  // the plugin panel context (ids + counts only — never task bodies).
  const taskStats = useAgentTeamStore(
    useShallow((s) => {
      let total = 0
      let completed = 0
      for (const task of Object.values(s.tasks)) {
        if (task.teamId !== team.id) continue
        total += 1
        if (task.status === "completed") completed += 1
      }
      return { total, completed }
    })
  )

  // Derive the displayed status from the durable workflowRuns row (with the
  // optimistic store status winning only while in-flight). See ADR-0022 "PR 5".
  const liveStatus = useTeamLiveStatus(team)
  const isLive = liveStatus === "executing" || liveStatus === "planning"
  const ownsChrome = chrome === "self"

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
          {ownsChrome && (
            <StatusBadge
              value={liveStatus}
              labelNamespace="agentTeam.status"
              pulse={isLive}
              pulseClassName={isLive ? "bg-emerald-400 size-2" : undefined}
              className="shrink-0"
              data-testid="team-status"
            />
          )}
        </div>
      </Card>

      {/* Key metrics. Under `chrome="header"` the roster / token / duration tiles
          are dropped: the always-visible header already carries those exact three
          numbers, and repeating them here put the same values on screen twice
          within one viewport. What replaces them is what the header cannot show —
          task progress (computed below but historically only handed to plugins)
          and budget headroom. */}
      <div
        className={cn("grid grid-cols-2 gap-3", ownsChrome ? "lg:grid-cols-4" : "lg:grid-cols-3")}
        data-testid="overview-stats"
      >
        {ownsChrome && (
          <>
            <StatCard
              label={t("teammates")}
              value={workers.length}
              icon={<UsersIcon className="h-5 w-5 text-blue-500" aria-hidden />}
              valueClassName="text-blue-500"
              accentGradient="from-blue-500 to-sky-400"
              iconBgClassName="bg-blue-500/10"
              testid="overview-stat-teammates"
            />
            <StatCard
              label={t("tokenUsage")}
              value={formatNumber(tokens)}
              icon={<CoinsIcon className="h-5 w-5 text-violet-500" aria-hidden />}
              valueClassName="text-violet-500"
              accentGradient="from-violet-500 to-purple-400"
              iconBgClassName="bg-violet-500/10"
              testid="overview-stat-tokens"
            />
            <StatCard
              label={t("duration")}
              value={duration ?? "—"}
              icon={<TimerIcon className="h-5 w-5 text-emerald-500" aria-hidden />}
              valueClassName="text-foreground"
              accentGradient="from-emerald-500 to-teal-400"
              iconBgClassName="bg-emerald-500/10"
              testid="overview-stat-duration"
            />
          </>
        )}
        {!ownsChrome && (
          <>
            <StatCard
              label={t("tasksProgress")}
              value={`${taskStats.completed}/${taskStats.total}`}
              icon={<ListChecksIcon className="h-5 w-5 text-emerald-500" aria-hidden />}
              valueClassName="text-emerald-500"
              accentGradient="from-emerald-500 to-teal-400"
              iconBgClassName="bg-emerald-500/10"
              testid="overview-stat-tasks"
            />
            <StatCard
              label={t("budget")}
              value={budget > 0 ? `${usagePct}%` : t("unlimited")}
              icon={<CoinsIcon className="h-5 w-5 text-violet-500" aria-hidden />}
              valueClassName="text-violet-500"
              accentGradient="from-violet-500 to-purple-400"
              iconBgClassName="bg-violet-500/10"
              testid="overview-stat-budget"
            />
          </>
        )}
        <StatCard
          label={t("concurrency")}
          value={team.config.maxConcurrentTeammates ?? 5}
          icon={<GaugeIcon className="h-5 w-5 text-amber-500" aria-hidden />}
          valueClassName="text-amber-500"
          accentGradient="from-amber-500 to-yellow-400"
          iconBgClassName="bg-amber-500/10"
          testid="overview-stat-concurrency"
        />
      </div>

      {/* Config summary + Runtime — two cards, so two columns. The old
          `lg:grid-cols-3` left a permanent empty third column at wide widths. */}
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
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

      {/* Plan approval. Gated on the lead's status ALONE: the runtime opens the
          gate on `requirePlanApproval || riskRaisedGate` (ADR-0070), so also
          requiring the config flag hid the plan for a risk-raised gate and
          asked the operator to approve something they could not see. The
          runtime parks the lead here only while the gate is open and lifts it
          on any decision or abort, so the status is sufficient and correct. */}
      {lead?.status === "awaiting_approval" && <PlanApprovalPanel team={team} lead={lead} />}

      {/* Actions. Rendered here only when this component owns the chrome; the
          desktop workspace pins the same controls in the always-visible header
          so the primary action never scrolls out of reach. */}
      {ownsChrome && (
        <TeamRunControls
          className="justify-end"
          status={liveStatus}
          ultracodeEnabled={team.config.ultracode?.enabled}
          onStart={onStart}
          onStartUltracode={onStartUltracode}
          onAbort={onAbort}
          onPause={onPause}
          onResume={onResume}
          onStop={onStop}
        />
      )}

      {/* Plugin-contributed team insight / governance panels. Context carries
          ids + aggregates only (never task/message bodies). */}
      <PluginExtensionSlot
        point="agent.team.panel"
        className="space-y-4"
        context={{
          teamId: team.id,
          status: liveStatus,
          teammateCount: workers.length,
          taskCount: taskStats.total,
          completedTaskCount: taskStats.completed,
        }}
      />
    </div>
  )
}
