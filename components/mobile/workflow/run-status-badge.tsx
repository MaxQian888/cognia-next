"use client"

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import type { RunStatus } from "@/types/workflow/visual"
import { cn } from "@/lib/utils"

const STATUS_CLASS: Record<RunStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-300",
  waiting: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  paused: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  succeeded: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
}

const STATUS_KEY: Record<RunStatus, string> = {
  pending: "statusWaiting",
  running: "statusRunning",
  waiting: "statusWaiting",
  paused: "statusWaiting",
  succeeded: "statusSucceeded",
  failed: "statusFailed",
  cancelled: "statusCancelled",
}

export interface RunStatusBadgeProps {
  status: RunStatus
  className?: string
}

export function RunStatusBadge({ status, className }: RunStatusBadgeProps) {
  const t = useTranslations("mobile.workflow")
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] font-medium border-transparent", STATUS_CLASS[status], className)}
      data-testid={`run-status-${status}`}
    >
      {t(STATUS_KEY[status])}
    </Badge>
  )
}
