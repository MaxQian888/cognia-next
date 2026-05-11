"use client"

/**
 * UnifiedTaskSidebarItem — renders a single `UnifiedScheduledItem` row,
 * driven by the item's `capabilities` so the same component works for app /
 * workflow / backup / plugin / system kinds with no per-kind divergence.
 *
 * Replaces both `TaskSidebarItem` (app-only) and the inline `<div role="button">`
 * system-task block that used to live in `SchedulerSidebar`.
 */

import React from "react"
import { useTranslations } from "next-intl"
import {
  Calendar,
  Workflow,
  Archive,
  Plug,
  Cog,
  Play,
  Pause,
  Pencil,
  Trash2,
  ArrowUpRight,
} from "lucide-react"
import Link from "next/link"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { formatNextRun } from "@/lib/scheduler/format-utils"
import type {
  ScheduledItemKind,
  UnifiedScheduledItem,
  UnifiedItemStatus,
  UnifiedTriggerSummary,
} from "@/types/scheduler/unified"

const kindConfig: Record<ScheduledItemKind, { icon: React.ReactNode; bg: string; color: string }> =
  {
    app: {
      icon: <Calendar className="h-3.5 w-3.5" />,
      bg: "bg-indigo-500/10",
      color: "text-indigo-500",
    },
    workflow: {
      icon: <Workflow className="h-3.5 w-3.5" />,
      bg: "bg-violet-500/10",
      color: "text-violet-500",
    },
    backup: {
      icon: <Archive className="h-3.5 w-3.5" />,
      bg: "bg-orange-500/10",
      color: "text-orange-500",
    },
    plugin: {
      icon: <Plug className="h-3.5 w-3.5" />,
      bg: "bg-emerald-500/10",
      color: "text-emerald-500",
    },
    system: {
      icon: <Cog className="h-3.5 w-3.5" />,
      bg: "bg-slate-500/10",
      color: "text-slate-500",
    },
  }

const statusDotColor: Record<UnifiedItemStatus, string> = {
  active: "bg-green-500",
  paused: "bg-yellow-500",
  disabled: "bg-gray-400",
  expired: "bg-red-500",
  unknown: "bg-gray-300",
}

type TFn = (key: string, values?: Record<string, string | number>) => string

function describeTrigger(t: UnifiedTriggerSummary, translate: TFn): string {
  switch (t.type) {
    case "cron":
      return t.cron ?? translate("triggerTypes.cron")
    case "interval": {
      const ms = t.intervalMs ?? 0
      const minutes = Math.round(ms / 60_000)
      return translate("every", { minutes })
    }
    case "once":
      return translate("triggerTypes.once")
    case "event":
      return t.eventType ?? translate("triggerTypes.event")
    default:
      return t.type
  }
}

export interface UnifiedTaskSidebarItemProps {
  item: UnifiedScheduledItem
  isActive: boolean
  isHighlighted?: boolean
  onClick: (item: UnifiedScheduledItem) => void
  onRunNow?: (item: UnifiedScheduledItem) => void
  onPause?: (item: UnifiedScheduledItem) => void
  onResume?: (item: UnifiedScheduledItem) => void
  onEdit?: (item: UnifiedScheduledItem) => void
  onDelete?: (item: UnifiedScheduledItem) => void
}

export function UnifiedTaskSidebarItem({
  item,
  isActive,
  isHighlighted,
  onClick,
  onRunNow,
  onPause,
  onResume,
  onEdit,
  onDelete,
}: UnifiedTaskSidebarItemProps) {
  const t = useTranslations("scheduler")
  const kindConf = kindConfig[item.kind]
  const dotColor = statusDotColor[item.status]
  const triggerText = describeTrigger(item.triggerSummary, t)
  const nextRunDate = typeof item.nextRunAt === "number" ? new Date(item.nextRunAt) : undefined
  const nextRunText = nextRunDate ? formatNextRun(nextRunDate) : ""
  const isPaused = item.status === "paused"

  const showRun = !!onRunNow && item.capabilities.runNow
  const showPauseResume = !!(onPause || onResume) && item.capabilities.pause
  const showEdit = !!onEdit && item.capabilities.edit
  const showDelete = !!onDelete && item.capabilities.delete
  const hasAnyAction = showRun || showPauseResume || showEdit || showDelete

  const rowContent = (
    <div
      role="button"
      tabIndex={0}
      data-testid={`unified-sidebar-item-${item.unifiedId}`}
      onClick={() => onClick(item)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick(item)
      }}
      className={cn(
        "flex cursor-pointer items-center gap-2 px-3 py-2 transition-all duration-200 hover:bg-accent/50",
        isActive && "bg-accent border-l-2 border-primary",
        isHighlighted && "ring-1 ring-primary/50"
      )}
    >
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded",
          kindConf.bg,
          kindConf.color
        )}
      >
        {kindConf.icon}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {triggerText}
          {nextRunDate ? ` · ${nextRunText}` : ""}
        </p>
      </div>

      <span
        data-testid="unified-status-dot"
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300",
          dotColor,
          item.status === "active" && "animate-pulse"
        )}
      />
    </div>
  )

  if (!hasAnyAction) {
    return rowContent
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{rowContent}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-44">
        {showRun && (
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation()
              onRunNow?.(item)
            }}
          >
            <Play className="mr-2 h-3.5 w-3.5" />
            {t("runNow") || "Run now"}
          </DropdownMenuItem>
        )}

        {showPauseResume && (
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation()
              if (isPaused) onResume?.(item)
              else onPause?.(item)
            }}
          >
            {isPaused ? (
              <>
                <Play className="mr-2 h-3.5 w-3.5" />
                {t("resume") || "Resume"}
              </>
            ) : (
              <>
                <Pause className="mr-2 h-3.5 w-3.5" />
                {t("pause") || "Pause"}
              </>
            )}
          </DropdownMenuItem>
        )}

        {(showEdit || showDelete) && (showRun || showPauseResume) && <DropdownMenuSeparator />}

        {showEdit && (
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation()
              onEdit?.(item)
            }}
          >
            <Pencil className="mr-2 h-3.5 w-3.5" />
            {t("edit") || "Edit"}
          </DropdownMenuItem>
        )}

        {!item.capabilities.edit && (
          <DropdownMenuItem asChild>
            <Link href={item.origin.deepLinkHref}>
              <ArrowUpRight className="mr-2 h-3.5 w-3.5" />
              {t("openInSourceEditor") || "Open in source editor"}
            </Link>
          </DropdownMenuItem>
        )}

        {showDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation()
                onDelete?.(item)
              }}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              {t("delete") || "Delete"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
