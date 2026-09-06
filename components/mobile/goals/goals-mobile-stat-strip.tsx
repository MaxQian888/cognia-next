"use client"

/**
 * GoalsMobileStatStrip: the three goal counts, all three on one row.
 *
 * This was a snap-scrolling carousel of `StatCard`s at `w-[42%]`, the same
 * shape `MobileSchedulerStatStrip` carried, so a 375px screen showed two and a
 * half of three and left the completed count behind a horizontal swipe with no
 * affordance pointing at it. Three small counts have no business hiding.
 *
 * It is now the shared `StatStrip`, one hairline instrument rather than three
 * floating boxes with gradient accents.
 */

import { useTranslations } from "next-intl"

import { StatStrip, type StatStripItem } from "@/components/surface/stat-strip"

export interface GoalsMobileStatStripProps {
  active: number
  paused: number
  done: number
  className?: string
}

export function GoalsMobileStatStrip({
  active,
  paused,
  done,
  className,
}: GoalsMobileStatStripProps) {
  const t = useTranslations("goal")

  const stats: StatStripItem[] = [
    {
      id: "active",
      label: t("console.stats.active"),
      value: active,
      tone: "positive",
    },
    {
      id: "paused",
      label: t("console.stats.paused"),
      value: paused,
      // Paused is a state someone chose. Worth seeing, not bad news, and not
      // worth tinting when there are none.
      tone: paused > 0 ? "attention" : "neutral",
    },
    {
      id: "done",
      label: t("console.stats.done"),
      value: done,
      tone: "neutral",
    },
  ]

  return (
    <StatStrip
      stats={stats}
      testId="mobile-goals-stats"
      // `StatStrip` stacks three stats into one column until its console pane
      // is wide, because that is what a narrow inspector rail needs. This strip
      // is not in a pane, it is the full width of a phone, and three counts of
      // one or two digits fit across it comfortably. The className escape hatch
      // is how a caller states the width it actually has.
      className={className ? `grid-cols-3 ${className}` : "grid-cols-3"}
      cellTestIdPrefix="mobile-goal-stat"
    />
  )
}

GoalsMobileStatStrip.displayName = "GoalsMobileStatStrip"
