"use client"

/**
 * StatCard — a compact flat KPI tile (colored icon chip + label + value + optional
 * trend arrow and sub-line). Extracted from `log-stats-dashboard` so the
 * logging analytics dashboard and the performance panel share one idiom
 * instead of each maintaining a private copy.
 *
 * (Distinct from `components/scheduler/stat-card.tsx`, which is the
 * gradient-accent scheduler/mobile idiom — kept separate on purpose.)
 */

import { MinusIcon, TrendingDownIcon, TrendingUpIcon, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export type StatTrend = "up" | "down" | "stable"

export interface StatCardProps {
  icon: LucideIcon
  label: string
  value: string | number
  /** Optional secondary line under the value. */
  sub?: string
  /** Icon-chip color classes, e.g. `"bg-chart-1/10 text-chart-1"`. */
  color?: string
  /** Trend arrow next to the value (up = worse/red, down = better/green). */
  trend?: StatTrend
  className?: string
  "data-testid"?: string
  /**
   * Makes the tile a click-through (a native `<button>`, so it is focusable
   * and Enter / Space activate it). The logs dashboard uses it for the tiles
   * that name a filter — error rate opens the Error tab, and so on.
   */
  onClick?: () => void
  /**
   * What activating the tile does ("Show errors"). Becomes the tooltip and is
   * read after the tile's own label and value; only used with `onClick`.
   */
  actionLabel?: string
  /**
   * `tile` (default): a free-standing KPI tile with its own top and bottom
   * rule, for a grid of separate metrics (the performance panels).
   * `cell`: no rule of its own and a smaller icon — a cell of a ruled KPI
   * strip that draws the hairlines between its cells (the logs dashboard).
   * Eight `tile`s in a row read as eight cards; a strip of cells reads as one
   * summary.
   */
  variant?: "tile" | "cell"
}

export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
  trend,
  className,
  "data-testid": testId,
  onClick,
  actionLabel,
  variant = "tile",
}: StatCardProps) {
  const cell = variant === "cell"
  const body = (
    <>
      <div
        className={cn(
          "flex shrink-0 items-center justify-center",
          cell ? "size-8 rounded-md" : "h-10 w-10 rounded-lg",
          color || "bg-primary/10 text-primary"
        )}
      >
        <Icon className={cell ? "size-4" : "h-5 w-5"} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <div className="flex items-center gap-1.5">
          <p className="min-w-0 truncate text-lg font-semibold leading-tight">{value}</p>
          {trend === "up" && <TrendingUpIcon className="h-3.5 w-3.5 text-destructive" />}
          {trend === "down" && <TrendingDownIcon className="h-3.5 w-3.5 text-success" />}
          {trend === "stable" && <MinusIcon className="h-3.5 w-3.5 text-muted-foreground" />}
        </div>
        {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
      </div>
      {onClick && actionLabel ? <span className="sr-only">{actionLabel}</span> : null}
    </>
  )
  const baseClass = cell
    ? "flex min-w-0 items-center gap-2.5 bg-background px-3 py-2.5"
    : "flex min-w-0 items-center gap-3 border-y bg-background p-4"
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={actionLabel}
        className={cn(
          baseClass,
          "w-full text-left outline-none motion-safe:transition-colors hover:bg-muted/50",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
          className
        )}
        data-testid={testId}
        data-variant={variant}
      >
        {body}
      </button>
    )
  }
  return (
    <div className={cn(baseClass, className)} data-testid={testId} data-variant={variant}>
      {body}
    </div>
  )
}
