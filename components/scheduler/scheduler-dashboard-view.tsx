"use client"

/**
 * SchedulerDashboardView - Default overview shown when no task is selected
 * Displays aggregate stats, execution chart, upcoming tasks, and recent executions.
 */

import { useTranslations } from "next-intl"
import {
  Activity,
  Pause,
  Zap,
  BarChart3,
  CheckCircle,
  XCircle,
  Clock,
  ArrowRight,
  Calendar,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { ScheduledTask, TaskExecution, TaskStatistics } from "@/types/scheduler"
import type { ScheduledItemKind } from "@/types/scheduler/unified"
import { formatDuration, formatRelativeTime } from "@/lib/scheduler/format-utils"
import { TaskExecutionChart } from "./task-execution-chart"

export interface SchedulerDashboardViewProps {
  statistics: TaskStatistics | null
  activeTasks: ScheduledTask[]
  pausedTasks: ScheduledTask[]
  upcomingTasks: ScheduledTask[]
  recentExecutions: TaskExecution[]
  schedulerStatus: string
  onSelectTask: (taskId: string) => void
  /** Per-kind item counts — when supplied, renders the kind summary strip. */
  countsByKind?: Record<ScheduledItemKind, number>
  activeCountsByKind?: Record<ScheduledItemKind, number>
}

// ---------------------------------------------------------------------------
// Stat card subcomponent
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string
  value: string | number
  icon: React.ReactNode
  valueClassName?: string
  accentGradient: string
  iconBgClassName: string
}

function StatCard({
  label,
  value,
  icon,
  valueClassName,
  accentGradient,
  iconBgClassName,
}: StatCardProps) {
  return (
    <Card
      className={cn(
        "relative overflow-hidden border-border/50 bg-card/80",
        "transition-all hover:-translate-y-0.5 hover:shadow-lg"
      )}
    >
      <CardContent className="p-4 pb-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className={cn("mt-1 text-2xl font-bold tabular-nums", valueClassName)}>{value}</p>
          </div>
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              iconBgClassName
            )}
          >
            {icon}
          </div>
        </div>
      </CardContent>
      {/* Colored bottom accent line */}
      <div
        className={cn("absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r", accentGradient)}
      />
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Success rate ring indicator
// ---------------------------------------------------------------------------

interface SuccessRingProps {
  successRate: number
}

