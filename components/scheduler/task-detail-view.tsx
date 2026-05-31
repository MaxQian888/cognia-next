"use client"

/**
 * TaskDetailView - Composite detail panel composing all task detail sub-components
 * in a scrollable layout with an inline header.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Play, Pause, Pencil, MoreHorizontal, Trash2, RefreshCw, Network } from "lucide-react"
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
import { TaskExecutionChart } from "./task-execution-chart"
import { TaskExecutionHistory } from "./task-execution-history"
import { TaskConfiguration } from "./task-configuration"
import { TaskNotificationDisplay } from "./task-notification-display"
import { TaskTagsDisplay } from "./task-tags-display"
import { TaskDependencyGraph } from "./task-dependency-graph"
import { buildDependencyGraph, hasDependencyLinks } from "@/lib/scheduler/dependency-graph"

export interface TaskDetailViewProps {
  task: ScheduledTask
  executions: TaskExecution[]
  isLoading?: boolean
  onPause: (taskId: string) => void
  onResume: (taskId: string) => void
  onRunNow: (taskId: string) => void
  onDelete: (taskId: string) => void
  onEdit: () => void
  onCancelPluginExecution?: (executionId: string) => boolean
  isPluginExecutionActive?: (executionId: string) => boolean
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
  onCancelPluginExecution: _onCancelPluginExecution,
  isPluginExecutionActive: _isPluginExecutionActive,
  onSelectExecution,
  allTasks,
  onSelectTask,
  onOpenDependencyGraph,
}: TaskDetailViewProps) {
  const t = useTranslations("scheduler")

  const isPaused = task.status === "paused"

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
          <TaskStatsCards task={task} executions={executions} />

          <div className="mt-5">
            <TaskExecutionChart executions={executions} taskId={task.id} />
          </div>

          <div className="mt-5">
            <TaskExecutionHistory executions={executions} onSelectExecution={onSelectExecution} />
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
    </TooltipProvider>
  )
}
