"use client"

/**
 * TaskSidebarItem - Single task row for the scheduler sidebar
 * Clicking the row selects it; quick actions live behind a hover-revealed
 * "⋯" button so the menu never swallows the selection click.
 */

import React from "react"
import { useTranslations } from "next-intl"
import {
  MoreVertical,
  Workflow,
  Bot,
  Database,
  Archive,
  BookOpen,
  Radar,
  SearchCheck,
  Cog,
  Plug,
  FileCode,
  TestTube,
  MessageSquare,
  Send,
  Sparkles,
  Target,
  ListChecks,
  Users,
  Play,
  Pause,
  Pencil,
  Copy,
  Trash2,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { formatNextRun } from "@/lib/scheduler/format-utils"
import type { ScheduledTask, ScheduledTaskType, ScheduledTaskStatus } from "@/types/scheduler"

// ---------------------------------------------------------------------------
// Config maps
// ---------------------------------------------------------------------------

const taskTypeConfig: Record<
  ScheduledTaskType,
  { icon: React.ReactNode; bg: string; color: string }
> = {
  workflow: {
    icon: <Workflow className="h-3.5 w-3.5" />,
    bg: "bg-violet-500/10",
    color: "text-violet-500",
  },
  agent: {
    icon: <Bot className="h-3.5 w-3.5" />,
    bg: "bg-blue-500/10",
    color: "text-blue-500",
  },
  sync: {
    icon: <Database className="h-3.5 w-3.5" />,
    bg: "bg-cyan-500/10",
    color: "text-cyan-500",
  },
  backup: {
    icon: <Archive className="h-3.5 w-3.5" />,
    bg: "bg-orange-500/10",
    color: "text-orange-500",
  },
  custom: {
    icon: <Cog className="h-3.5 w-3.5" />,
    bg: "bg-gray-500/10",
    color: "text-gray-500",
  },
  plugin: {
    icon: <Plug className="h-3.5 w-3.5" />,
    bg: "bg-emerald-500/10",
    color: "text-emerald-500",
  },
  script: {
    icon: <FileCode className="h-3.5 w-3.5" />,
    bg: "bg-amber-500/10",
    color: "text-amber-500",
  },
  test: {
    icon: <TestTube className="h-3.5 w-3.5" />,
    bg: "bg-pink-500/10",
    color: "text-pink-500",
  },
  chat: {
    icon: <MessageSquare className="h-3.5 w-3.5" />,
    bg: "bg-indigo-500/10",
    color: "text-indigo-500",
  },
  "im-push": {
    icon: <Send className="h-3.5 w-3.5" />,
    bg: "bg-sky-500/10",
    color: "text-sky-500",
  },
  "ai-generation": {
    icon: <Sparkles className="h-3.5 w-3.5" />,
    bg: "bg-purple-500/10",
    color: "text-purple-500",
  },
  skill: {
    icon: <Sparkles className="h-3.5 w-3.5" />,
    bg: "bg-fuchsia-500/10",
    color: "text-fuchsia-500",
  },
  "external-agent": {
    icon: <Bot className="h-3.5 w-3.5" />,
    bg: "bg-teal-500/10",
    color: "text-teal-500",
  },
  twin: {
    icon: <Sparkles className="h-3.5 w-3.5" />,
    bg: "bg-rose-500/10",
    color: "text-rose-500",
  },
  goal: {
    icon: <Target className="h-3.5 w-3.5" />,
    bg: "bg-red-500/10",
    color: "text-red-500",
  },
  plan: {
    icon: <ListChecks className="h-3.5 w-3.5" />,
    bg: "bg-lime-500/10",
    color: "text-lime-500",
  },
  "agent-team": {
    icon: <Users className="h-3.5 w-3.5" />,
    bg: "bg-blue-500/10",
    color: "text-blue-500",
  },
  "connection:scheduled:digest": {
    icon: <Send className="h-3.5 w-3.5" />,
    bg: "bg-cyan-500/10",
    color: "text-cyan-500",
  },
  "connection:outbound:send": {
    icon: <Send className="h-3.5 w-3.5" />,
    bg: "bg-cyan-500/10",
    color: "text-cyan-500",
  },
  "wiki-rebuild": {
    icon: <BookOpen className="h-3.5 w-3.5" />,
    bg: "bg-indigo-500/10",
    color: "text-indigo-500",
  },
  "wiki-lint": {
    icon: <SearchCheck className="h-3.5 w-3.5" />,
    bg: "bg-teal-500/10",
    color: "text-teal-500",
  },
  "radar-report": {
    icon: <Radar className="h-3.5 w-3.5" />,
    bg: "bg-amber-500/10",
    color: "text-amber-500",
  },
}

const statusDotColor: Record<ScheduledTaskStatus, string> = {
  active: "bg-green-500",
  paused: "bg-yellow-500",
  disabled: "bg-gray-400",
  expired: "bg-red-500",
}

// ---------------------------------------------------------------------------
// Trigger text helper
// ---------------------------------------------------------------------------

type TriggerTextTranslator = (key: string, values?: Record<string, string | number>) => string

function getTriggerText(task: ScheduledTask, t: TriggerTextTranslator): string {
  const { trigger } = task
  switch (trigger.type) {
    case "cron":
      return trigger.cronExpression ?? t("triggerTypes.cron")
    case "interval": {
      const ms = trigger.intervalMs ?? 0
      const minutes = Math.round(ms / 60000)
      return t("every", { minutes })
    }
    case "once":
      return t("triggerTypes.once")
    case "event":
      return trigger.eventType ?? t("triggerTypes.event")
    default:
      return trigger.type
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TaskSidebarItemProps {
  task: ScheduledTask
  isActive: boolean
  isHighlighted?: boolean
  onClick: (taskId: string) => void
  onRunNow?: (taskId: string) => void
  onPause?: (taskId: string) => void
  onResume?: (taskId: string) => void
  onEdit?: (taskId: string) => void
  onDuplicate?: (taskId: string) => void
  onDelete?: (taskId: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TaskSidebarItem = React.memo(function TaskSidebarItem({
  task,
  isActive,
  isHighlighted,
  onClick,
  onRunNow,
  onPause,
  onResume,
  onEdit,
  onDuplicate,
  onDelete,
}: TaskSidebarItemProps) {
  const t = useTranslations("scheduler")
  const typeConf = taskTypeConfig[task.type] ?? taskTypeConfig.custom
  const dotColor = statusDotColor[task.status] ?? "bg-gray-400"
  const triggerText = getTriggerText(task, t)
  const nextRunText = formatNextRun(task.nextRunAt)
  const isPaused = task.status === "paused"
  const hasAnyAction = !!(onRunNow || onPause || onResume || onEdit || onDuplicate || onDelete)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick(task.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick(task.id)
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-2 px-3 py-2 transition-all duration-200 hover:bg-accent/50",
        isActive && "bg-accent border-l-2 border-primary",
        isHighlighted && "ring-1 ring-primary/50"
      )}
    >
      {/* Type icon */}
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded",
          typeConf.bg,
          typeConf.color
        )}
      >
        {typeConf.icon}
      </span>

      {/* Name + meta */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{task.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {triggerText}
          {task.nextRunAt ? ` · ${nextRunText}` : ""}
        </p>
      </div>

      {/* Status dot */}
      <span
        data-testid="status-dot"
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300",
          dotColor,
          task.status === "active" && "animate-pulse"
        )}
      />

      {hasAnyAction && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("moreOptions")}
              data-testid={`task-row-menu-${task.id}`}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground",
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
              )}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right" className="w-44">
            {onRunNow && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation()
                  onRunNow(task.id)
                }}
              >
                <Play className="mr-2 h-3.5 w-3.5" />
                {t("runNow")}
              </DropdownMenuItem>
            )}

            {(onPause || onResume) && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation()
                  if (isPaused) onResume?.(task.id)
                  else onPause?.(task.id)
                }}
              >
                {isPaused ? (
                  <>
                    <Play className="mr-2 h-3.5 w-3.5" />
                    {t("resume")}
                  </>
                ) : (
                  <>
                    <Pause className="mr-2 h-3.5 w-3.5" />
                    {t("pause")}
                  </>
                )}
              </DropdownMenuItem>
            )}

            {onEdit && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation()
                    onEdit(task.id)
                  }}
                >
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  {t("edit")}
                </DropdownMenuItem>
              </>
            )}

            {onDuplicate && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation()
                  onDuplicate(task.id)
                }}
              >
                <Copy className="mr-2 h-3.5 w-3.5" />
                {t("duplicate")}
              </DropdownMenuItem>
            )}

            {onDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(task.id)
                  }}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  {t("delete")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
})
