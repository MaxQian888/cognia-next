"use client"

/**
 * TaskStatsCards - 4-column stat cards grid for a single task
 * Dashboard Rich styling: colored bottom accent lines, hover animations
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle, XCircle, Clock, Timer } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { formatDuration, formatRelativeTime } from "@/lib/scheduler/format-utils"

interface TaskStatsCardsProps {
  task: ScheduledTask
  executions: TaskExecution[]
}

interface StatCardConfig {
  label: string
  value: string
  icon: React.ReactNode
  valueClassName: string
  accentGradient: string
  iconBgClassName: string
}

export function TaskStatsCards({ task, executions }: TaskStatsCardsProps) {
  const t = useTranslations("scheduler")

  const avgDuration = useMemo(() => {
    const completed = executions.filter(
      (e) => e.status === "completed" && typeof e.duration === "number"
    )
    if (completed.length === 0) return undefined
    const total = completed.reduce((sum, e) => sum + (e.duration ?? 0), 0)
    return Math.round(total / completed.length)
  }, [executions])

  const cards: StatCardConfig[] = [
    {
      label: t("stats.successful") || "Successful",
      value: String(task.successCount),
      icon: <CheckCircle className="h-4 w-4 text-green-500" />,
      valueClassName: "text-green-500",
      accentGradient: "from-green-500 to-emerald-400",
      iconBgClassName: "bg-green-500/10",
    },
    {
      label: t("stats.failed") || "Failed",
      value: String(task.failureCount),
      icon: <XCircle className="h-4 w-4 text-red-500" />,
      valueClassName: "text-red-500",
      accentGradient: "from-red-500 to-rose-400",
      iconBgClassName: "bg-red-500/10",
    },
    {
      label: t("stats.avgDuration") || "Avg Duration",
      value: avgDuration !== undefined ? formatDuration(avgDuration) : "\u2014",
      icon: <Clock className="h-4 w-4 text-blue-500" />,
      valueClassName: "text-blue-500",
      accentGradient: "from-blue-500 to-sky-400",
      iconBgClassName: "bg-blue-500/10",
    },
    {
      label: t("stats.nextRun") || "Next Run",
      value: formatRelativeTime(task.nextRunAt),
      icon: <Timer className="h-4 w-4 text-purple-500" />,
      valueClassName: "text-purple-500",
      accentGradient: "from-purple-500 to-violet-400",
      iconBgClassName: "bg-purple-500/10",
    },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((card) => (
        <Card
          key={card.label}
          className={cn(
            "relative overflow-hidden border-border/50 bg-card/80",
            "transition-all hover:-translate-y-0.5 hover:shadow-lg"
          )}
        >
          <CardContent className="p-4 pb-5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {card.label}
                </p>
                <p className={cn("mt-1 text-2xl font-bold tabular-nums", card.valueClassName)}>
                  {card.value}
                </p>
              </div>
              <div
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                  card.iconBgClassName
                )}
              >
                {card.icon}
              </div>
            </div>
          </CardContent>
          {/* Colored bottom accent line */}
          <div
            className={cn(
              "absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r",
              card.accentGradient
            )}
          />
        </Card>
      ))}
    </div>
  )
}
