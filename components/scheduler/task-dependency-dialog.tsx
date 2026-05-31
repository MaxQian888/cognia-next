"use client"

/**
 * Full task-dependency-graph dialog. Builds the complete DAG across every task
 * (excluding link-less tasks) and renders it in a scrollable {@link Dialog}.
 * Selecting a node closes the dialog and routes to that task's detail view.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { ScheduledTask } from "@/types/scheduler"
import { buildDependencyGraph } from "@/lib/scheduler/dependency-graph"
import { TaskDependencyGraph } from "./task-dependency-graph"

export interface TaskDependencyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tasks: ScheduledTask[]
  /** Optional node to highlight (e.g. the task the dialog was opened from). */
  focusTaskId?: string
  onSelectTask: (taskId: string) => void
}

export function TaskDependencyDialog({
  open,
  onOpenChange,
  tasks,
  focusTaskId,
  onSelectTask,
}: TaskDependencyDialogProps) {
  const t = useTranslations("scheduler.dependencyGraph")
  const graph = useMemo(() => buildDependencyGraph(tasks), [tasks])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="task-dependency-dialog">
        <DialogHeader>
          <DialogTitle>{t("fullGraphTitle")}</DialogTitle>
          <DialogDescription>{t("fullGraphDescription")}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] w-full">
          <div className="p-1">
            <TaskDependencyGraph
              graph={graph}
              focusTaskId={focusTaskId}
              onSelectTask={(id) => {
                onOpenChange(false)
                onSelectTask(id)
              }}
            />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
