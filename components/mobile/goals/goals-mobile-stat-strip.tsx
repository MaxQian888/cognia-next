"use client"

/**
 * GoalsMobileStatStrip — horizontal snap-scroll summary cards for the mobile
 * Goals view. Reuses the shared `StatCard` primitive (size="sm") with the same
 * gradient accents as the desktop console, so the two surfaces stay in
 * lock-step. Mirrors `MobileSchedulerStatStrip`.
 */

import { useTranslations } from "next-intl"
import { ActivityIcon, CheckCircle2Icon, PauseIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { StatCard } from "@/components/scheduler/stat-card"

export interface GoalsMobileStatStripProps {
  active: number
  paused: number
  done: number
  className?: string
}

export function GoalsMobileStatStrip({ active, paused, done, className }: GoalsMobileStatStripProps) {
  const t = useTranslations("goal")

  const cells = [
    {
      testid: "mobile-goal-stat-active",
      label: t("console.stats.active"),
      value: active,
      icon: <ActivityIcon className="h-4 w-4 text-green-500" aria-hidden />,
      valueClassName: "text-green-500",
      accentGradient: "from-green-500 to-emerald-400",
      iconBgClassName: "bg-green-500/10",
    },
    {
      testid: "mobile-goal-stat-paused",
      label: t("console.stats.paused"),
      value: paused,
      icon: <PauseIcon className="h-4 w-4 text-yellow-500" aria-hidden />,
      valueClassName: "text-yellow-500",
      accentGradient: "from-yellow-500 to-amber-400",
      iconBgClassName: "bg-yellow-500/10",
    },
    {
      testid: "mobile-goal-stat-done",
      label: t("console.stats.done"),
      value: done,
      icon: <CheckCircle2Icon className="h-4 w-4 text-muted-foreground" aria-hidden />,
      valueClassName: "text-foreground",
      accentGradient: "from-border to-border/50",
      iconBgClassName: "bg-muted/50",
    },
  ]

  return (
    <div
      data-testid="mobile-goals-stats"
      className={cn(
        // Horizontal carousel with snap, hidden scrollbar — feels native on iOS/Android.
        "-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 [&::-webkit-scrollbar]:hidden",
        className
      )}
    >
      {cells.map((cell) => (
        <StatCard
          key={cell.testid}
          testid={cell.testid}
          size="sm"
          label={cell.label}
          value={cell.value}
          icon={cell.icon}
          valueClassName={cell.valueClassName}
          accentGradient={cell.accentGradient}
          iconBgClassName={cell.iconBgClassName}
          className="w-[42%] shrink-0 snap-start sm:w-[28%]"
        />
      ))}
    </div>
  )
}

GoalsMobileStatStrip.displayName = "GoalsMobileStatStrip"
