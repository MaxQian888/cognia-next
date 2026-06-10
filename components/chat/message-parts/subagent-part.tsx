"use client"

/**
 * SubagentPart renderer — assistant-side rendering of a sub-agent
 * invocation. The static identity bits (id, name, status snapshot at part
 * insertion time) come from the part itself; live `progress` + `logs`
 * come from `useSubagentRuntimeStore` via subscription.
 *
 * Phase 8 of the ClaudeCode 完整化 plan.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { ExternalLinkIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubagentPart as SubagentPartType } from "@/lib/claude/parts-extensions"
import { SUB_AGENT_STATUS_CONFIG } from "@/types/agent/sub-agent"
import { cn } from "@/lib/utils"

interface Props {
  part: SubagentPartType
}

export function SubagentPart({ part }: Props) {
  const t = useTranslations("chat.subagentPart")
  const tStatus = useTranslations("agentStatus")
  // Live read for progress + logs; falls back to the static part snapshot.
  const live = useSubagentRuntimeStore((s) => s.subAgents[part.subagentId])

  const status = live?.status ?? part.status
  const progress = live?.progress ?? part.progress
  const cfg = SUB_AGENT_STATUS_CONFIG[status]
  const logs = live?.logs ?? []
  const lastLog = logs[logs.length - 1]
  const rejection = live?.rejection ?? part.rejection
  const backgrounded = (live?.backgrounded ?? part.backgrounded) === true && status === "running"
  const depth = live?.depth ?? part.depth
  const tokenTotal = (live?.result?.tokenUsage ?? part.tokenUsage)?.totalTokens
  const isRunning = part.completedAt == null && status === "running"
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!isRunning) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isRunning])
  const durationMs =
    part.completedAt != null ? part.completedAt - part.startedAt : now - part.startedAt

  return (
    <div
      className="not-prose my-2 rounded-md border bg-card p-3"
      data-testid={`subagent-part-${part.subagentId}`}
      data-status={status}
    >
      <Collapsible>
        <div className="flex items-center justify-between gap-2">
          <CollapsibleTrigger
            className="flex flex-1 items-center gap-2 text-left"
            data-testid={`subagent-toggle-${part.subagentId}`}
          >
            <span className="text-sm font-medium">{part.name}</span>
            {typeof depth === "number" ? (
              <Badge variant="secondary" className="text-[10px]" data-testid="subagent-depth-badge">
                {t("depthBadge", { n: depth })}
              </Badge>
            ) : null}
            <Badge
              variant="outline"
              className={cn("text-[10px]", cfg.color)}
              data-testid="subagent-status-badge"
            >
              {tStatus(cfg.labelKey)}
            </Badge>
            {backgrounded ? (
              <Badge
                variant="outline"
                className="text-[10px] text-muted-foreground"
                data-testid="subagent-background-badge"
              >
                {t("backgroundRunning")}
              </Badge>
            ) : null}
            {typeof tokenTotal === "number" && tokenTotal > 0 ? (
              <Badge
                variant="outline"
                className="text-[10px] text-muted-foreground"
                data-testid="subagent-tokens-badge"
              >
                {t("tokens", { n: tokenTotal })}
              </Badge>
            ) : null}
            <span className="ml-auto text-[11px] text-muted-foreground">
              {t("durationMs", { ms: durationMs })}
            </span>
          </CollapsibleTrigger>
        </div>
        {rejection ? (
          <p
            className="mt-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
            data-testid="subagent-rejection"
          >
            {rejection.reason === "cycle" ? t("rejected.cycle") : t("rejected.maxDepth")}
          </p>
        ) : null}
        <Progress value={progress} className="mt-2 h-1.5" />
        <CollapsibleContent className="mt-2 space-y-2">
          {part.summary ? <p className="rounded bg-muted/30 p-2 text-xs">{part.summary}</p> : null}
          {logs.length > 0 ? (
            <div className="space-y-0.5" data-testid="subagent-logs">
              {logs.slice(-50).map((log, i) => (
                <p key={i} className="font-mono text-[11px] text-muted-foreground">
                  <span className="mr-1 uppercase">[{log.level}]</span>
                  {log.message}
                </p>
              ))}
            </div>
          ) : lastLog ? (
            <p className="font-mono text-[11px] text-muted-foreground">{lastLog.message}</p>
          ) : (
            <p className="text-[11px] italic text-muted-foreground">{t("noLogsYet")}</p>
          )}
          <Link
            href={`/agent-teams?focus=subagent:${part.subagentId}`}
            className="inline-flex items-center gap-1 text-xs underline"
            data-testid="subagent-open"
          >
            {t("openInWorkspace")}
            <ExternalLinkIcon className="size-3" />
          </Link>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
