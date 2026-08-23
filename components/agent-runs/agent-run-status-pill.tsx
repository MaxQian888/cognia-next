"use client"

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { UnifiedExecutionStatus } from "@/lib/execution/monitor-model"

/**
 * Status pill for the task cockpit.
 *
 * Keyed on `UnifiedExecutionStatus` — the status every source normalizes to —
 * rather than on the four-kind `AgentRunStatus` it used to take. That older
 * union had no `queued`, so a run waiting for a slot rendered as running.
 *
 * `cancelled` is deliberately muted rather than red: the user asked for it, and
 * colouring a deliberate stop like a failure is a small lie the cockpit repeats
 * on every row.
 */
const STATUS_CLASSES: Record<UnifiedExecutionStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  waiting: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  error: "bg-red-500/15 text-red-600 dark:text-red-400",
  cancelled: "bg-muted text-muted-foreground",
}

export function ExecutionStatusPill({
  status,
  className,
}: {
  status: UnifiedExecutionStatus
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
