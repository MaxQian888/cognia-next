"use client"

/**
 * One detail composition for six kinds (ADR-0179 §1).
 *
 * Masthead outside the scroller, alerts, then `ConsoleSection` cards in a
 * container-query grid, the layout `/bots` and `/devices` already use. A
 * kind contributes a fact list and, where it has one, extra sections; it
 * does not contribute a layout. The three compositions this replaces (app
 * task, five other kinds, a system-task sheet) disagreed about headers,
 * colours and run rows; now there is one of each.
 *
 * The page owns the data. It hands in the item, its app-table row when it
 * has one, its OS record when it is one, the runs it has already fetched,
 * the attention signals about it and the callbacks. This component reads
 * nothing from a store.
 */

import { useEffect, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  BellIcon,
  CalendarClockIcon,
  CpuIcon,
  GitBranchIcon,
  HistoryIcon,
  InfoIcon,
  LayersIcon,
  TagIcon,
} from "lucide-react"

import { ConsoleSection, type ConsolePaneName } from "@/components/surface/console-section"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import type { AttentionSignal } from "@/lib/scheduler/attention"
import { buildDependencyGraph, hasDependencyLinks } from "@/lib/scheduler/dependency-graph"
import type { OutcomeCell } from "@/lib/scheduler/outcome-strip"
import { taskTypeSpawnsProcesses } from "@/lib/scheduler/task-processes"
import type { ScheduledTask } from "@/types/scheduler"
import type { SystemTask } from "@/types/scheduler/system-scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"
import type { PendingItemAction } from "@/hooks/scheduler/use-scheduler-item-actions"

import { OutcomeStrip } from "../outcome-strip"
import { TaskDependencyGraph } from "../task-dependency-graph"
import { TaskNotificationDisplay } from "../task-notification-display"
import { TaskProcessPanel } from "../task-process-panel"
import { TaskTagsDisplay } from "../task-tags-display"
import { TaskWorkspaceMove } from "../task-workspace-move"
import { ItemAlerts } from "./item-alerts"
import { ItemHero, type ItemActions } from "./item-hero"
import { KindFactsSection, kindHasFacts } from "./sections/kind-facts-section"
import { OriginSection } from "./sections/origin-section"
import { RunsSection } from "./sections/runs-section"
import { ScheduleSection } from "./sections/schedule-section"

export interface ItemDetailProps {
  item: UnifiedScheduledItem | null
  /** The app-table row, for `app`, `plugin` and `connector` items. */
  task?: ScheduledTask
  /** The OS record, for `system` items. */
  systemTask?: SystemTask
  /** Signals about this item only. */
  signals: readonly AttentionSignal[]
  runs: readonly UnifiedExecutionRun[]
  runsLoading?: boolean
  hasMoreRuns?: boolean
  onLoadMoreRuns?: () => void
  selectedRunId?: string | null
  outcomeCells: readonly OutcomeCell[]
  /** Every app task, unfiltered, for the dependency graph. */
  allTasks: readonly ScheduledTask[]
  actions: ItemActions
  /** An action on this item that has not answered yet (spinner in the hero). */
  pendingAction?: PendingItemAction
  /** Back to the overview; the hero shows the control only when given. */
  onBack?: () => void
  onOpenRun: (run: UnifiedExecutionRun) => void
  onCancelRun?: (run: UnifiedExecutionRun) => void
  /** Selects another item by its unified id (the dependency graph's nodes). */
  onSelectItem: (unifiedId: string) => void
  onBackupScheduled?: () => void
  pane?: ConsolePaneName
  /** Renders without the masthead, for a shell that already names the item. */
  hideHero?: boolean
  className?: string
}

