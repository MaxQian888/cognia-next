"use client"

/**
 * Compact Agent Team status panel for the Context Workbench.
 *
 * Shows all active teammates with their current status, progress, and last
 * activity. For the full agent workspace (tasks, messages, delegation), use the
 * agent workspace tab.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { BotIcon, ExternalLinkIcon } from "lucide-react"
import Link from "next/link"
import type { TeammateStatus } from "@/types/agent/agent-team"
import {
  useAgentTeamStore,
  selectActiveTeam,
  selectActiveTeammates,
} from "@/stores/agent/agent-team-store"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"

const STATUS_COLORS: Record<TeammateStatus, string> = {
  idle: "bg-muted-foreground",
  planning: "bg-blue-500",
  awaiting_approval: "bg-yellow-500",
  executing: "bg-green-500",
  paused: "bg-orange-500",
  completed: "bg-emerald-600",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/50",
  shutdown: "bg-muted-foreground/30",
}

export function AgentStatusWorkbenchPanel() {
  const t = useTranslations("contextWorkbench.agentStatusPanel")
  const team = useAgentTeamStore(selectActiveTeam)
  const teammates = useAgentTeamStore(selectActiveTeammates)

  const activeCount = useMemo(
    () => teammates.filter((tm) => tm.status === "executing" || tm.status === "planning").length,
    [teammates]
  )

  if (!team) {
    return (
      <Empty className="h-full rounded-none">
        <EmptyMedia variant="icon">
          <BotIcon />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{t("noTeam")}</EmptyTitle>
        <EmptyDescription className="text-xs">{t("noTeamDescription")}</EmptyDescription>
      </Empty>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Team header */}
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="truncate text-sm font-medium">{team.name}</span>
        <Badge variant="secondary" className="text-[10px]">
          {t("active", { count: activeCount })}
        </Badge>
      </div>

      {/* Teammates list */}
      <ScrollArea className="flex-1">
        {teammates.length === 0 ? (
          <Empty className="h-32 rounded-none">
            <EmptyTitle className="text-sm">{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription className="text-xs">{t("emptyDescription")}</EmptyDescription>
          </Empty>
        ) : (
          <div className="divide-y">
            {teammates.map((teammate) => (
              <div
                key={teammate.id}
                className="flex flex-col gap-1 px-3 py-2"
                data-testid={`teammate-row-${teammate.id}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn("size-2 shrink-0 rounded-full", STATUS_COLORS[teammate.status])}
                    aria-label={t(`statuses.${teammate.status}`)}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {teammate.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t(`statuses.${teammate.status}`)}
                  </span>
                </div>
                {teammate.status === "executing" && teammate.progress > 0 && (
                  <Progress value={teammate.progress} className="h-1" />
                )}
                {teammate.lastActivity && (
                  <p className="truncate text-[10px] text-muted-foreground">
                    {teammate.lastActivity}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Footer */}
      <div className="shrink-0 border-t p-2">
        <Button variant="ghost" size="sm" className="w-full text-xs" asChild>
          <Link href="/agent-team">
            <ExternalLinkIcon className="mr-1.5 size-3" />
            {t("openFullPage")}
          </Link>
        </Button>
      </div>
    </div>
  )
}
