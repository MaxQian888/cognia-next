"use client"

/**
 * Workspace hero header — the always-visible identity + at-a-glance strip that
 * anchors the per-team detail view above the tab shell.
 *
 * Surfaces the team avatar, name, description and live status, plus a compact
 * stat strip (members, working, tokens, duration) derived from data that is
 * available on every tab (team + roster are not tab-gated, unlike
 * tasks/messages/events). The live status is read from the durable workflow run
 * via `useTeamLiveStatus`.
 *
 * It also owns the run controls. They used to sit at the bottom of the Overview
 * tab, below the routing assessment, the final result and the plan-approval
 * panel — so the longer a run got, the further the Abort button sank below the
 * fold. Here they stay reachable from every tab, which is the whole reason this
 * header is pinned outside the scroll container.
 *
 * Note the header is only rendered by the desktop workspace; the mobile
 * workspace has no equivalent and keeps its chrome inside the Overview tab
 * (`AgentTeamOverview chrome="self"`).
 */

import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  CoinsIcon,
  ShieldAlertIcon,
  TimerIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react"

import { useReducedMotion } from "motion/react"

import { cn } from "@/lib/utils"
import { StatusBadge } from "@/components/status-badge"
import { useCountUp } from "@/hooks/usage/use-count-up"
import { useTeamLiveStatus } from "@/hooks/agent-runs/use-team-live-status"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import { formatNumber } from "./token-usage-line"
import { TeamRunControls } from "./team-run-controls"

export interface WorkspaceHeaderProps {
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
  /**
   * Open HITL gates waiting on this team (budget / deadlock / plan / …). Rendered
   * as the header's loudest badge because a parked gate is the one state where
   * the run is stopped and only the operator can restart it — every other signal
   * in this header is informational.
   */
  pendingGateCount?: number
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m ${secs}s`
}

export function WorkspaceHeader({
  team,
  teammates,
  onStart,
  onStartUltracode,
  onAbort,
  onPause,
  onResume,
  onStop,
  pendingGateCount = 0,
}: WorkspaceHeaderProps) {
  const t = useTranslations("agentTeamsWorkspace")
  const tOverview = useTranslations("agentTeamsWorkspace.overview")
  const reduce = useReducedMotion() === true
  const liveStatus = useTeamLiveStatus(team)
  const isLive = liveStatus === "executing" || liveStatus === "planning"
  const hasRunControls = Boolean(
    onStart || onStartUltracode || onAbort || onPause || onResume || onStop
  )

  const workers = teammates.filter((m) => m.role === "teammate").length
  const working = teammates.filter(
    (m) => m.status === "executing" || m.status === "planning"
  ).length
  const tokens = team.totalTokenUsage?.totalTokens ?? 0
  const animatedTokens = useCountUp(tokens, { disabled: reduce })
  const duration = team.totalDuration ?? 0
  const initial = team.name.trim().charAt(0).toUpperCase() || "?"

  return (
    <header data-testid="workspace-header">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-border/60 bg-card/60 p-4">
        <span
          className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/25 to-primary/5 text-lg font-semibold text-primary ring-1 ring-inset ring-primary/15"
          aria-hidden
        >
          {initial}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold leading-tight" title={team.name}>
              {team.name}
            </h1>
            <StatusBadge
              value={liveStatus}
              labelNamespace="agentTeam.status"
              pulse={isLive}
              pulseClassName={isLive ? "bg-emerald-400 size-2" : undefined}
              className="shrink-0"
              data-testid="workspace-header-status"
            />
          </div>
          {team.description ? (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{team.description}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {pendingGateCount > 0 ? (
            <span
              data-testid="workspace-pending-gates"
              className="inline-flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive ring-1 ring-inset ring-destructive/25"
              title={t("gatesPending", { count: pendingGateCount })}
            >
              <ShieldAlertIcon className="size-3.5" aria-hidden />
              {t("gatesPending", { count: pendingGateCount })}
            </span>
          ) : null}
          <StatChip
            icon={UsersIcon}
            label={tOverview("teammates")}
            value={workers}
            testid="workspace-stat-members"
          />
          {working > 0 ? (
            <StatChip
              icon={ActivityIcon}
              label={tOverview("mode")}
              value={working}
              tone="live"
              testid="workspace-stat-working"
            />
          ) : null}
          <StatChip
            icon={CoinsIcon}
            label={tOverview("tokenUsage")}
            // Counts up rather than snapping. During a run this is the fastest-
            // moving number on screen; rolling it makes the change legible
            // instead of a digit flicker. `useCountUp` no-ops under reduced
            // motion, so there is no second code path here.
            value={formatNumber(Math.round(animatedTokens))}
            testid="workspace-stat-tokens"
          />
          {duration > 0 ? (
            <StatChip
              icon={TimerIcon}
              label={tOverview("duration")}
              value={formatDuration(duration)}
              testid="workspace-stat-duration"
            />
          ) : null}
        </div>

        {hasRunControls && (
          <TeamRunControls
            className="ml-auto"
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
      </div>
    </header>
  )
}

function StatChip({
  icon: Icon,
  label,
  value,
  tone = "muted",
  testid,
}: {
  icon: LucideIcon
  label: string
  value: string | number
  tone?: "muted" | "live"
  testid?: string
}) {
  return (
    <span
      data-testid={testid}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] tabular-nums",
        tone === "live"
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-muted/60 text-muted-foreground"
      )}
      title={label}
    >
      <Icon className={cn("size-3.5", tone === "live" && "text-emerald-500")} aria-hidden />
      <span className="font-medium text-foreground">{value}</span>
    </span>
  )
}
