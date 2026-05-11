"use client"

/**
 * SchedulerMobileDetailView - Full-screen mobile detail view with push navigation
 * Shows task details with a header containing back button, status badge, and more menu.
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
import { TaskStatsCards } from "./task-stats-cards"
import { TaskExecutionChart } from "./task-execution-chart"
import { TaskExecutionHistory } from "./task-execution-history"
import { TaskConfiguration } from "./task-configuration"
import { TaskNotificationDisplay } from "./task-notification-display"
import { TaskTagsDisplay } from "./task-tags-display"

export interface SchedulerMobileDetailViewProps {
  task: ScheduledTask
  executions: TaskExecution[]
  isLoading?: boolean
  onBack: () => void
  onPause: (taskId: string) => void
  onResume: (taskId: string) => void
  onRunNow: (taskId: string) => void
  onDelete: (taskId: string) => void
  onEdit: () => void
}

const statusColors: Record<string, string> = {
  active: "border-green-500/30 bg-green-500/10 text-green-500",
  paused: "border-yellow-500/30 bg-yellow-500/10 text-yellow-500",
  disabled: "border-gray-400/30 bg-gray-400/10 text-gray-400",
  expired: "border-red-500/30 bg-red-500/10 text-red-500",
}

export function SchedulerMobileDetailView({
  task,
  executions,
  isLoading: _isLoading,
  onBack,
  onPause,
  onResume,
  onRunNow,
  onDelete,
  onEdit,
}: SchedulerMobileDetailViewProps) {
  const t = useTranslations("scheduler")

  const isPaused = task.status === "paused"

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <header className="border-b px-4 py-3 flex items-center gap-3">
        {/* Back button */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label={t("back") || "Back"}
          data-testid="mobile-detail-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        {/* Task name */}
        <h1 className="text-sm font-semibold truncate flex-1">{task.name}</h1>

        {/* Status badge */}
        <Badge
          variant="outline"
          data-testid="mobile-detail-status-badge"
          className={cn("shrink-0 text-[10px] px-1.5 py-0 h-5", statusColors[task.status] ?? "")}
        >
          {t(`statuses.${task.status}`) || task.status}
        </Badge>

        {/* More actions dropdown */}
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

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-auto p-4">
        <div className="space-y-5">
          <TaskStatsCards task={task} executions={executions} />
          <TaskExecutionChart executions={executions} taskId={task.id} />
          <TaskExecutionHistory executions={executions} />
          <TaskConfiguration task={task} />
          <TaskNotificationDisplay notification={task.notification} />
          <TaskTagsDisplay tags={task.tags ?? []} />
        </div>
      </div>
    </div>
  )
}
