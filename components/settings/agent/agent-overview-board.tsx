"use client"

/**
 * AgentOverviewBoard — the "All agents" landing view.
 *
 * A collapsible fleet banner (connected / total) over one row per agent:
 * brand icon, name, state pill, the compact readiness pipeline, the block
 * reason when there is one, and a single next-action button — the thing the
 * model says would most move this agent toward ready. Clicking the row opens
 * the agent's inspector.
 */

import { ChevronDown, ChevronUp, Loader2, Plus } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { BrandIcon } from "@/components/icons/brand-icon"
import { cn } from "@/lib/utils"
import { isFromPreset } from "@/lib/ai/agent/external/presets"
import type { AgentReadiness, AgentReadinessAction } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"
import { AgentReadinessPipeline, AgentStatePill } from "./agent-readiness-pipeline"

export interface OverviewAgentEntry {
  agent: LifecycleExternalAgentConfig
  readiness: AgentReadiness
}

const ACTION_LABEL_KEY: Record<AgentReadinessAction, string> = {
  enable: "actions.enable",
  inspect: "actions.inspect",
  retry: "actions.retry",
  connect: "actions.connect",
  "add-rule": "actions.addRule",
}

export function AgentOverviewBoard({
  entries,
  enabled,
  bannerCollapsed,
  onBannerCollapsedChange,
  onOpenAgent,
  onAction,
  onNewAgent,
}: {
  entries: OverviewAgentEntry[]
  /** Master switch — connect/retry row actions are inert while it is off. */
  enabled: boolean
  bannerCollapsed: boolean
  onBannerCollapsedChange: (collapsed: boolean) => void
  onOpenAgent: (agentId: string) => void
  /** Runs the model's suggested next step for the agent. */
  onAction: (agentId: string, action: AgentReadinessAction) => void
  onNewAgent: () => void
}) {
  const t = useTranslations("externalAgent.settings")
  const tReadiness = useTranslations("externalAgent.readiness")

  const connectedCount = entries.filter((e) => e.readiness.state === "connected").length
  const total = entries.length
  const percent = total > 0 ? Math.round((connectedCount / total) * 100) : 0

  return (
    <div className="space-y-4" data-testid="agent-overview-board">
      {/* Fleet banner — collapsible. The collapsed one-liner keeps the
          connected/total count on screen without the card chrome, and the
          state persists in the store so a reload does not reopen it. */}
      {total > 0 ? (
        bannerCollapsed ? (
          <div
            className="flex items-center gap-3 rounded-lg border px-3 py-2"
            data-testid="fleet-banner-collapsed"
          >
            <span className="text-sm font-medium">
              {t("fleetBannerCollapsed", { connected: connectedCount, total })}
            </span>
            <Progress value={percent} className="h-1.5 flex-1" aria-hidden />
            <span className="text-xs text-muted-foreground">{percent}%</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t("fleetShowSummary")}
              data-testid="fleet-banner-expand"
              onClick={() => onBannerCollapsedChange(false)}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <div
            className="rounded-lg border bg-muted/20 px-4 py-3"
            data-testid="fleet-banner-expanded"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {t("fleetBannerConnected", { connected: connectedCount, total })}
                </p>
                <div className="mt-2 flex items-center gap-3">
                  <Progress value={percent} className="h-1.5 w-40" aria-hidden />
                  <span className="text-xs text-muted-foreground">{percent}%</span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                aria-label={t("fleetHideSummary")}
                data-testid="fleet-banner-collapse"
                onClick={() => onBannerCollapsedChange(true)}
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )
      ) : (
        <Empty className="border" data-testid="overview-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Plus className="h-4 w-4" />
            </EmptyMedia>
            <EmptyTitle>{t("noAgentsConfigured")}</EmptyTitle>
            <EmptyDescription>{t("addAgentToStart")}</EmptyDescription>
          </EmptyHeader>
          <Button
            size="sm"
            onClick={onNewAgent}
            disabled={!enabled}
            data-testid="overview-add-agent"
          >
            {t("addAgent")}
          </Button>
        </Empty>
      )}

      {/* One row per agent: name, pill, pipeline, block reason, next action. */}
      <div className="divide-y rounded-lg border" data-testid="overview-rows">
        {entries.map(({ agent, readiness }) => {
          const presetId = isFromPreset(agent)
          const action = readiness.nextAction
          return (
            <div
              key={agent.id}
              className="flex items-center gap-3 px-3 py-2.5"
              data-testid={`overview-row-${agent.id}`}
            >
              <Button
                type="button"
                variant="ghost"
                className="h-auto min-w-0 flex-1 justify-start gap-3 whitespace-normal rounded-md px-1 py-1 text-left font-normal hover:bg-transparent"
                onClick={() => onOpenAgent(agent.id)}
                data-testid={`overview-open-${agent.id}`}
              >
                <BrandIcon id={presetId ?? agent.name} label={agent.name} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{agent.name}</span>
                    <AgentStatePill readiness={readiness} />
                  </span>
                  <span className="mt-1 flex items-center gap-2">
                    <AgentReadinessPipeline readiness={readiness} compact />
                    {readiness.blockReason ? (
                      <span
                        className={cn(
                          "truncate text-[11px]",
                          readiness.blockTransient
                            ? "text-muted-foreground"
                            : "text-amber-600 dark:text-amber-400"
                        )}
                      >
                        {readiness.blockReason}
                      </span>
                    ) : (
                      <span className="truncate text-[11px] text-muted-foreground">
                        {agent.protocol} · {agent.transport}
                      </span>
                    )}
                  </span>
                </span>
              </Button>
              {action ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  data-testid={`overview-action-${agent.id}`}
                  disabled={!enabled && (action === "connect" || action === "retry")}
                  onClick={() => onAction(agent.id, action)}
                >
                  {tReadiness(ACTION_LABEL_KEY[action])}
                </Button>
              ) : readiness.state === "connecting" ? (
                <Loader2
                  className="h-4 w-4 shrink-0 animate-spin text-muted-foreground"
                  aria-hidden
                />
              ) : (
                <Badge variant="outline" className="shrink-0 font-normal">
                  {tReadiness("states.ready")}
                </Badge>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
