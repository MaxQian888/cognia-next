"use client"

/**
 * Shared stat card primitive — extracted from `scheduler-dashboard-view` so
 * the desktop dashboard, the per-task detail strip, and the mobile carousel
 * can all share the same gradient-accent visual without duplication.
 *
 * `size="md"` reproduces the original dashboard card (h-10 icon, text-2xl
 * value, p-4 padding). `size="sm"` is tuned for the mobile horizontal
 * carousel — tighter (h-7 icon, text-xl value, p-3 padding) so 2.5 cards
 * fit on a 375-wide viewport.
 */

import * as React from "react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export interface StatCardProps {
  label: string
  value: string | number
  icon: React.ReactNode
  valueClassName?: string
  accentGradient: string
  iconBgClassName: string
  /** Compact variant for narrow horizontal carousels. */
  size?: "md" | "sm"
  className?: string
  /** Optional test id forwarded to the outer Card. */
  testid?: string
}

export function StatCard({
  label,
  value,
  icon,
  valueClassName,
  accentGradient,
  iconBgClassName,
  size = "md",
  className,
  testid,
}: StatCardProps) {
  const isSm = size === "sm"
  return (
    <Card
      data-testid={testid}
      className={cn(
        "relative overflow-hidden border-border/50 bg-card/80",
        "transition-all hover:-translate-y-0.5 hover:shadow-lg",
        className
      )}
    >
      <CardContent className={cn(isSm ? "p-3" : "p-4 pb-5")}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
            <p
              className={cn(
                "mt-1 font-bold tabular-nums",
                isSm ? "text-xl" : "text-2xl",
                valueClassName
              )}
            >
              {value}
            </p>
          </div>
          <div
            className={cn(
              "flex shrink-0 items-center justify-center",
              isSm ? "h-7 w-7 rounded-md" : "h-10 w-10 rounded-xl",
              iconBgClassName
            )}
          >
            {icon}
          </div>
        </div>
      </CardContent>
      <div
        className={cn("absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r", accentGradient)}
      />
    </Card>
  )
}
