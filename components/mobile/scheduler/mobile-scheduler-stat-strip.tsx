"use client"

/**
 * MobileSchedulerStatStrip — horizontal-scrollable summary cards for the
 * mobile scheduler page. Reuses the shared `StatCard` primitive (size="sm")
 * so the gradient-accent visual stays in lock-step with the desktop
 * dashboard. The strip itself only contributes the snap-scroll container
 * + per-cell sizing.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Activity, Pause, Timer, Zap } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TaskStatistics } from "@/types/scheduler"
import { StatCard } from "@/components/scheduler/stat-card"

export interface MobileSchedulerStatStripProps {
  statistics: TaskStatistics | null
  className?: string
}

interface StatCellConfig {
  testid: string
  label: string
  value: string
  icon: React.ReactNode
  valueClassName: string
  accentGradient: string
  iconBgClassName: string
}

export function MobileSchedulerStatStrip({ statistics, className }: MobileSchedulerStatStripProps) {
  const t = useTranslations("scheduler")
  const tMobile = useTranslations("scheduler.mobile.statStripLabels")

  const successRate = useMemo(() => {
    if (!statistics) return 0
    if (statistics.totalExecutions === 0) return 0
    return Math.round((statistics.successfulExecutions / statistics.totalExecutions) * 100)
  }, [statistics])

  if (!statistics) return null

  const cells: StatCellConfig[] = [
    {
      testid: "stat-active",
      label: tMobile("active") || t("activeTasks") || "Active",
      value: String(statistics.activeTasks),
      icon: <Activity className="h-4 w-4 text-green-500" aria-hidden="true" />,
      valueClassName: "text-green-500",
      accentGradient: "from-green-500 to-emerald-400",
      iconBgClassName: "bg-green-500/10",
    },
    {
      testid: "stat-paused",
      label: tMobile("paused") || t("pausedTasks") || "Paused",
      value: String(statistics.pausedTasks),
      icon: <Pause className="h-4 w-4 text-yellow-500" aria-hidden="true" />,
      valueClassName: "text-yellow-500",
      accentGradient: "from-yellow-500 to-amber-400",
      iconBgClassName: "bg-yellow-500/10",
    },
    {
      testid: "stat-executions",
      label: tMobile("executions") || t("totalExecutions") || "Executions",
      value: String(statistics.totalExecutions),
      icon: <Zap className="h-4 w-4 text-blue-500" aria-hidden="true" />,
      valueClassName: "text-blue-500",
      accentGradient: "from-blue-500 to-sky-400",
      iconBgClassName: "bg-blue-500/10",
    },
    {
      testid: "stat-success",
      label: tMobile("successRate") || t("successRate") || "Success",
      value: `${successRate}%`,
      icon: <Timer className="h-4 w-4 text-purple-500" aria-hidden="true" />,
      valueClassName:
        successRate >= 90
          ? "text-green-500"
          : successRate >= 70
            ? "text-yellow-500"
            : "text-red-500",
      accentGradient:
        successRate >= 90
          ? "from-green-500 to-emerald-400"
          : successRate >= 70
            ? "from-yellow-500 to-amber-400"
            : "from-red-500 to-rose-400",
      iconBgClassName: "bg-purple-500/10",
    },
  ]

  return (
    <div
      data-testid="mobile-scheduler-stat-strip"
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
