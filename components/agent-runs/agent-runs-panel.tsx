"use client"

/**
 * Unified "Agent Runs" master-detail panel (Scheduler Phase D).
 *
 * Lists every live + recent goal / team / plan / scheduled agent run from
 * `useAgentRuns`, with kind filters, and a detail pane for the selected run
 * that offers abort / pause / resume (routed by `useAgentRunActions`). The
 * selected run is controlled by the parent so it can mirror a `?run=` query
 * param (static-export-safe deep links).
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ActivityIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { InspectRow } from "@/components/scheduler/details/_shared/inspect-row"
import { PlanTrackerPanel } from "@/components/agent/plan/plan-tracker-panel"
import { usePlanById } from "@/hooks/agent/use-session-plan"
import { formatDuration, formatRelativeTime } from "@/lib/scheduler/format-utils"
import { useAgentRuns } from "@/hooks/agent-runs/use-agent-runs"
import { useAgentRunActions } from "@/hooks/agent-runs/use-agent-run-actions"
import type { AgentRun, AgentRunKind } from "@/types/agent-runs/agent-run"
import { AgentRunStatusPill } from "./agent-run-status-pill"

const KIND_FILTERS: Array<AgentRunKind | "all"> = ["all", "goal", "team", "plan", "scheduled-task"]

const FILTER_I18N: Record<AgentRunKind | "all", string> = {
  all: "all",
  goal: "goal",
  team: "team",
  plan: "plan",
  "scheduled-task": "scheduledTask",
}

export interface AgentRunsPanelProps {
  selectedId?: string
  onSelect: (unifiedId: string | null) => void
  filterKind?: AgentRunKind | "all"
  onFilterKind?: (kind: AgentRunKind | "all") => void
}

export function AgentRunsPanel({
  selectedId,
  onSelect,
  filterKind = "all",
  onFilterKind,
}: AgentRunsPanelProps) {
  const t = useTranslations("agentRuns")
  const { runs, isLoading } = useAgentRuns({
    filterKind: filterKind === "all" ? undefined : filterKind,
  })
  const actions = useAgentRunActions()

  const selected = useMemo(
    () => runs.find((r) => r.unifiedId === selectedId) ?? null,
    [runs, selectedId]
  )

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <FeaturePageHeader
        variant="compact"
        icon={<ActivityIcon />}
        title={t("title")}
        description={t("description")}
        controls={
          <div className="flex gap-1.5" role="tablist" aria-label={t("title")}>
            {KIND_FILTERS.map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={filterKind === k}
                onClick={() => onFilterKind?.(k)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  filterKind === k
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/70"
                )}
              >
                {t(`filters.${FILTER_I18N[k]}`)}
              </button>
            ))}
          </div>
        }
      />

      <div className="flex min-h-0 flex-1">
        {/* List */}
        <ul
          className="w-full min-w-0 max-w-sm shrink-0 overflow-y-auto border-r"
          aria-label={t("title")}
        >
          {!isLoading && runs.length === 0 && (
            <li className="p-4 text-center text-xs text-muted-foreground">{t("empty")}</li>
          )}
          {runs.map((run) => (
            <li key={run.unifiedId}>
              <button
                type="button"
                onClick={() => onSelect(run.unifiedId)}
                aria-current={selectedId === run.unifiedId}
                className={cn(
                  "flex w-full flex-col gap-1 border-b px-3 py-2 text-left hover:bg-muted/50",
                  selectedId === run.unifiedId && "bg-muted"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{run.title}</span>
                  <AgentRunStatusPill status={run.status} />
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="uppercase">{t(`kind.${FILTER_I18N[run.kind]}`)}</span>
                  <span>·</span>
                  <span>{formatRelativeTime(new Date(run.startedAt))}</span>
                  {run.isLive && (
                    <span className="ml-auto inline-flex items-center gap-1 text-blue-500">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
                      {t("live")}
                    </span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>

        {/* Detail */}
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {selected ? (
            <AgentRunDetail run={selected} actions={actions} />
          ) : (
            <p className="pt-8 text-center text-sm text-muted-foreground">
              {t("detail.selectPrompt")}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Live step tracker for a plan run. Renders nothing for other run kinds, or
 * while the plan row has not loaded — the surrounding detail pane stays useful
 * either way.
 */
function PlanRunSteps({ run }: { run: AgentRun }) {
  const planId = run.kind === "plan" ? (run.origin.planId ?? run.origin.nativeId) : undefined
  const plan = usePlanById(planId)
  if (!plan) return null
  return <PlanTrackerPanel plan={plan} />
}

function AgentRunDetail({
  run,
  actions,
}: {
  run: AgentRun
  actions: ReturnType<typeof useAgentRunActions>
}) {
  const t = useTranslations("agentRuns")
  const dur = run.finishedAt ? formatDuration(run.finishedAt - run.startedAt) : undefined

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 break-words text-base font-semibold">{run.title}</h2>
        <AgentRunStatusPill status={run.status} />
      </div>

      <div>
        <InspectRow label={t("detail.kind")} value={t(`kind.${FILTER_I18N[run.kind]}`)} />
        <InspectRow label={t("detail.status")} value={t(`status.${run.status}`)} />
        <InspectRow
          label={t("detail.started")}
          value={formatRelativeTime(new Date(run.startedAt))}
        />
        {run.finishedAt && (
          <InspectRow
            label={t("detail.finished")}
            value={`${formatRelativeTime(new Date(run.finishedAt))} (${dur})`}
          />
        )}
        {typeof run.progress === "number" && (
          <InspectRow label={t("detail.progress")} value={`${Math.round(run.progress * 100)}%`} />
        )}
        {typeof run.tokensUsed === "number" && (
          <InspectRow label={t("detail.tokens")} value={String(run.tokensUsed)} />
        )}
        {run.error && <InspectRow label={t("detail.error")} value={run.error.message} />}
      </div>

      {/* A plan run's steps are the run. Without this the detail pane showed a
          percentage for a plan started headlessly (scheduler / workflow node /
          external bridge) and the step list was reachable only from the chat
          session that happened to own it. */}
      <PlanRunSteps run={run} />

      <div className="flex flex-wrap gap-2">
        {actions.canPause(run) && (
          <Button size="sm" variant="outline" onClick={() => void actions.pause(run)}>
            {t("actions.pause")}
          </Button>
        )}
        {actions.canResume(run) && (
          <Button size="sm" variant="outline" onClick={() => void actions.resume(run)}>
            {t("actions.resume")}
          </Button>
        )}
        {actions.canAbort(run) && (
          <Button size="sm" variant="destructive" onClick={() => void actions.abort(run)}>
            {t("actions.abort")}
          </Button>
        )}
      </div>
    </div>
  )
}
