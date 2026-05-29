"use client"

/**
 * Shared chrome for every dashboard panel: a card with a compact title bar, an
 * optional threshold status dot, an optional actions slot, and a drag handle
 * that only appears (and only carries the `.panel-drag-handle` class
 * react-grid-layout grabs) while the grid is in edit mode.
 */

import type { ReactNode } from "react"
import { GripVerticalIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { ThresholdLevel } from "@/lib/observability/thresholds"

const LEVEL_DOT: Record<ThresholdLevel, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  crit: "bg-destructive",
}

export interface PanelFrameProps {
  title: string
  editMode?: boolean
  level?: ThresholdLevel
  /** Right-aligned controls (e.g. open-in-drawer). */
  actions?: ReactNode
  children: ReactNode
  className?: string
  "data-testid"?: string
}

export function PanelFrame({
  title,
  editMode = false,
  level,
  actions,
  children,
  className,
  "data-testid": testId,
}: PanelFrameProps) {
  return (
    <Card
      className={cn("flex h-full min-h-0 flex-col overflow-hidden py-0 gap-0", className)}
      data-testid={testId}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
        {editMode && (
          <span
            className="panel-drag-handle -ml-1 cursor-grab text-muted-foreground active:cursor-grabbing"
            aria-hidden="true"
            data-testid="panel-drag-handle"
          >
            <GripVerticalIcon className="size-4" />
          </span>
        )}
        {level && (
          <span
            className={cn("size-2 shrink-0 rounded-full", LEVEL_DOT[level])}
            data-testid="panel-threshold-dot"
            data-level={level}
          />
        )}
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {title}
        </h3>
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-3">{children}</div>
    </Card>
  )
}
