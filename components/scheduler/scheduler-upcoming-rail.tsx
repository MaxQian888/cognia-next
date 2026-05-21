"use client"

/**
 * SchedulerUpcomingRail — xl-only right side rail showing the next runs and
 * the most recent runs in a compact list. Surfaces information that would
 * otherwise require switching back to the dashboard view.
 */

import { useTranslations } from "next-intl"
import { ArrowRight, Calendar, Activity } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"
import { formatDuration, formatRelativeTime } from "@/lib/scheduler/format-utils"
import { useUnifiedRecentRuns } from "@/hooks/scheduler/use-unified-recent-runs"

export interface SchedulerUpcomingRailProps {
  upcomingTasks: ScheduledTask[]
  recentExecutions: TaskExecution[]
  onSelectTask: (taskId: string) => void
  /** When set, recent rows feed from the cross-kind unified runs hook. */
  onSelectRun?: (run: UnifiedExecutionRun) => void
  className?: string
}

const MAX_ROWS = 5

function ExecutionStatusDot({ status }: { status: TaskExecution["status"] }) {
  const color =
    status === "completed" ? "bg-green-500" : status === "failed" ? "bg-red-500" : "bg-blue-500"
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", color)} aria-hidden="true" />
}

function UnifiedRecentBlock({ onSelectRun }: { onSelectRun: (run: UnifiedExecutionRun) => void }) {
  const t = useTranslations("scheduler")
  const { runs } = useUnifiedRecentRuns({ limit: MAX_ROWS })

  if (runs.length === 0) {
    return (
      <p
        className="py-3 text-center text-[11px] text-muted-foreground"
        data-testid="upcoming-rail-no-recent"
      >
        {t("noRecentExecutions") || "No recent executions"}
      </p>
    )
  }

  return (
    <div className="space-y-0.5">
      {runs.map((run) => {
        const when = run.finishedAt ?? run.startedAt
        return (
          <button
            key={run.unifiedId}
            type="button"
            onClick={() => onSelectRun(run)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted/50"
            data-testid={`upcoming-rail-recent-${run.unifiedId}`}
          >
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                run.status === "succeeded"
                  ? "bg-green-500"
                  : run.status === "failed"
                    ? "bg-red-500"
                    : run.status === "running"
                      ? "bg-blue-500"
                      : "bg-muted-foreground/40"
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{run.itemName}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {formatRelativeTime(new Date(when))}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function SchedulerUpcomingRail({
  upcomingTasks,
  recentExecutions,
  onSelectTask,
  onSelectRun,
  className,
}: SchedulerUpcomingRailProps) {
  const t = useTranslations("scheduler")
  const upcoming = upcomingTasks.slice(0, MAX_ROWS)
  const recent = recentExecutions.slice(0, MAX_ROWS)

  return (
    <aside
      data-testid="scheduler-upcoming-rail"
      aria-label={t("upcomingRail.ariaLabel") || "Upcoming and recent runs"}
      className={cn(
        "hidden h-full w-64 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border/50 bg-background/40 p-3 xl:flex",
        className
      )}
    >
      <section data-testid="upcoming-rail-upcoming">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <Calendar className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />
          {t("upcomingRail.title") || t("upcomingTasks") || "Upcoming"}
        </h3>
        {upcoming.length === 0 ? (
          <p
            className="py-3 text-center text-[11px] text-muted-foreground"
            data-testid="upcoming-rail-no-upcoming"
          >
            {t("upcomingRail.empty") || t("noUpcomingTasks") || "No upcoming tasks"}
          </p>
        ) : (
          <div className="space-y-0.5">
            {upcoming.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => onSelectTask(task.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted/50"
                data-testid={`upcoming-rail-upcoming-${task.id}`}
              >
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    task.status === "active" ? "bg-green-500" : "bg-yellow-500"
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{task.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {formatRelativeTime(task.nextRunAt)}
                </span>
                <ArrowRight
                  className="h-3 w-3 shrink-0 text-muted-foreground/40"
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        )}
      </section>

      <section data-testid="upcoming-rail-recent">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <Activity className="h-3.5 w-3.5 text-purple-500" aria-hidden="true" />
          {t("upcomingRail.recentTitle") || t("recentExecutions") || "Recent"}
        </h3>
        {onSelectRun ? (
          <UnifiedRecentBlock onSelectRun={onSelectRun} />
        ) : recent.length === 0 ? (
          <p
            className="py-3 text-center text-[11px] text-muted-foreground"
            data-testid="upcoming-rail-no-recent"
          >
            {t("noRecentExecutions") || "No recent executions"}
          </p>
        ) : (
          <div className="space-y-0.5">
            {recent.map((exec) => (
              <div
                key={exec.id}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5"
                data-testid={`upcoming-rail-recent-${exec.id}`}
              >
                <ExecutionStatusDot status={exec.status} />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                  {exec.taskName}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {formatDuration(exec.duration)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  )
}
