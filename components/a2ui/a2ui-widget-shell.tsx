"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type {
  A2UIWidgetHostStrategy,
  A2UIWidgetSizing,
  A2UIWidgetStatus,
  A2UIWidgetTheme,
} from "@/types/a2ui/schema"

const DEFAULT_FIXED_HEIGHT = 320

interface A2UIWidgetShellProps {
  title?: string
  description?: string
  hostStrategy?: A2UIWidgetHostStrategy
  sizing?: A2UIWidgetSizing
  theme?: A2UIWidgetTheme
  status?: A2UIWidgetStatus
  statusLabel?: string
  fallbackText?: string
  showChrome?: boolean
  minHeight?: number
  className?: string
  children: ReactNode
}

export function A2UIWidgetShell({
  title,
  description,
  hostStrategy = "native",
  sizing = "auto",
  theme = "inherit",
  status = "ready",
  statusLabel,
  fallbackText,
  showChrome = true,
  minHeight,
  className,
  children,
}: A2UIWidgetShellProps) {
  const t = useTranslations("a2ui")
  const showFallback = status === "fallback" || status === "error"
  const fixedHeight = sizing === "fixed-height" ? (minHeight ?? DEFAULT_FIXED_HEIGHT) : undefined

  return (
    <div
      data-testid="a2ui-widget-shell"
      data-host-strategy={hostStrategy}
      data-sizing={sizing}
      data-theme={theme}
      style={{ minHeight, height: fixedHeight }}
      className={cn(
        "space-y-3 rounded-xl border border-border/60 bg-background/70 p-4",
        theme === "light" && "a2ui-widget-theme-light",
        theme === "dark" && "a2ui-widget-theme-dark dark",
        sizing === "fixed-height" && "overflow-auto",
        className
      )}
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
          {fallbackText || t("widgetShell.fallback")}
        </div>
      ) : (
        children
      )}
    </div>
  )
}
