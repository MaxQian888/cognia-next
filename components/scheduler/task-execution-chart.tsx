"use client"

/**
 * TaskExecutionChart — 7-day stacked bar chart of run outcomes.
 *
 * The chart takes an already-normalized {@link ExecutionChartPoint} list
 * rather than a `TaskExecution[]`, because it renders in two different
 * universes: the task detail pane charts one app task's executions, while the
 * scheduler overview charts every source's runs. Feeding it the app-only row
 * type made the overview's "Execution History" quietly app-only too, next to
 * headline numbers that counted all six sources.
 *
 * Call sites map with {@link toChartPointsFromExecutions} or
 * {@link toChartPointsFromUnifiedRuns}.
 */

import { memo, useMemo } from "react"
import { useTranslations } from "next-intl"
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts"
import { BarChart3 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TaskExecution } from "@/types/scheduler"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

/** The only thing the chart needs to know about a run. */
export interface ExecutionChartPoint {
  /** Epoch ms the run started. */
  startedAt: number
  outcome: "completed" | "failed" | "running"
}

/**
 * Map app `TaskExecution` rows, optionally narrowed to one task. Statuses the
 * chart doesn't plot (`pending`, `cancelled`, …) are dropped rather than
 * silently counted as something else.
 */
export function toChartPointsFromExecutions(
  executions: readonly TaskExecution[],
  taskId?: string
): ExecutionChartPoint[] {
  const points: ExecutionChartPoint[] = []
  for (const exec of executions) {
    if (taskId && exec.taskId !== taskId) continue
    if (exec.status !== "completed" && exec.status !== "failed" && exec.status !== "running") {
      continue
    }
    points.push({ startedAt: exec.startedAt.getTime(), outcome: exec.status })
  }
  return points
}

/** Map cross-source `UnifiedExecutionRun` records. */
export function toChartPointsFromUnifiedRuns(
  runs: readonly UnifiedExecutionRun[]
): ExecutionChartPoint[] {
  const points: ExecutionChartPoint[] = []
  for (const run of runs) {
    const outcome =
      run.status === "succeeded"
        ? "completed"
        : run.status === "failed"
          ? "failed"
          : run.status === "running"
            ? "running"
            : undefined
    // `cancelled` / `skipped` runs are neither a success nor a failure; the
    // three-band chart has no honest bucket for them.
    if (!outcome) continue
    points.push({ startedAt: run.startedAt, outcome })
  }
  return points
}

interface TaskExecutionChartProps {
  runs: ExecutionChartPoint[]
  className?: string
}

function getLast7Days(): string[] {
  const days: string[] = []
  const now = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    days.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }))
  }
  return days
}

function getDateKey(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function TaskExecutionChartImpl({ runs, className }: TaskExecutionChartProps) {
  const t = useTranslations("scheduler")

  const chartData = useMemo(() => {
    const days = getLast7Days()
    const buckets: Record<string, { completed: number; failed: number; running: number }> = {}
    for (const day of days) {
      buckets[day] = { completed: 0, failed: 0, running: 0 }
    }

    for (const point of runs) {
      const key = getDateKey(new Date(point.startedAt))
      if (buckets[key]) buckets[key][point.outcome]++
    }

    return days.map((day) => ({
      name: day,
      ...buckets[day],
    }))
  }, [runs])

  const hasData = chartData.some((d) => d.completed + d.failed + d.running > 0)

  const title = t("dashboard.executionChart") || "Execution History (7 days)"

  if (!hasData) {
    return (
      <div
        className={cn("rounded-xl border border-border/50 bg-card/80 p-4", className)}
        data-testid="task-execution-chart"
      >
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <BarChart3 className="h-4 w-4 text-blue-500" aria-hidden="true" />
          {title}
        </h3>
        <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
          {t("dashboard.noData") || "No execution data available"}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn("rounded-xl border border-border/50 bg-card/80 p-4", className)}
      data-testid="task-execution-chart"
    >
      {/* Title */}
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <BarChart3 className="h-4 w-4 text-blue-500" aria-hidden="true" />
        {title}
      </h3>

      {/* Legend */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] sm:gap-x-4">
        <span className="flex items-center gap-1 whitespace-nowrap">
          <span className="h-2 w-2 rounded-full bg-green-500" aria-hidden="true" />
          {t("dashboard.completed") || "Completed"}
        </span>
        <span className="flex items-center gap-1 whitespace-nowrap">
          <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
          {t("dashboard.failed") || "Failed"}
        </span>
        <span className="flex items-center gap-1 whitespace-nowrap">
          <span className="h-2 w-2 rounded-full bg-blue-500" aria-hidden="true" />
          {t("dashboard.running") || "Running"}
        </span>
      </div>

      <ResponsiveContainer
        width="100%"
        height={160}
        minWidth={1}
        minHeight={1}
        initialDimension={{ width: 320, height: 160 }}
      >
        <BarChart data={chartData} barGap={1}>
          {/* Gradient definitions */}
          <defs>
            <linearGradient id="gradientCompleted" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22c55e" stopOpacity={1} />
              <stop offset="100%" stopColor="#22c55e" stopOpacity={0.3} />
            </linearGradient>
            <linearGradient id="gradientFailed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" stopOpacity={1} />
              <stop offset="100%" stopColor="#ef4444" stopOpacity={0.3} />
            </linearGradient>
            <linearGradient id="gradientRunning" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={1} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.3} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border) / 0.3)" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            width={24}
          />
          <Tooltip
            contentStyle={{
              fontSize: 11,
              borderRadius: 8,
              border: "1px solid hsl(var(--border))",
              background: "hsl(var(--card))",
              boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
            }}
            labelStyle={{ fontWeight: 600, marginBottom: 4 }}
          />
          {/* Stacked bars — completed at bottom, failed in middle, running on top */}
          <Bar
            dataKey="completed"
            stackId="a"
            fill="url(#gradientCompleted)"
            radius={[0, 0, 0, 0]}
          />
          <Bar dataKey="failed" stackId="a" fill="url(#gradientFailed)" radius={[0, 0, 0, 0]} />
          <Bar dataKey="running" stackId="a" fill="url(#gradientRunning)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * Memoized: the scheduler overview re-renders once a second (the shared clock
 * ticker drives its countdown labels), and recharts is by far the most
 * expensive thing on that page. `runs` is memoized by every caller, so identical
 * props skip the whole chart subtree.
 */
export const TaskExecutionChart = memo(TaskExecutionChartImpl)
TaskExecutionChart.displayName = "TaskExecutionChart"
