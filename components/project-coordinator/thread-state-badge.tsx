"use client"

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { ThreadBoardState } from "@/lib/project-coordinator/thread-state"

/** Tone per state: what needs the user stands out, finished work recedes. */
const TONE: Record<ThreadBoardState, string> = {
  waiting: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  "ready-for-review": "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  working: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  staged: "text-muted-foreground",
  landing: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  idle: "text-muted-foreground",
  resolved: "text-muted-foreground opacity-70",
}

export function ThreadStateBadge({
  state,
  className,
}: {
  state: ThreadBoardState
  className?: string
}) {
  const t = useTranslations("projectCoordinator.state")
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 text-[10px] font-medium", TONE[state], className)}
      data-testid={`thread-state-${state}`}
    >
      {t(state)}
    </Badge>
  )
}
