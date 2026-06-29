"use client"

/**
 * SubagentRuntimeTab — live read of the runtime registry maintained by
 * `subagent-runtime-store`. Empty until a Rust orchestrator pushes events;
 * the empty-state copy makes that clear so the tab doesn't feel broken.
 *
 * Phase 6 of the ClaudeCode 完整化 plan.
 */

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowRightIcon, ClockIcon, InfoIcon } from "lucide-react"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsGroup,
} from "@/components/settings/common/settings-section"
import { SUB_AGENT_STATUS_CONFIG, SUB_AGENT_PRIORITY_CONFIG } from "@/types/agent/sub-agent"

/** Format milliseconds into a human-readable duration. */
function formatDuration(ms: number): string {
  ms = Math.max(0, ms)
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMin = minutes % 60
  return `${hours}h ${remainingMin}m`
}

export function SubagentRuntimeTab() {
  const t = useTranslations("settings.subagents.runtime")
  const tStatus = useTranslations("agentStatus")
  const tPriority = useTranslations("agentPriority")
  const subAgents = useSubagentRuntimeStore((s) => s.subAgents)

  const sorted = useMemo(() => {
    return Object.values(subAgents).sort((a, b) => {
      const aDate = a.lastActivityAt instanceof Date ? a.lastActivityAt.getTime() : 0
      const bDate = b.lastActivityAt instanceof Date ? b.lastActivityAt.getTime() : 0
      return bDate - aDate
    })
  }, [subAgents])

  const hasRunning = useMemo(
    () => sorted.some((sa) => sa.startedAt instanceof Date && !(sa.completedAt instanceof Date)),
    [sorted]
  )
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!hasRunning) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [hasRunning])

  const calloutBanner = (
    <Alert data-testid="subagent-runtime-callout">
      <InfoIcon />
      <AlertTitle>{t("callout.title")}</AlertTitle>
      <AlertDescription>
        <p>{t("callout.body")}</p>
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" asChild>
          <Link href="/agent-teams">
            {t("callout.cta")}
            <ArrowRightIcon className="ml-1 size-3" />
          </Link>
        </Button>
      </AlertDescription>
    </Alert>
  )

  if (sorted.length === 0) {
    return (
      <div className="space-y-3" data-testid="subagent-runtime-empty">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        {calloutBanner}
        <SettingsEmptyState
          icon={<ClockIcon className="size-5" />}
          title={t("emptyTitle")}
          description={t("emptyBody")}
        />
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="subagent-runtime-list">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {calloutBanner}
      {sorted.map((sa) => {
        const statusCfg = SUB_AGENT_STATUS_CONFIG[sa.status]
        const priorityCfg = sa.config?.priority
          ? SUB_AGENT_PRIORITY_CONFIG[sa.config.priority]
          : null
        const startedAt = sa.startedAt instanceof Date ? sa.startedAt.getTime() : null
        const completedAt = sa.completedAt instanceof Date ? sa.completedAt.getTime() : null
        const durationMs = startedAt ? (completedAt ?? now) - startedAt : null
        const recentLogs = sa.logs.slice(-3)

        return (
          <div key={sa.id} data-testid={`subagent-runtime-row-${sa.id}`} data-status={sa.status}>
            <SettingsCard
              title={sa.name}
              description={
                durationMs !== null
                  ? `${t("duration", { ms: durationMs })} (${formatDuration(durationMs)})`
                  : undefined
              }
              badge={tStatus(statusCfg.labelKey)}
              badgeVariant={
                sa.status === "failed" || sa.status === "timeout"
                  ? "destructive"
                  : sa.status === "completed"
                    ? "default"
                    : "secondary"
              }
              headerAction={
                priorityCfg ? (
                  <Badge variant="outline" className="text-[10px]">
                    {tPriority(priorityCfg.labelKey)}
                  </Badge>
                ) : null
              }
            >
              {/* Honest tool-use count (gap9) — replaces the old pseudo-percentage
                  bar, which implied a completion ratio a subagent run doesn't have.
                  Matches the chat transcript card. */}
              {(sa.toolUses ?? 0) > 0 ? (
                <p
                  className="text-[11px] tabular-nums text-muted-foreground"
                  data-testid={`subagent-runtime-tools-${sa.id}`}
                >
                  {t("toolsRunCount", { n: sa.toolUses ?? 0 })}
                </p>
              ) : null}

              {/* Metadata */}
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>{t("parent", { id: sa.parentAgentId })}</span>
                {sa.config?.model && <span>{sa.config.model}</span>}
                {sa.config?.tools && sa.config.tools.length > 0 && (
                  <span>{t("toolsCount", { count: sa.config.tools.length })}</span>
                )}
              </div>

              {/* Recent logs */}
              {recentLogs.length > 0 && (
                <div className="space-y-0.5">
                  {recentLogs.map((log, i) => (
                    <p key={i} className="line-clamp-1 font-mono text-[11px] text-muted-foreground">
                      <span className="mr-1 uppercase">[{log.level}]</span>
                      {log.message}
                    </p>
                  ))}
                </div>
              )}

              {/* Expandable full log */}
              {sa.logs.length > 3 && (
                <SettingsGroup title={t("allLogs", { count: sa.logs.length })} defaultOpen={false}>
                  <div className="max-h-40 space-y-0.5 overflow-y-auto font-mono text-[11px]">
                    {sa.logs.map((log, i) => (
                      <p key={i} className="text-muted-foreground">
                        <span className="mr-1 uppercase">[{log.level}]</span>
                        {log.message}
                      </p>
                    ))}
                  </div>
                </SettingsGroup>
              )}
            </SettingsCard>
          </div>
        )
      })}
    </div>
  )
}
