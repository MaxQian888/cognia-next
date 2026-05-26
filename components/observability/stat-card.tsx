"use client"

/**
 * StatCard — a compact KPI tile (colored icon chip + label + value + optional
 * trend arrow and sub-line). Extracted from `log-stats-dashboard` so the
 * logging analytics dashboard and the performance panel share one idiom
 * instead of each maintaining a private copy.
 *
 * (Distinct from `components/scheduler/stat-card.tsx`, which is the
 * gradient-accent scheduler/mobile idiom — kept separate on purpose.)
 */

import { MinusIcon, TrendingDownIcon, TrendingUpIcon, type LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
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
}: StatCardProps) {
  return (
    <Card className={className} data-testid={testId}>
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            color || "bg-primary/10 text-primary"
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          <div className="flex items-center gap-1.5">
            <p className="text-lg font-semibold leading-tight">{value}</p>
            {trend === "up" && <TrendingUpIcon className="h-3.5 w-3.5 text-destructive" />}
            {trend === "down" && <TrendingDownIcon className="h-3.5 w-3.5 text-success" />}
            {trend === "stable" && <MinusIcon className="h-3.5 w-3.5 text-muted-foreground" />}
          </div>
          {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  )
}
