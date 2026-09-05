"use client"

/**
 * The small badges a card, a row and the mobile list print from an issue's
 * planning hint: blocked, sub-issue progress, due state, estimate.
 *
 * One component for the three surfaces, so "blocked" looks the same on the
 * board, in the list and on a phone, and so a new badge is added in one place.
 * Pure: everything it prints is already in the hint or on the item.
 */

import { BanIcon, CalendarClockIcon, GitForkIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import type { IssuePlanningHint } from "@/lib/issues/planning-hints"
import { cn } from "@/lib/utils"
import type { UnifiedIssueItem } from "@/types/issues/unified"

export interface PlanningBadgesProps {
  item: Pick<UnifiedIssueItem, "unifiedId" | "estimate" | "dueDate">
  hint?: IssuePlanningHint
  /** Print the estimate too. Off on the board, where space is the scarce thing. */
  showEstimate?: boolean
  className?: string
}

const DUE_TONE: Record<"overdue" | "today" | "soon", string> = {
  overdue: "border-destructive/50 text-destructive",
  today: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  soon: "text-muted-foreground",
}

export function PlanningBadges({ item, hint, showEstimate, className }: PlanningBadgesProps) {
  const t = useTranslations("issues.planning")
  const dueVisible = hint && (hint.due === "overdue" || hint.due === "today" || hint.due === "soon")
  const estimateVisible = showEstimate && item.estimate !== undefined
  if (!hint?.blocked && !hint?.subIssues && !dueVisible && !estimateVisible) return null

  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {hint?.blocked ? (
        <Badge
          variant="outline"
          className="h-5 gap-1 border-destructive/50 px-1.5 text-[10px] font-normal text-destructive"
          title={t("blockedByList", { list: hint.blockerIdentifiers.join(", ") })}
          data-testid={`issue-badge-blocked-${item.unifiedId}`}
        >
          <BanIcon aria-hidden className="size-3" />
          {t("blocked")}
        </Badge>
      ) : null}
      {hint?.subIssues ? (
        <Badge
          variant="outline"
          className="h-5 gap-1 px-1.5 text-[10px] font-normal"
          title={t("subIssuesTitle", { done: hint.subIssues.done, total: hint.subIssues.total })}
          data-testid={`issue-badge-subissues-${item.unifiedId}`}
        >
          <GitForkIcon aria-hidden className="size-3" />
          {hint.subIssues.done}/{hint.subIssues.total}
        </Badge>
      ) : null}
      {dueVisible && item.dueDate !== undefined ? (
        <Badge
          variant="outline"
          className={cn(
            "h-5 gap-1 px-1.5 text-[10px] font-normal",
            DUE_TONE[hint.due as keyof typeof DUE_TONE]
          )}
          title={t(`due.${hint.due}`)}
          data-testid={`issue-badge-due-${item.unifiedId}`}
          data-due={hint.due}
        >
          <CalendarClockIcon aria-hidden className="size-3" />
          {formatDueDate(item.dueDate)}
        </Badge>
      ) : null}
      {estimateVisible ? (
        <Badge
          variant="outline"
          className="h-5 px-1.5 text-[10px] font-normal"
          title={t("estimate")}
          data-testid={`issue-badge-estimate-${item.unifiedId}`}
        >
          {t("points", { count: item.estimate ?? 0 })}
        </Badge>
      ) : null}
    </span>
  )
}

/** Month and day only. The year is noise on a board about this quarter. */
export function formatDueDate(dueDate: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(dueDate)
}
