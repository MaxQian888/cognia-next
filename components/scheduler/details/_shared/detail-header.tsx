"use client"

/**
 * Shared header used by every unified-detail sub-view (except `app`, which
 * uses `TaskDetailView`'s own header). Renders the kind icon, item name,
 * status badge, and any actions the source's capabilities permit.
 */

import { useTranslations } from "next-intl"
import { Play, Pause, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { kindConfig } from "./kind-config"
import type { UnifiedScheduledItem, UnifiedItemStatus } from "@/types/scheduler/unified"

const statusBadgeClass: Record<UnifiedItemStatus, string> = {
  active: "border-green-500/30 bg-green-500/10 text-green-600",
  paused: "border-yellow-500/30 bg-yellow-500/10 text-yellow-600",
  disabled: "border-gray-400/30 bg-gray-400/10 text-gray-500",
  expired: "border-red-500/30 bg-red-500/10 text-red-600",
  unknown: "border-border bg-muted text-muted-foreground",
}

export interface DetailHeaderProps {
  item: UnifiedScheduledItem
  onRunNow?: (item: UnifiedScheduledItem) => void
  onPause?: (item: UnifiedScheduledItem) => void
  onResume?: (item: UnifiedScheduledItem) => void
  onEdit?: (item: UnifiedScheduledItem) => void
  onDelete?: (item: UnifiedScheduledItem) => void
}

export function DetailHeader({
  item,
  onRunNow,
  onPause,
  onResume,
  onEdit,
  onDelete,
}: DetailHeaderProps) {
  const t = useTranslations("scheduler")
  const kindConf = kindConfig[item.kind]
  const badge = statusBadgeClass[item.status]
  const isPaused = item.status === "paused"

  return (
    <header className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 border-b sm:flex-nowrap">
      <div className="min-w-0 flex flex-1 items-start gap-3">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
            kindConf.bg,
            kindConf.color
          )}
          data-testid="detail-header-icon"
        >
          {kindConf.icon}
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold" data-testid="detail-header-name">
            {item.name}
          </h2>
          {item.description ? (
            <p className="truncate text-xs text-muted-foreground" data-testid="detail-header-desc">
              {item.description}
            </p>
          ) : null}
          <div className="mt-1 flex items-center gap-2">
            <Badge variant="outline" className={cn("text-[10px]", badge)}>
              {t(`statuses.${item.status}`) || item.status}
            </Badge>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t(`kindFilter.${item.kind}`) || item.kind}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap shrink-0 items-center gap-1.5">
        {onRunNow && item.capabilities.runNow && (
          <Button
            size="sm"
            variant="outline"
            data-testid="detail-action-run"
            onClick={() => onRunNow(item)}
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {t("runNow") || "Run now"}
          </Button>
        )}
        {item.capabilities.pause && (
          <Button
            size="sm"
            variant="outline"
            data-testid="detail-action-pause-resume"
            onClick={() => {
              if (isPaused) onResume?.(item)
              else onPause?.(item)
            }}
          >
            {isPaused ? (
              <>
                <Play className="mr-1.5 h-3.5 w-3.5" />
                {t("resume") || "Resume"}
              </>
            ) : (
              <>
                <Pause className="mr-1.5 h-3.5 w-3.5" />
                {t("pause") || "Pause"}
              </>
            )}
          </Button>
        )}
        {onEdit && item.capabilities.edit && (
          <Button
            size="sm"
            variant="outline"
            data-testid="detail-action-edit"
            onClick={() => onEdit(item)}
          >
            <Pencil className="mr-1.5 h-3.5 w-3.5" />
            {t("edit") || "Edit"}
          </Button>
        )}
        {onDelete && item.capabilities.delete && (
          <Button
            size="sm"
            variant="destructive"
            data-testid="detail-action-delete"
            onClick={() => onDelete(item)}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {t("delete") || "Delete"}
          </Button>
        )}
      </div>
    </header>
  )
}
