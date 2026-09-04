"use client"

/**
 * TaskDetailView - Composite detail panel composing all task detail sub-components
 * in a scrollable layout with an inline header.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Play,
  Pause,
  Pencil,
  MoreHorizontal,
  Trash2,
  RefreshCw,
  Network,
  History,
  ArrowUpFromLine,
  ArrowDownToLine,
  CopyPlus,
} from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { TaskStatsCards } from "./task-stats-cards"
import { TaskExecutionChart, toChartPointsFromExecutions } from "./task-execution-chart"
import { TaskExecutionHistory } from "./task-execution-history"
import { TaskProcessPanel } from "./task-process-panel"
import { TaskConfiguration } from "./task-configuration"
import { TaskWorkspaceMove } from "./task-workspace-move"
import { TaskNotificationDisplay } from "./task-notification-display"
import { TaskTagsDisplay } from "./task-tags-display"
import { TaskDependencyGraph } from "./task-dependency-graph"
import { buildDependencyGraph, hasDependencyLinks } from "@/lib/scheduler/dependency-graph"
import { isDeprecatedTaskType } from "@/lib/scheduler/host-support"
import { PROMOTABLE_TRIGGER_TYPES } from "@/lib/scheduler/promote-to-system"

export interface TaskDetailViewProps {
  task: ScheduledTask
  executions: TaskExecution[]
  isLoading?: boolean
  onPause: (taskId: string) => void
  onResume: (taskId: string) => void
  onRunNow: (taskId: string) => void
  onDelete: (taskId: string) => void
  onEdit: () => void
  /**
   * Cancel a running plugin task execution. The controller lives in
   * `lib/scheduler/executors/plugin-executor.ts` and the store already
   * exposes both halves — the execution list simply never offered the action.
   */
  /**
   * Stop a running execution of any task type.
   *
   * Replaces the `onCancelPluginExecution` / `isPluginExecutionActive` pair,
   * which only ever reached plugin runs. Everything else the scheduler starts,
   * including an agent turn and a spawned OS process, had no control here.
   */
  onCancelExecution?: (executionId: string) => void
  /** True while the store holds more execution rows than it has loaded. */
  hasMoreExecutions?: boolean
  /** Fetch the next page of execution rows (store `loadMoreExecutions`). */
  onLoadMoreExecutions?: () => Promise<void> | void
  /**
   * Optional: fired when the user clicks a row in the execution history.
   * The page maps the click to opening the `RunDetailSheet` with a unified
   * execution-run view of the selected row.
   */
  onSelectExecution?: (execution: TaskExecution) => void
  /**
   * All app tasks — when supplied (and this task has dependency links) a
   * "Dependencies" card renders the task's upstream/downstream neighborhood.
   */
  allTasks?: ScheduledTask[]
  /** Navigate to another task (clicking a dependency node). */
  onSelectTask?: (taskId: string) => void
  /** Open the full dependency-graph dialog. */
  onOpenDependencyGraph?: () => void
  /** Opens the backfill dialog (recurring triggers only). */
  onBackfill?: () => void
  /**
   * Duplicate this task into a new paused row. The store has implemented
   * `cloneTask` since the scheduler shipped and the hook exposed it; no
   * surface ever called it.
   */
  onClone?: (taskId: string) => void
  /**
   * OS promotion (desktop, own schedule only). When `onPromote` is supplied the
   * "Promote to system" entry is offered for cron/interval/once tasks that are
   * not yet promoted; `onUnpromote` powers the reverse. `promotionAvailable`
   * false shows the entry disabled with the reason.
   */
  onPromote?: (taskId: string) => void
  onUnpromote?: (taskId: string) => void
  promotionAvailable?: boolean
  promotionUnavailableReason?: string
}

const statusBadgeClass: Record<string, string> = {
  active: "border-green-500/30 bg-green-500/10 text-green-500",
  paused: "border-yellow-500/30 bg-yellow-500/10 text-yellow-500",
  disabled: "border-gray-400/30 bg-gray-400/10 text-gray-400",
  expired: "border-red-500/30 bg-red-500/10 text-red-500",
}

