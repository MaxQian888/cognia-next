"use client"

// One kanban card. Thin render shell — drag identity comes from dnd-kit's
// useSortable (id = task.id), all move/lock decisions live in
// lib/ai/agent/team/board-model.ts + task-move-guard.ts.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { BotIcon, LockIcon, MessageSquareIcon, MoreHorizontalIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { cn } from "@/lib/utils"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { DependencyLockInfo } from "@/lib/ai/agent/team/board-model"
import type { AgentTeamTask } from "@/types/agent/agent-team"
import { TaskComments } from "../task-comments"

/** Left-border accent color keyed to task priority (matches the list view). */
function priorityAccent(priority?: string): string {
  switch (priority) {
    case "critical":
      return "border-l-red-500"
    case "high":
      return "border-l-amber-500"
    case "low":
      return "border-l-blue-500"
    case "background":
      return "border-l-slate-400"
    default:
      return "border-l-border"
  }
}

export interface TaskBoardCardProps {
  task: AgentTeamTask
  /** Resolved display name of claimedBy ?? assignedTo. */
  assigneeName?: string
  /** The owner teammate's bound digital employee, when any (twin badge). */
  twinName?: string
  lock: DependencyLockInfo
  /** Disables the drag handle (e.g. blocked column / runtime-owned while live). */
  dragDisabled?: boolean
}

export function TaskBoardCard({
  task,
  assigneeName,
  twinName,
  lock,
  dragDisabled,
}: TaskBoardCardProps) {
  const t = useTranslations("agentTeamsWorkspace.tasks.board")
  const tTasks = useTranslations("agentTeamsWorkspace.tasks")
  const tPriority = useTranslations("agentPriority")
  const deleteTask = useAgentTeamStore((s) => s.deleteTask)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: dragDisabled === true,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "opacity-60")}
    >
      <Card
        className={cn("space-y-1 border-l-2 p-2.5", priorityAccent(task.priority))}
        data-testid={`board-card-${task.id}`}
      >
        <div className="flex items-start justify-between gap-1.5">
          <button
            type="button"
            className={cn(
              "min-w-0 flex-1 text-left",
              dragDisabled ? "cursor-default" : "cursor-grab active:cursor-grabbing"
            )}
            aria-label={task.title}
            {...listeners}
            {...attributes}
          >
            <p className="truncate text-xs font-medium">{task.title}</p>
          </button>
          <div className="flex shrink-0 items-center gap-0.5">
            {lock.locked && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="inline-flex text-red-400"
                    data-testid={`board-card-${task.id}-lock`}
                  >
                    <LockIcon className="size-3" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t("lockedBy", {
                    titles: lock.blocking.map((b) => b.title ?? b.id).join(", "),
                  })}
                </TooltipContent>
              </Tooltip>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground"
                  aria-label={t("cardMenu")}
                  data-testid={`board-card-${task.id}-menu`}
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                {/* Plugin-contributed per-task actions (e.g. push to an
                    external tracker). Context mirrors the canonical point
                    contract in lib/plugin/contracts/plugin-points.ts. */}
                <PluginExtensionSlot
                  point="agent.team.task.actions"
                  context={{
                    teamId: task.teamId,
                    taskId: task.id,
                    status: task.status,
                    assignedTo: task.assignedTo,
                    tags: task.tags,
                  }}
                />
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setDeleteOpen(true)}
                  data-testid={`board-card-${task.id}-delete`}
                >
                  <Trash2Icon className="mr-1.5 size-3.5" />
                  {tTasks("delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
          <Badge variant="secondary" className="px-1 py-0 text-[10px]">
            {tPriority(task.priority)}
          </Badge>
          {assigneeName && <span className="truncate">{assigneeName}</span>}
          {twinName && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="gap-0.5 px-1 py-0 text-[10px]"
                  data-testid={`board-card-${task.id}-twin`}
                >
                  <BotIcon className="size-2.5" />
                  {twinName}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top">{t("twinBound", { name: twinName })}</TooltipContent>
            </Tooltip>
          )}
          {task.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="rounded bg-muted px-1 py-0.5">
              {tag}
            </span>
          ))}
        </div>

        {task.error && <p className="line-clamp-2 text-[10px] text-destructive">{task.error}</p>}

        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => setCommentsOpen((v) => !v)}
          aria-expanded={commentsOpen}
          data-testid={`board-card-${task.id}-comments`}
        >
          <MessageSquareIcon className="mr-1 size-3" />
          {tTasks("comments.count", { count: task.comments?.length ?? 0 })}
        </Button>
        {commentsOpen && <TaskComments taskId={task.id} />}
      </Card>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tTasks("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{tTasks("deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tTasks("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                deleteTask(task.id)
                toast.success(tTasks("taskDeleted"))
              }}
            >
              {tTasks("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
