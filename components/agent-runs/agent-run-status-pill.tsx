"use client"

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { AgentRunStatus } from "@/types/agent-runs/agent-run"

const STATUS_CLASSES: Record<AgentRunStatus, string> = {
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  paused: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  succeeded: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  cancelled: "bg-muted text-muted-foreground",
}

export function AgentRunStatusPill({
  status,
  className,
}: {
  status: AgentRunStatus
  className?: string
}) {
  const t = useTranslations("agentRuns.status")
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        STATUS_CLASSES[status],
        className
      )}
    >
      {t(status)}
    </span>
  )
}
