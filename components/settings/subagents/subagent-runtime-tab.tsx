"use client"

/**
 * SubagentRuntimeTab — live read of the runtime registry maintained by
 * `subagent-runtime-store`. Empty until a Rust orchestrator pushes events;
 * the empty-state copy makes that clear so the tab doesn't feel broken.
 *
 * Phase 6 of the ClaudeCode 完整化 plan.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { SUB_AGENT_STATUS_CONFIG } from "@/types/agent/sub-agent"

export function SubagentRuntimeTab() {
  const t = useTranslations("settings.subagents.runtime")
  const tStatus = useTranslations("agentStatus")
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

  if (sorted.length === 0) {
    return (
      <div className="space-y-2" data-testid="subagent-runtime-empty">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        <Card className="border-dashed bg-muted/30 p-6 text-center">
          <p className="text-sm font-medium">{t("emptyTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("emptyBody")}</p>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="subagent-runtime-list">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {sorted.map((sa) => {
        const cfg = SUB_AGENT_STATUS_CONFIG[sa.status]
        const lastLog = sa.logs[sa.logs.length - 1]
        const startedAt = sa.startedAt instanceof Date ? sa.startedAt.getTime() : null
        const completedAt = sa.completedAt instanceof Date ? sa.completedAt.getTime() : null
        const durationMs = startedAt ? (completedAt ?? now) - startedAt : null
        return (
          <Card
            key={sa.id}
            className="space-y-2 p-3"
            data-testid={`subagent-runtime-row-${sa.id}`}
            data-status={sa.status}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">{sa.name}</p>
                <Badge variant="outline" className={`text-[10px] ${cfg.color}`}>
                  {tStatus(cfg.labelKey)}
                </Badge>
                <span className="text-[11px] text-muted-foreground">
                  {t("parent", { id: sa.parentAgentId })}
                </span>
              </div>
              {durationMs !== null ? (
                <span className="text-[11px] text-muted-foreground">
                  {t("duration", { ms: durationMs })}
                </span>
              ) : null}
            </div>
            <Progress value={sa.progress} className="h-1.5" />
            {lastLog ? (
              <p className="line-clamp-1 font-mono text-[11px] text-muted-foreground">
                <span className="mr-1 uppercase">[{lastLog.level}]</span>
                {lastLog.message}
              </p>
            ) : null}
          </Card>
        )
      })}
    </div>
  )
}
