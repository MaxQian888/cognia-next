"use client"

import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { A2UIWidgetHostStrategy, A2UIWidgetStatus } from "@/types/a2ui/schema"

interface A2UIWidgetShellProps {
  title?: string
  description?: string
  hostStrategy?: A2UIWidgetHostStrategy
  status?: A2UIWidgetStatus
  statusLabel?: string
  fallbackText?: string
  showChrome?: boolean
  className?: string
  children: ReactNode
}

export function A2UIWidgetShell({
  title,
  description,
  hostStrategy = "native",
  status = "ready",
  statusLabel,
  fallbackText,
  showChrome = true,
  className,
  children,
}: A2UIWidgetShellProps) {
  const showFallback = status === "fallback" || status === "error"

  return (
    <div
      data-testid="a2ui-widget-shell"
      className={cn("space-y-3 rounded-xl border border-border/60 bg-background/70 p-4", className)}
    >
      {showChrome ? (
        <div className="space-y-2">
          {title || description ? (
            <div className="space-y-1">
              {title ? <h3 className="text-sm font-semibold">{title}</h3> : null}
              {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="text-[11px] capitalize">
              {hostStrategy}
            </Badge>
            {status !== "ready" ? (
              <Badge variant="secondary" className="text-[11px]">
                {statusLabel || status}
              </Badge>
            ) : null}
          </div>
        </div>
      ) : null}

      {showFallback ? (
        <div className="rounded-lg border border-dashed border-border/70 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {fallbackText || "This widget is using its fallback presentation."}
        </div>
      ) : (
        children
      )}
    </div>
  )
}
