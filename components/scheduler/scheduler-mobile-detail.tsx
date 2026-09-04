"use client"

/**
 * SchedulerMobileDetailView - Full-screen mobile detail view with push navigation
 * Shows task details with a header containing back button, status badge, and more menu.
 *
 * Supports two modes:
 *   - "app": full app-task detail with stats / chart / execution history (the
 *     original path, preserved for backward compatibility).
 *   - "unified": delegates the body to `UnifiedTaskDetailView` so every other
 *     kind (workflow / backup / plugin / connector / system) gets full mobile
 *     parity instead of a dead-end.
 *
 * The page decides which mode to use based on whichever selection state is
 * populated.
 */

import { useTranslations } from "next-intl"
import { ArrowLeft, Play, Pause, Pencil, MoreVertical, Trash2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"
import { TaskStatsCards } from "./task-stats-cards"
import { TaskExecutionChart, toChartPointsFromExecutions } from "./task-execution-chart"
import { TaskExecutionHistory } from "./task-execution-history"
import { TaskProcessPanel } from "./task-process-panel"
import { TaskConfiguration } from "./task-configuration"
import { TaskWorkspaceMove } from "./task-workspace-move"
import { TaskNotificationDisplay } from "./task-notification-display"
import { TaskTagsDisplay } from "./task-tags-display"
import { UnifiedTaskDetailView } from "./unified-task-detail-view"
import { toUnifiedFromTaskExecution } from "@/hooks/scheduler/use-unified-recent-runs"

export interface SchedulerMobileDetailViewProps {
  /** App-kind path: when supplied, render the rich app-specific sections. */
  task?: ScheduledTask
  executions?: TaskExecution[]
  /**
   * Unified path: when supplied and `task` is absent, render the orchestrator
   * body so every kind has mobile parity.
   */
  unifiedItem?: UnifiedScheduledItem
  isLoading?: boolean
  onBack: () => void
  onPause: (taskId: string) => void
  onResume: (taskId: string) => void
  onRunNow: (taskId: string) => void
  onDelete: (taskId: string) => void
  onEdit: () => void
  /** Unified-only handlers. */
  onUnifiedRunNow?: (item: UnifiedScheduledItem) => void
  onUnifiedPause?: (item: UnifiedScheduledItem) => void
  onUnifiedResume?: (item: UnifiedScheduledItem) => void
  onUnifiedDelete?: (item: UnifiedScheduledItem) => void
  onSelectRun?: (run: UnifiedExecutionRun) => void
  /** Execution-history pagination + plugin-run cancel (app-kind path only). */
  hasMoreExecutions?: boolean
  onLoadMoreExecutions?: () => Promise<void> | void
  /**
   * Stop a running execution of any task type.
   *
   * Replaces the `onCancelPluginExecution` / `isPluginExecutionActive` pair,
   * which only ever reached plugin runs. Everything else the scheduler starts,
   * including an agent turn and a spawned OS process, had no control here.
   */
  onCancelExecution?: (executionId: string) => void
}

const statusColors: Record<string, string> = {
  active: "border-green-500/30 bg-green-500/10 text-green-500",
  paused: "border-yellow-500/30 bg-yellow-500/10 text-yellow-500",
  disabled: "border-gray-400/30 bg-gray-400/10 text-gray-400",
  expired: "border-red-500/30 bg-red-500/10 text-red-500",
  unknown: "border-border bg-muted text-muted-foreground",
}

export function SchedulerMobileDetailView({
  task,
  executions,
  unifiedItem,
  isLoading: _isLoading,
  onBack,
  onPause,
  onResume,
  onRunNow,
  onDelete,
  onEdit,
  onUnifiedRunNow,
  onUnifiedPause,
  onUnifiedResume,
  onUnifiedDelete,
  onSelectRun,
  hasMoreExecutions,
  onLoadMoreExecutions,
  onCancelExecution,
}: SchedulerMobileDetailViewProps) {
  const t = useTranslations("scheduler")

  // App-kind path: original rich detail layout.
  if (task) {
    const isPaused = task.status === "paused"

    return (
      <div className="flex flex-col h-full bg-background">
        <header className="border-b px-4 py-3 flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label={t("back") || "Back"}
            data-testid="mobile-detail-back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>

          <h1 className="text-sm font-semibold truncate flex-1">{task.name}</h1>

          <Badge
            variant="outline"
            data-testid="mobile-detail-status-badge"
            className={cn("shrink-0 text-[10px] px-1.5 py-0 h-5", statusColors[task.status] ?? "")}
          >
            {t(`statuses.${task.status}`) || task.status}
          </Badge>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("more") || "More"}
                data-testid="mobile-detail-more-trigger"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => onRunNow(task.id)}>
                <Play className="mr-2 h-4 w-4" />
                {t("runNow") || "Run Now"}
              </DropdownMenuItem>

              <DropdownMenuItem onClick={() => (isPaused ? onResume(task.id) : onPause(task.id))}>
                {isPaused ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t("resume") || "Resume"}
                  </>
                ) : (
                  <>
                    <Pause className="mr-2 h-4 w-4" />
                    {t("pause") || "Pause"}
                  </>
                )}
              </DropdownMenuItem>

              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="mr-2 h-4 w-4" />
                {t("edit") || "Edit"}
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => onDelete(task.id)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t("delete") || "Delete"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <div className="flex-1 min-h-0 overflow-auto p-4">
          <div className="space-y-5">
            <TaskStatsCards task={task} executions={executions ?? []} />
            <TaskExecutionChart runs={toChartPointsFromExecutions(executions ?? [], task.id)} />
            <TaskProcessPanel taskId={task.id} taskType={task.type} />
            <TaskExecutionHistory
              executions={executions ?? []}
              onSelectExecution={
                onSelectRun ? (exec) => onSelectRun(toUnifiedFromTaskExecution(exec)) : undefined
              }
              hasMoreOnServer={hasMoreExecutions}
              onLoadMore={onLoadMoreExecutions}
              onCancelExecution={onCancelExecution}
            />
            {/* This view composes its own body rather than delegating to
                `TaskDetailView`, so mounting the workspace control there alone
                left `/me/scheduler` and both mobile detail paths without it. */}
            <TaskWorkspaceMove task={task} />
            <TaskConfiguration task={task} />
            <TaskNotificationDisplay notification={task.notification} />
            <TaskTagsDisplay tags={task.tags ?? []} />
          </div>
        </div>
      </div>
    )
  }

  // Unified path — every other kind. Header + orchestrator body.
  if (unifiedItem) {
    return (
      <div className="flex flex-col h-full bg-background">
        <header className="border-b px-4 py-3 flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label={t("back") || "Back"}
            data-testid="mobile-detail-back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-sm font-semibold truncate flex-1">{unifiedItem.name}</h1>
          <Badge
            variant="outline"
            data-testid="mobile-detail-status-badge"
            className={cn(
              "shrink-0 text-[10px] px-1.5 py-0 h-5",
              statusColors[unifiedItem.status] ?? ""
            )}
          >
            {t(`statuses.${unifiedItem.status}`) || unifiedItem.status}
          </Badge>
        </header>
        <div className="flex-1 min-h-0 overflow-auto">
          <UnifiedTaskDetailView
            item={unifiedItem}
            onRunNow={onUnifiedRunNow}
            onPause={onUnifiedPause}
            onResume={onUnifiedResume}
            onDelete={onUnifiedDelete}
            onSelectRun={onSelectRun}
          />
        </div>
      </div>
    )
  }

  return null
}