export function ItemDetail({
  item,
  task,
  systemTask,
  signals,
  runs,
  runsLoading,
  hasMoreRuns,
  onLoadMoreRuns,
  selectedRunId,
  outcomeCells,
  allTasks,
  actions,
  pendingAction,
  onBack,
  onOpenRun,
  onCancelRun,
  onSelectItem,
  onBackupScheduled,
  pane = "console-pane",
  hideHero = false,
  className,
}: ItemDetailProps) {
  const t = useTranslations("scheduler")
  const tDetail = useTranslations("scheduler.detail")
  const scroller = useRef<HTMLDivElement>(null)
  const id = item?.unifiedId ?? null

  // Switching items resets the scroll with `scrollTop`, not `scrollTo`: the
  // latter is absent in jsdom and in the older Android WebViews the Capacitor
  // shell still runs on.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0
  }, [id])

  const showDependencies = Boolean(task && hasDependencyLinks(task, allTasks as ScheduledTask[]))
  const dependencyGraph = useMemo(
    () =>
      task && showDependencies
        ? buildDependencyGraph(allTasks as ScheduledTask[], { focusTaskId: task.id })
        : null,
    [task, showDependencies, allTasks]
  )

  if (!item) {
    return (
      <Empty className="h-full border-none" data-testid="item-detail-empty">
        <EmptyHeader>
          <EmptyTitle>{tDetail("noSelectionTitle")}</EmptyTitle>
          <EmptyDescription>{tDetail("noSelectionBody")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const busy = runs.some((run) => run.status === "running")
  const spawnsProcesses = Boolean(task && taskTypeSpawnsProcesses(task.type))
  const containerClass = `@container/${pane}`

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)} data-testid="item-detail">
      {hideHero ? null : (
        <ItemHero
          item={item}
          actions={actions}
          busy={busy}
          pendingAction={pendingAction}
          onBack={onBack}
        />
      )}
      <div ref={scroller} className={cn("min-h-0 flex-1 overflow-y-auto", containerClass)}>
        <div className="flex flex-col gap-3 p-4">
          <ItemAlerts signals={signals} task={task} systemTask={systemTask} />

          <div className={cn("grid gap-3", `@3xl/${pane}:grid-cols-2`)}>
            <ConsoleSection
              id="schedule"
              title={t("schedule")}
              icon={CalendarClockIcon}
              pane={pane}
            >
              <ScheduleSection item={item} task={task} />
            </ConsoleSection>

            <ConsoleSection
              id="outcomes"
              title={tDetail("outcomesTitle")}
              icon={ActivityIcon}
              pane={pane}
            >
              {item.kind === "system" ? (
                <p className="text-xs text-muted-foreground">{tDetail("noOsRunHistory")}</p>
              ) : (
                <OutcomeStrip cells={outcomeCells} testId="item-outcomes" />
              )}
            </ConsoleSection>

            {kindHasFacts(item) ? (
              <ConsoleSection
                id="facts"
                title={t(`kindFilter.${item.kind}`)}
                icon={LayersIcon}
                pane={pane}
              >
                <KindFactsSection
                  item={item}
                  task={task}
                  systemTask={systemTask}
                  onBackupScheduled={onBackupScheduled}
                />
              </ConsoleSection>
            ) : null}

            {spawnsProcesses && task ? (
              <ConsoleSection
                id="processes"
                title={t("processes.title")}
                icon={CpuIcon}
                pane={pane}
              >
                <TaskProcessPanel taskId={task.id} taskType={task.type} />
              </ConsoleSection>
            ) : null}

            <ConsoleSection
              id="runs"
              title={t("recentRuns")}
              icon={HistoryIcon}
              pane={pane}
              wide
              meta={runs.length > 0 ? String(runs.length) : undefined}
            >
              <RunsSection
                item={item}
                runs={runs}
                selectedRunId={selectedRunId}
                onOpenRun={onOpenRun}
                onCancelRun={onCancelRun}
                hasMore={hasMoreRuns}
                onLoadMore={onLoadMoreRuns}
                loading={runsLoading}
              />
            </ConsoleSection>

            {task && dependencyGraph ? (
              <ConsoleSection
                id="dependencies"
                title={t("dependencyGraph.title")}
                icon={GitBranchIcon}
                pane={pane}
                wide
                meta={
                  actions.onOpenDependencyGraph ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-[11px]"
                      onClick={actions.onOpenDependencyGraph}
                      data-testid="dependencies-open-graph"
                    >
                      {t("dependencyGraph.openFullGraph")}
                    </Button>
                  ) : undefined
                }
              >
                <div className="overflow-x-auto">
                  <TaskDependencyGraph
                    graph={dependencyGraph}
                    focusTaskId={task.id}
                    onSelectTask={(taskId) => onSelectItem(`app:${taskId}`)}
                  />
                </div>
              </ConsoleSection>
            ) : null}

            {task ? (
              <ConsoleSection
                id="notifications"
                title={t("notifications")}
                icon={BellIcon}
                pane={pane}
              >
                <TaskNotificationDisplay notification={task.notification} variant="bare" />
              </ConsoleSection>
            ) : null}

            {task?.tags && task.tags.length > 0 ? (
              <ConsoleSection id="tags" title={tDetail("tagsTitle")} icon={TagIcon} pane={pane}>
                <TaskTagsDisplay tags={task.tags} variant="bare" />
              </ConsoleSection>
            ) : null}

            {task && item.kind === "app" ? (
              <ConsoleSection
                id="workspace"
                title={tDetail("workspaceTitle")}
                icon={LayersIcon}
                pane={pane}
              >
                <TaskWorkspaceMove task={task} />
              </ConsoleSection>
            ) : null}

            <ConsoleSection id="origin" title={tDetail("originTitle")} icon={InfoIcon} pane={pane}>
              <OriginSection item={item} task={task} />
            </ConsoleSection>
          </div>
        </div>
      </div>
    </div>
  )
}
