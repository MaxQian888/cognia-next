"use client"

/**
 * MobileSchedulerStatStrip: the four scheduler numbers, all four visible.
 *
 * This used to be a snap-scrolling carousel of `StatCard`s at `w-[42%]`, which
 * put two and a half cards on a 375px screen and left the rest behind a
 * horizontal swipe with no affordance pointing at it. A summary whose job is to
 * answer "is anything wrong here" cannot hide half its answer, and the two that
 * scrolled off were the executions count and the success rate: the two numbers
 * that actually carry bad news.
 *
 * It is now the shared `StatStrip`, one hairline instrument in a 2x2 grid
 * rather than four floating boxes with gradient accents. `StatStrip`'s own
 * header says it is not a replacement for `StatCard`, and it still is not: the
 * desktop dashboard and `TaskStatsCards` keep their cards. This is one call
 * site choosing the flat instrument because it has 375px to work with.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { StatStrip, type StatStripItem } from "@/components/surface/stat-strip"
import type { TaskStatistics } from "@/types/scheduler"

export interface MobileSchedulerStatStripProps {
  statistics: TaskStatistics | null
  className?: string
}

/** Below this the run history is failing, not merely imperfect. */
const SUCCESS_CRITICAL_BELOW = 70
/** At or above this the run history is healthy. */
const SUCCESS_HEALTHY_AT = 90

export function MobileSchedulerStatStrip({ statistics, className }: MobileSchedulerStatStripProps) {
  const t = useTranslations("scheduler")
  const tMobile = useTranslations("scheduler.mobile.statStripLabels")

  const successRate = useMemo(() => {
    if (!statistics) return 0
    if (statistics.totalExecutions === 0) return 0
    return Math.round((statistics.successfulExecutions / statistics.totalExecutions) * 100)
  }, [statistics])

  if (!statistics) return null

  const stats: StatStripItem[] = [
    {
      id: "active",
      label: tMobile("active") || t("activeTasks") || "Active",
      value: statistics.activeTasks,
      tone: "positive",
    },
    {
      id: "paused",
      label: tMobile("paused") || t("pausedTasks") || "Paused",
      value: statistics.pausedTasks,
      // Paused is a state someone chose, so it is worth seeing but is not bad
      // news. Only the success rate below is allowed to go `critical`.
      tone: statistics.pausedTasks > 0 ? "attention" : "neutral",
    },
    {
      id: "executions",
      label: tMobile("executions") || t("totalExecutions") || "Executions",
      value: statistics.totalExecutions,
      tone: "neutral",
    },
    {
      id: "success",
      label: tMobile("successRate") || t("successRate") || "Success",
      value: `${successRate}%`,
      // The denominator is what makes a rate readable: 100% of two runs and
      // 100% of two hundred are not the same claim.
      total: statistics.totalExecutions > 0 ? statistics.totalExecutions : undefined,
      tone:
        successRate >= SUCCESS_HEALTHY_AT
          ? "positive"
          : successRate >= SUCCESS_CRITICAL_BELOW
            ? "attention"
            : "critical",
    },
  ]

  return (
    <StatStrip
      stats={stats}
      testId="mobile-scheduler-stat-strip"
      cellTestIdPrefix="stat"
      className={className}
    />
  )
}
