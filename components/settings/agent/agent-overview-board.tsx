"use client"

/** Summary and actionable attention for the fleet, with optional routing kept separate. */

import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { BrandIcon } from "@/components/icons/brand-icon"
import { PresetPickerList } from "@/components/agent/external-agent/add-agent/preset-picker-list"
import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { cn } from "@/lib/utils"
import { isFromPreset } from "@/lib/ai/agent/external/config/presets"
import type { AgentReadiness, AgentReadinessAction } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"
import type { InstanceTrait } from "@/components/agent/external-agent/instance-traits"
import { AgentStatePill } from "./agent-readiness-pipeline"
import { groupForState, type AgentStateFilter } from "./external-agent-rail"

export interface OverviewAgentEntry {
  agent: LifecycleExternalAgentConfig
  readiness: AgentReadiness
  traits?: readonly InstanceTrait[]
  failureHeadline?: string
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
  stateFilter,
  onStateFilterChange,
  onOpenAgent,
  onAction,
  onPickPreset,
}: {
  entries: OverviewAgentEntry[]
  enabled: boolean
  stateFilter: AgentStateFilter
  onStateFilterChange: (filter: AgentStateFilter) => void
  onOpenAgent: (agentId: string) => void
  onAction: (agentId: string, action: AgentReadinessAction) => void
  onPickPreset: (presetId: string) => void
}) {
  const t = useTranslations("externalAgent.overview")
  const tSettings = useTranslations("externalAgent.settings")
  const tReadiness = useTranslations("externalAgent.readiness")
  const counts = { connected: 0, attention: 0, off: 0 }
  for (const { readiness } of entries) counts[groupForState(readiness.state)] += 1
  const attention = entries.filter(
    ({ readiness }) =>
      readiness.blockReason || (readiness.nextAction && readiness.nextAction !== "add-rule")
  )
  const suggestions = entries.filter(
    ({ readiness }) =>
      readiness.state === "connected" &&
      !readiness.blockReason &&
      readiness.nextAction === "add-rule"
  )

  return (
    <div className="flex min-h-full min-w-0 flex-col gap-4" data-testid="agent-overview-board">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold" tabIndex={-1} data-detail-heading="overview">
          {entries.length ? tSettings("allAgents") : t("firstAgentTitle")}
        </h2>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("firstAgentDescription")}</p>
        ) : null}
      </header>
      {entries.length === 0 ? (
        <div className="min-w-0 space-y-4" data-testid="overview-empty">
          <PresetPickerList onPick={onPickPreset} disabled={!enabled} />
        </div>
      ) : (
        <>
          <div
            className="flex flex-wrap items-center gap-x-1 gap-y-2"
            data-testid="overview-state-filters"
          >
            {(["connected", "attention", "off"] as const).map((filter, index) => (
              <span key={filter} className="inline-flex min-w-0 items-center gap-1">
                {index > 0 ? (
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                ) : null}
                <Button
                  size="sm"
                  variant={stateFilter === filter ? "secondary" : "ghost"}
                  className="h-auto whitespace-normal px-2 py-1 text-left"
                  aria-pressed={stateFilter === filter}
                  data-testid={`overview-filter-${filter}`}
                  onClick={() => onStateFilterChange(stateFilter === filter ? "all" : filter)}
                >
                  {t(filter)} <span className="tabular-nums">{counts[filter]}</span>
                </Button>
              </span>
            ))}
          </div>
          <SettingsStack>
            <SettingsBlock title={t("attention")} headingLevel={3}>
              {attention.length ? (
                <div className="divide-y" data-testid="overview-rows">
                  {attention.map(({ agent, readiness, failureHeadline }) => {
                    const action = readiness.nextAction
                    const reason = readiness.blockReason ?? failureHeadline
                    return (
                      <div
                        key={agent.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0"
                        data-testid={`overview-row-${agent.id}`}
                      >
                        <Button
                          variant="ghost"
                          className="h-auto min-w-0 flex-1 basis-48 justify-start gap-3 whitespace-normal px-0 py-1 text-left font-normal hover:bg-transparent"
                          onClick={() => onOpenAgent(agent.id)}
                          data-testid={`overview-open-${agent.id}`}
                        >
                          <BrandIcon
                            id={isFromPreset(agent) ?? agent.name}
                            label={agent.name}
                            size={20}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="min-w-0 break-words text-sm font-medium">
                                {agent.name}
                              </span>
                              <AgentStatePill readiness={readiness} />
                            </span>
                            {reason ? (
                              <span
                                className={cn(
                                  "mt-1 block break-words text-xs",
                                  readiness.blockTransient
                                    ? "text-muted-foreground"
                                    : "text-amber-600 dark:text-amber-400"
                                )}
                              >
                                {reason}
                              </span>
                            ) : null}
                          </span>
                        </Button>
                        {action && action !== "add-rule" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="ml-auto shrink-0"
                            data-testid={`overview-action-${agent.id}`}
                            disabled={!enabled && action !== "inspect"}
                            onClick={() => onAction(agent.id, action)}
                          >
                            {tReadiness(ACTION_LABEL_KEY[action])}
                          </Button>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p
                  className="text-sm text-muted-foreground"
                  role="status"
                  data-testid="overview-all-clear"
                >
                  {t("allClear", { count: counts.connected })}
                </p>
              )}
            </SettingsBlock>
            {suggestions.length ? (
              <SettingsBlock
                title={t("suggestions")}
                headingLevel={3}
                className="text-muted-foreground"
              >
                <ul className="divide-y" data-testid="overview-suggestions">
                  {suggestions.map(({ agent }) => (
                    <li
                      key={agent.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                      data-testid={`overview-suggestion-${agent.id}`}
                    >
                      <span className="min-w-0 break-words text-xs">{agent.name}</span>
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto whitespace-normal px-0 py-1 text-xs text-muted-foreground"
                        disabled={!enabled}
                        onClick={() => onAction(agent.id, "add-rule")}
                      >
                        {tReadiness("actions.addRule")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </SettingsBlock>
            ) : null}
          </SettingsStack>
        </>
      )}
    </div>
  )
}