export function TaskDetailView({
  task,
  executions,
  isLoading: _isLoading,
  onPause,
  onResume,
  onRunNow,
  onDelete,
  onEdit,
  onCancelExecution,
  hasMoreExecutions,
  onLoadMoreExecutions,
  onSelectExecution,
  allTasks,
  onSelectTask,
  onOpenDependencyGraph,
  onBackfill,
  onClone,
  onPromote,
  onUnpromote,
  promotionAvailable = true,
  promotionUnavailableReason,
}: TaskDetailViewProps) {
  const t = useTranslations("scheduler")

  const isPaused = task.status === "paused"
  const isPromoted = Boolean(task.promotion)
  // The promotion module owns which triggers an OS backend can express; this
  // used to re-list them by hand, so widening one list silently left the other
  // behind.
  const promotableTrigger = PROMOTABLE_TRIGGER_TYPES.has(task.trigger.type)
  const [promoteConfirmOpen, setPromoteConfirmOpen] = useState(false)

  const showDependencies = !!allTasks && hasDependencyLinks(task, allTasks)
  const dependencyGraph = useMemo(
    () => (showDependencies ? buildDependencyGraph(allTasks!, { focusTaskId: task.id }) : null),
    [showDependencies, allTasks, task.id]
  )

  return (
    <TooltipProvider>
      <div className="flex flex-col h-full">
        {/* Inline header */}
        <div className="px-5 py-4 sm:px-6 border-b">
          <div className="flex items-start justify-between gap-3">
            {/* Left side: title, description, badges */}
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold truncate">{task.name}</h2>
              {task.description && (
                <p className="text-xs text-muted-foreground mt-1">{task.description}</p>
              )}
              <div className="flex flex-wrap gap-1.5 mt-2">
                {/* Status badge */}
                <Badge
                  variant="outline"
                  className={cn("text-[10px] px-1.5 py-0 h-5", statusBadgeClass[task.status] ?? "")}
                >
                  {t(`statuses.${task.status}`) || task.status}
                </Badge>
                {/* Trigger type badge */}
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-5 border-border/50 text-muted-foreground"
                >
                  {t(`triggerTypes.${task.trigger.type}`) || task.trigger.type}
                </Badge>
                {/* Task type badge */}
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-5 border-border/50 text-muted-foreground"
                >
                  {t(`taskTypes.${task.type}`) || task.type}
                </Badge>
                {isPromoted && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 h-5 border-sky-500/30 bg-sky-500/10 text-sky-500"
                    data-testid="task-promoted-badge"
                    title={t("promote.badgeHelp")}
                  >
                    <ArrowUpFromLine className="mr-1 h-3 w-3" aria-hidden="true" />
                    {task.promotion?.backend
                      ? t("promote.badgeWithBackend", { backend: task.promotion.backend })
                      : t("promote.badge")}
                  </Badge>
                )}
              </div>
            </div>

            {/* Right side: action buttons */}
            <div className="flex gap-1.5 shrink-0">
              {/* Run Now */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 border-green-500/30 text-green-500 hover:bg-green-500/10 hover:text-green-500"
                    onClick={() => onRunNow(task.id)}
                    aria-label={t("runNow") || "Run Now"}
                  >
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("runNow") || "Run Now"}</TooltipContent>
              </Tooltip>

              {/* Pause / Resume */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => (isPaused ? onResume(task.id) : onPause(task.id))}
                    aria-label={isPaused ? t("resume") || "Resume" : t("pause") || "Pause"}
                  >
                    {isPaused ? (
                      <RefreshCw className="h-3.5 w-3.5" />
                    ) : (
                      <Pause className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {isPaused ? t("resume") || "Resume" : t("pause") || "Pause"}
                </TooltipContent>
              </Tooltip>

              {/* Edit */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={onEdit}
                    aria-label={t("edit") || "Edit"}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("edit") || "Edit"}</TooltipContent>
              </Tooltip>

              {/* More (dropdown) */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={t("more") || "More"}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {onBackfill &&
                    (task.trigger.type === "cron" || task.trigger.type === "interval") && (
                      <DropdownMenuItem onClick={onBackfill} data-testid="open-backfill-dialog">
                        <History className="mr-2 h-3.5 w-3.5" />
                        {t("backfill.open")}
                      </DropdownMenuItem>
                    )}
                  {onClone && (
                    <DropdownMenuItem onClick={() => onClone(task.id)} data-testid="clone-task">
                      <CopyPlus className="mr-2 h-3.5 w-3.5" />
                      {t("duplicate")}
                    </DropdownMenuItem>
                  )}
                  {onPromote && !isPromoted && promotableTrigger && (
                    <DropdownMenuItem
                      onClick={() => setPromoteConfirmOpen(true)}
                      disabled={!promotionAvailable}
                      title={!promotionAvailable ? promotionUnavailableReason : undefined}
                      data-testid="promote-task"
                    >
                      <ArrowUpFromLine className="mr-2 h-3.5 w-3.5" />
                      {t("promote.button")}
                    </DropdownMenuItem>
                  )}
                  {onUnpromote && isPromoted && (
                    <DropdownMenuItem
                      onClick={() => onUnpromote(task.id)}
                      data-testid="unpromote-task"
                    >
                      <ArrowDownToLine className="mr-2 h-3.5 w-3.5" />
                      {t("promote.remove")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => onDelete(task.id)}
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    {t("delete") || "Delete"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <Separator className="mt-4" />
        </div>

        {/* Scrollable content */}
        <ScrollArea className="flex-1 p-5 sm:p-6">
          {isDeprecatedTaskType(task.type) && (
            <div
              className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
              role="alert"
              data-testid="task-deprecated-banner"
            >
              {t("hostSupport.deprecatedBanner", { type: task.type })}
            </div>
          )}
          <TaskStatsCards task={task} executions={executions} />

          <div className="mt-5">
            <TaskExecutionChart runs={toChartPointsFromExecutions(executions, task.id)} />
          </div>

          <TaskProcessPanel taskId={task.id} taskType={task.type} />

          <div className="mt-5">
            <TaskExecutionHistory
              executions={executions}
              onSelectExecution={onSelectExecution}
              hasMoreOnServer={hasMoreExecutions}
              onLoadMore={onLoadMoreExecutions}
              onCancelExecution={onCancelExecution}
            />
          </div>

          {/* The owning workspace, above the read-only configuration block.
              It is editable rather than displayed because a schedule bound to
              the wrong workspace is invisible from every other one, so there
              was nowhere to correct it from. */}
          <div className="mt-5" data-testid="task-workspace-section">
            <TaskWorkspaceMove task={task} />
          </div>

          <div className="mt-5">
            <TaskConfiguration task={task} />
          </div>

          {dependencyGraph && (
            <div className="mt-5" data-testid="task-dependencies-card">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Network className="h-4 w-4 text-blue-500" aria-hidden="true" />
                  {t("dependencyGraph.title")}
                </h3>
                {onOpenDependencyGraph && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={onOpenDependencyGraph}
                    data-testid="open-dependency-graph"
                  >
                    {t("dependencyGraph.openFullGraph")}
                  </Button>
                )}
              </div>
              <div className="overflow-x-auto rounded-lg border border-border/50 p-3">
                <TaskDependencyGraph
                  graph={dependencyGraph}
                  focusTaskId={task.id}
                  onSelectTask={(id) => onSelectTask?.(id)}
                />
              </div>
            </div>
          )}

          <div className="mt-5">
            <TaskNotificationDisplay notification={task.notification} />
          </div>

          <div className="mt-5">
            <TaskTagsDisplay tags={task.tags ?? []} />
          </div>
        </ScrollArea>
      </div>
      <AlertDialog open={promoteConfirmOpen} onOpenChange={setPromoteConfirmOpen}>
        <AlertDialogContent data-testid="promote-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("promote.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("promote.confirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setPromoteConfirmOpen(false)
                onPromote?.(task.id)
              }}
              data-testid="promote-confirm-accept"
            >
              {t("promote.button")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}
