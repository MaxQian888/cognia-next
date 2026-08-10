"use client"

/**
 * SchedulerDashboardView - Default overview shown when no task is selected.
 *
 * The overview is laid out as one page of hairline-separated blocks — a
 * headline summary band ({@link SchedulerOverviewSummary}), the live execution
 * monitor, the 7-day chart, then upcoming ↔ recent side by side — rather than
 * the stack of eleven nested cards it used to be. Nested `Card` surfaces are
 * flattened via {@link FLAT_PANEL} so a widget's own chrome doesn't reappear.
 */

import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Activity, CheckCircle, XCircle, Clock, ArrowRight, Calendar } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ScheduledTask, TaskExecution, TaskStatistics } from "@/types/scheduler"
import type { ScheduledItemKind } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"
import { formatDuration, formatRelativeTime } from "@/lib/scheduler/format-utils"
import { useSchedulerDashboardView } from "@/hooks/scheduler/use-scheduler-dashboard-view"
import { TaskExecutionChart } from "./task-execution-chart"
import { UnifiedRecentRuns } from "./unified-recent-runs"
import { ExecutionMonitorPanel } from "@/components/execution/execution-monitor-panel"
import { SchedulerOverviewSummary } from "./scheduler-overview-summary"
import { SchedulerDashboardViewToggle } from "./scheduler-dashboard-view-toggle"
import { SchedulerCalendarView } from "./scheduler-calendar-view"
import { SchedulerTimelineView } from "./scheduler-timeline-view"
import { staticIf, viewSwitchVariants } from "./scheduler-motion"
import { Button } from "@/components/ui/button"

/** Flattens a nested `Card` surface so the overview reads as one page. */
const FLAT_PANEL = "border-0 bg-transparent p-0 shadow-none [&>[data-slot=card-content]]:p-0"

/** Hairline rule + breathing room — the overview's only block separator. */
const OVERVIEW_BLOCK = "mt-5 border-t border-border/50 pt-5"

export interface SchedulerDashboardViewProps {
  statistics: TaskStatistics | null
  activeTasks: ScheduledTask[]
  pausedTasks: ScheduledTask[]
  upcomingTasks: ScheduledTask[]
  recentExecutions: TaskExecution[]
  schedulerStatus: string
  onSelectTask: (taskId: string) => void
  /**
   * All app scheduled tasks — the calendar / timeline views project their
   * future runs. Optional so legacy callers/tests that only render the
   * overview keep working.
   */
  tasks?: ScheduledTask[]
  /** Per-kind item counts — when supplied, renders the kind summary strip. */
  countsByKind?: Record<ScheduledItemKind, number>
  activeCountsByKind?: Record<ScheduledItemKind, number>
  /**
   * When supplied, the dashboard's Recent Executions card switches from the
   * app-only `recentExecutions` slice to the cross-kind unified view fed by
   * `useUnifiedRecentRuns`. Clicking a row emits the unified run so the
   * page can open `RunDetailSheet`.
   */
  onSelectRun?: (run: UnifiedExecutionRun) => void
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

/**
 * Section wrapper for the overview: a hairline rule + small caps heading is
 * what separates the blocks now, instead of every block being its own card.
 */
function OverviewSection({
  title,
  icon,
  action,
  children,
  testid,
}: {
  title: string
  icon: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  testid?: string
}) {
  return (
    <section data-testid={testid} className={OVERVIEW_BLOCK}>
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold">{title}</h3>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  )
}

export function SchedulerDashboardView(props: SchedulerDashboardViewProps) {
  const { onSelectTask, tasks } = props
  const { view } = useSchedulerDashboardView()
  const prefersReduced = useReducedMotion()
  const variants = staticIf(prefersReduced, viewSwitchVariants)

  return (
    <div className="space-y-5 p-5 sm:p-6">
      <div className="flex items-center justify-end">
        <SchedulerDashboardViewToggle />
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={view} variants={variants} initial="hidden" animate="show" exit="exit">
          {view === "calendar" ? (
            <SchedulerCalendarView tasks={tasks ?? []} onSelectTask={onSelectTask} />
          ) : view === "timeline" ? (
            <SchedulerTimelineView tasks={tasks ?? []} onSelectTask={onSelectTask} />
          ) : (
            <OverviewBody {...props} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function OverviewBody({
  statistics,
  upcomingTasks,
  recentExecutions,
  onSelectTask,
  countsByKind,
  activeCountsByKind,
  onSelectRun,
}: SchedulerDashboardViewProps) {
  const t = useTranslations("scheduler")

  if (!statistics) return null

  return (
    <div>
      <SchedulerOverviewSummary
        statistics={statistics}
        countsByKind={countsByKind}
        activeCountsByKind={activeCountsByKind}
      />
      {/* Live cross-subsystem execution monitor (chat + headless legs + active
          workflow runs + scheduler executions), governed by the ExecutionBroker.
          Flattened: it brings its own heading, so it only needs the rule. */}
      <div className={OVERVIEW_BLOCK}>
        <ExecutionMonitorPanel className={FLAT_PANEL} />
      </div>

      {/* Execution chart — all executions, no taskId filter. Also self-titled. */}
      <div className={OVERVIEW_BLOCK}>
        <TaskExecutionChart
          executions={recentExecutions}
          className="rounded-none border-0 bg-transparent p-0"
        />
      </div>

      {/* Upcoming ↔ recent, side by side and separated by a rule rather than
          by two more boxes. */}
      <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-2 lg:divide-x lg:divide-border/50">
        <OverviewSection
          testid="overview-upcoming"
          title={t("upcomingTasks")}
          icon={<Calendar className="h-4 w-4 text-blue-500" aria-hidden="true" />}
        >
          {upcomingTasks.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">{t("noUpcomingTasks")}</p>
          ) : (
            <div className="space-y-0.5">
              {upcomingTasks.slice(0, 5).map((task) => (
                <Button
                  key={task.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onSelectTask(task.id)}
                  className="h-auto w-full justify-start gap-3 px-2 py-2 text-left"
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
                </Button>
              ))}
            </div>
          )}
        </OverviewSection>

        {/* Unified (cross-kind) when `onSelectRun` is provided by the page;
            otherwise the app-only slice so legacy callers keep working. */}
        {onSelectRun ? (
          <div className={cn(OVERVIEW_BLOCK, "lg:pl-8")}>
            <UnifiedRecentRuns limit={5} onSelectRun={onSelectRun} className={FLAT_PANEL} />
          </div>
        ) : (
          <OverviewSection
            testid="overview-recent"
            title={t("recentExecutions")}
            icon={<Activity className="h-4 w-4 text-purple-500" aria-hidden="true" />}
          >
            {recentExecutions.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {t("noRecentExecutions")}
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
          </OverviewSection>
        )}
      </div>
    </div>
  )
}
