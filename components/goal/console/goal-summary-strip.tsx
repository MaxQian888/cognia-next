"use client"

/**
 * The Goals console's lifetime numbers as one hairline strip (ADR-0019).
 *
 * The Overview used to open on five 130px stat cards in two labelled clusters
 * — two of them repeating the status filter right beneath — so the first open
 * goal started half a screen down. The open counts now live on the scope
 * control that filters by them; what is left is lifetime: how many goals
 * finished well out of how many finished at all, what a goal typically costs,
 * and the total spend. Each cell opens what it summarises (Completed → History
 * filtered to completed, the rest → Analytics).
 *
 * Built on the shared `StatStrip` (`components/surface/stat-strip.tsx`), the
 * same instrument the device and workspace consoles carry.
 */

import { useLocale, useTranslations } from "next-intl"

import { Skeleton } from "@/components/ui/skeleton"
import { Surface } from "@/components/surface/surface"
import { StatStrip, type StatStripItem } from "@/components/surface/stat-strip"
import type { GoalAnalytics } from "@/lib/goal/analytics"
import { formatGoalTokens } from "@/lib/goal/format"

export interface GoalSummaryStripProps {
  analytics: GoalAnalytics
  loading: boolean
  /** Open History filtered to completed goals. */
  onOpenCompleted: () => void
  onOpenAnalytics: () => void
}

export function GoalSummaryStrip({
  analytics,
  loading,
  onOpenCompleted,
  onOpenAnalytics,
}: GoalSummaryStripProps) {
  const t = useTranslations("goal.console.stats")
  const locale = useLocale()

  if (loading) {
    return (
      // Same frame as the strip it stands in for: the hairline is the
      // ground showing through the 1px gaps (see `StatStrip`).
      <Surface asChild radius="panel">
        <div
          className="grid grid-cols-2 gap-px overflow-hidden border bg-border @xl/console-pane:grid-cols-4"
          aria-busy
          data-testid="goal-summary-strip-loading"
        >
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="space-y-1.5 bg-card px-3 py-2">
              <Skeleton className="h-4 w-10" />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      </Surface>
    )
  }

  const stats: StatStripItem[] = [
    {
      id: "completed",
      label: t("completedOfFinished"),
      value: analytics.completed,
      total: analytics.terminal,
      tone: analytics.completed > 0 ? "positive" : "neutral",
      action: { onSelect: onOpenCompleted, label: t("openHistory") },
    },
    {
      id: "avg-turns",
      label: t("avgTurns"),
      value: analytics.total > 0 ? analytics.avgTurns.toFixed(1) : "—",
      action: { onSelect: onOpenAnalytics, label: t("openAnalytics") },
    },
    {
      id: "avg-tokens",
      label: t("avgTokens"),
      value: analytics.total > 0 ? formatGoalTokens(analytics.avgTokens, locale) : "—",
      action: { onSelect: onOpenAnalytics, label: t("openAnalytics") },
    },
    {
      id: "token-spend",
      label: t("tokenSpend"),
      value: formatGoalTokens(analytics.totalTokens, locale),
      action: { onSelect: onOpenAnalytics, label: t("openAnalytics") },
    },
  ]

  return (
    <StatStrip
      stats={stats}
      pane="console-pane"
      testId="goal-summary-strip"
      cellTestIdPrefix="goal-stat"
    />
  )
}

GoalSummaryStrip.displayName = "GoalSummaryStrip"
