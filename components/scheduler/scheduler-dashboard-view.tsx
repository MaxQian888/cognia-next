"use client"

/**
 * SchedulerDashboardView — the overview shown when no item is selected.
 *
 * Three interchangeable projections of the same cross-source list, chosen by
 * the toggle in this component's own header row:
 *
 *   - overview — headline band, live execution monitor, 7-day chart, then
 *     upcoming ↔ recent side by side;
 *   - calendar — month grid of projected runs;
 *   - timeline — day-headed agenda of projected runs.
 *
 * Every block reads the merged `UnifiedScheduledItem[]` / `UnifiedExecutionRun[]`.
 * They used to read the app-only scheduler store, so the overview announced
 * "2 tasks" beside a list of 4 and the calendar rendered one of the six
 * sources.
 *
 * The overview is laid out as one page of hairline-separated blocks rather
 * than a stack of nested cards; widgets that bring their own `Card` chrome are
 * flattened via {@link FLAT_PANEL} so it doesn't reappear.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ArrowRight, Calendar } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"
import { selectUpcomingItems, type UnifiedStatistics } from "@/lib/scheduler/unified-filter"
import { formatRelativeTime } from "@/lib/scheduler/format-utils"
import { useSchedulerDashboardView } from "@/hooks/scheduler/use-scheduler-dashboard-view"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import { TaskExecutionChart, toChartPointsFromUnifiedRuns } from "./task-execution-chart"
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

/** How many rows the upcoming block lists before it stops. */
const UPCOMING_LIMIT = 5

export interface SchedulerDashboardViewProps {
  /** Cross-source headline readings, derived from `items`. */
  statistics: UnifiedStatistics
  /** Every scheduled item, merged across sources. */
  items: UnifiedScheduledItem[]
  /** Recent runs across every source that keeps a history — drives the chart. */
  recentRuns: UnifiedExecutionRun[]
  /** Select a row by `unifiedId` (upcoming rows, calendar/agenda rows). */
  onSelectItem: (unifiedId: string) => void
  /** Open the run-detail sheet for a recent run. */
  onSelectRun: (run: UnifiedExecutionRun) => void
  /** Pin a kind in the sidebar filter from the overview's kind rail. */
  onSelectKind?: (kind: ScheduledItemKind) => void
  /** Kinds currently pinned, so the rail can mark them. */
  selectedKinds?: ReadonlySet<ScheduledItemKind>
  /**
   * Injectable "now" for deterministic tests/stories. Left out in the app, the
   * overview reads the shared 1-second ticker so "next run in 4m" counts down
   * instead of freezing until something unrelated re-renders.
   */
  now?: number
}

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
  className,
}: {
  title: string
  icon: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  testid?: string
  className?: string
}) {
  return (
    <section data-testid={testid} className={cn(OVERVIEW_BLOCK, className)}>
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
  const { items, onSelectItem, now } = props
  const t = useTranslations("scheduler")
  const { view } = useSchedulerDashboardView()
  const prefersReduced = useReducedMotion()
  const variants = staticIf(prefersReduced, viewSwitchVariants)
  const projectionNow = useMemo(() => (now !== undefined ? new Date(now) : undefined), [now])

  return (
    <div className="space-y-5 p-5 sm:p-6">
      {/*
        The toggle used to float alone against the right edge with nothing to
        anchor it. Pairing it with the view's own name makes the row read as a
        heading with a control rather than a stray widget.
      */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="truncate text-sm font-semibold" data-testid="scheduler-dashboard-title">
          {t(`dashboardView.${view}`)}
        </h2>
        <SchedulerDashboardViewToggle />
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={view} variants={variants} initial="hidden" animate="show" exit="exit">
          {view === "calendar" ? (
            <SchedulerCalendarView items={items} onSelectItem={onSelectItem} now={projectionNow} />
          ) : view === "timeline" ? (
            <SchedulerTimelineView items={items} onSelectItem={onSelectItem} now={projectionNow} />
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
  items,
  recentRuns,
  onSelectItem,
  onSelectRun,
  onSelectKind,
  selectedKinds,
  now,
}: SchedulerDashboardViewProps) {
  const t = useTranslations("scheduler")

  // Floored to the minute. The shared ticker fires once a second, and this
  // component's output feeds the whole overview — summary band, execution
  // monitor, the recharts 7-day chart, recent runs — so subscribing to it raw
  // re-rendered all of that 60 times a minute. The only thing that needed it is
  // `formatRelativeTime`, whose finest bucket is "< 1 min" (see
  // `lib/scheduler/format-utils.ts`), so a minute-granularity clock produces
  // identical text and 1/60th of the renders. An explicit `now` (tests,
  // stories) is used verbatim.
  const tick = useNowTicker()
  const clock = now ?? Math.floor(tick / 60_000) * 60_000

  const upcoming = useMemo(
    () => selectUpcomingItems(items, { limit: UPCOMING_LIMIT, now: clock }),
    [items, clock]
  )
  const chartPoints = useMemo(() => toChartPointsFromUnifiedRuns(recentRuns), [recentRuns])

  return (
    <div>
      <SchedulerOverviewSummary
        statistics={statistics}
        onSelectKind={onSelectKind}
        selectedKinds={selectedKinds}
      />

      {/* Live cross-subsystem execution monitor (chat + headless legs + active
          workflow runs + scheduler executions), governed by the ExecutionBroker.
          Flattened: it brings its own heading, so it only needs the rule. */}
      <div className={OVERVIEW_BLOCK}>
        <ExecutionMonitorPanel className={FLAT_PANEL} />
      </div>

      {/* 7-day outcome chart over every source's runs. Also self-titled. */}
      <div className={OVERVIEW_BLOCK}>
        <TaskExecutionChart
          runs={chartPoints}
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
          {upcoming.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">{t("noUpcomingTasks")}</p>
          ) : (
            <div className="space-y-0.5">
              {upcoming.map((item) => (
                <Button
                  key={item.unifiedId}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onSelectItem(item.unifiedId)}
                  data-testid={`overview-upcoming-${item.unifiedId}`}
                  className="h-auto w-full justify-start gap-3 px-2 py-2 text-left"
                >
                  <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{item.name}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t(`kindFilter.${item.kind}`)}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {formatRelativeTime(new Date(item.nextRunAt!))}
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

        <div className={cn(OVERVIEW_BLOCK, "lg:pl-8")}>
          <UnifiedRecentRuns
            limit={UPCOMING_LIMIT}
            onSelectRun={onSelectRun}
            className={FLAT_PANEL}
          />
        </div>
      </div>
    </div>
  )
}