function SuccessRing({ successRate }: SuccessRingProps) {
  return (
    <svg className="h-10 w-10 -rotate-90" viewBox="0 0 36 36" aria-hidden="true">
      <circle
        cx="18"
        cy="18"
        r="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        className="text-muted/30"
      />
      <circle
        cx="18"
        cy="18"
        r="15"
        fill="none"
        strokeWidth="3"
        strokeDasharray={`${successRate * 0.942} 100`}
        strokeLinecap="round"
        className={
          successRate >= 90
            ? "stroke-green-500"
            : successRate >= 70
              ? "stroke-yellow-500"
              : "stroke-red-500"
        }
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Status icon for recent executions
// ---------------------------------------------------------------------------

function ExecutionStatusIcon({ status }: { status: TaskExecution["status"] }) {
  if (status === "completed") {
    return <CheckCircle className="h-3.5 w-3.5 text-green-500" aria-hidden="true" />
  }
  if (status === "failed") {
    return <XCircle className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />
  }
  if (status === "running") {
    return <Activity className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />
  }
  return <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const KIND_ORDER: ScheduledItemKind[] = ["app", "workflow", "backup", "plugin", "system"]

interface KindSummaryStripProps {
  countsByKind?: Record<ScheduledItemKind, number>
  activeCountsByKind?: Record<ScheduledItemKind, number>
}

function KindSummaryStrip({ countsByKind, activeCountsByKind }: KindSummaryStripProps) {
  const t = useTranslations("scheduler")
  if (!countsByKind) return null
  return (
    <div data-testid="kind-summary-strip" className="flex flex-wrap gap-2">
      {KIND_ORDER.map((kind) => {
        const total = countsByKind[kind] ?? 0
        const active = activeCountsByKind?.[kind] ?? 0
        const muted = total === 0
        return (
          <div
            key={kind}
            data-testid={`kind-summary-${kind}`}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs",
              muted ? "opacity-60 border-border/30" : "border-border/60 bg-card/50"
            )}
          >
            <span className="font-medium capitalize">{t(`kindFilter.${kind}`) || kind}</span>
            <span className="tabular-nums">{total}</span>
            {!muted && (
              <span className="text-[10px] text-green-500 tabular-nums">
                {active} {t("active") || "active"}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function SchedulerDashboardView({
  statistics,
  upcomingTasks,
  recentExecutions,
  onSelectTask,
  countsByKind,
  activeCountsByKind,
}: SchedulerDashboardViewProps) {
  const t = useTranslations("scheduler")

  if (!statistics) return null

  const successRate =
    statistics.totalExecutions > 0
      ? Math.round((statistics.successfulExecutions / statistics.totalExecutions) * 100)
      : 0

  const successRateColor =
    successRate >= 90 ? "text-green-500" : successRate >= 70 ? "text-yellow-500" : "text-red-500"

  return (
    <div className="space-y-5 p-5 sm:p-6">
      <KindSummaryStrip countsByKind={countsByKind} activeCountsByKind={activeCountsByKind} />
      {/* Stats cards row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {/* Total Tasks */}
        <StatCard
          label={t("totalTasks") || "Total Tasks"}
          value={statistics.totalTasks}
          icon={<BarChart3 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
          valueClassName="text-foreground"
          accentGradient="from-border to-border/50"
          iconBgClassName="bg-muted/50"
        />

        {/* Active */}
        <StatCard
          label={t("activeTasks") || "Active"}
          value={statistics.activeTasks}
          icon={<Activity className="h-5 w-5 text-green-500" aria-hidden="true" />}
          valueClassName="text-green-500"
          accentGradient="from-green-500 to-emerald-400"
          iconBgClassName="bg-green-500/10"
        />

        {/* Paused */}
        <StatCard
          label={t("pausedTasks") || "Paused"}
          value={statistics.pausedTasks}
          icon={<Pause className="h-5 w-5 text-yellow-500" aria-hidden="true" />}
          valueClassName="text-yellow-500"
          accentGradient="from-yellow-500 to-amber-400"
          iconBgClassName="bg-yellow-500/10"
        />

        {/* Executions */}
        <StatCard
          label={t("totalExecutions") || "Executions"}
          value={statistics.totalExecutions}
          icon={<Zap className="h-5 w-5 text-blue-500" aria-hidden="true" />}
          valueClassName="text-blue-500"
          accentGradient="from-blue-500 to-sky-400"
          iconBgClassName="bg-blue-500/10"
        />

        {/* Success Rate with ring */}
        <StatCard
          label={t("successRate") || "Success Rate"}
          value={`${successRate}%`}
          icon={<SuccessRing successRate={successRate} />}
          valueClassName={successRateColor}
          accentGradient={
            successRate >= 90
              ? "from-green-500 to-emerald-400"
              : successRate >= 70
                ? "from-yellow-500 to-amber-400"
                : "from-red-500 to-rose-400"
          }
          iconBgClassName="bg-transparent"
        />
      </div>

      {/* Execution chart — all executions, no taskId filter */}
      <TaskExecutionChart executions={recentExecutions} />

      {/* Bottom two-column grid */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* Upcoming Tasks card */}
        <Card className="border-border/50 bg-card/80">
          <CardContent className="p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Calendar className="h-4 w-4 text-blue-500" aria-hidden="true" />
              {t("upcomingTasks") || "Upcoming Tasks"}
            </h3>

            {upcomingTasks.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {t("noUpcomingTasks") || "No upcoming tasks"}
              </p>
            ) : (
              <div className="space-y-0.5">
                {upcomingTasks.slice(0, 5).map((task) => (
                  <button
                    key={task.id}
                    onClick={() => onSelectTask(task.id)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted/50"
                  >
                    <div
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        task.status === "active" ? "bg-green-500" : "bg-yellow-500"
                      )}
                    />
                    <p className="flex-1 truncate text-xs font-medium">{task.name}</p>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatRelativeTime(task.nextRunAt)}
                    </span>
                    <ArrowRight
                      className="h-3 w-3 shrink-0 text-muted-foreground/50"
                      aria-hidden="true"
                    />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Executions card */}
        <Card className="border-border/50 bg-card/80">
          <CardContent className="p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Activity className="h-4 w-4 text-purple-500" aria-hidden="true" />
              {t("recentExecutions") || "Recent Executions"}
            </h3>

            {recentExecutions.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {t("noRecentExecutions") || "No recent executions"}
              </p>
            ) : (
              <div className="space-y-0.5">
                {recentExecutions.slice(0, 5).map((exec) => (
                  <div key={exec.id} className="flex items-center gap-3 rounded-lg px-2 py-2">
                    <ExecutionStatusIcon status={exec.status} />
                    <p className="flex-1 truncate text-xs font-medium">{exec.taskName}</p>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatDuration(exec.duration)}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatRelativeTime(exec.completedAt ?? exec.startedAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
