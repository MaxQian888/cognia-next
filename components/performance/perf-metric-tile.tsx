"use client"

/**
 * PerfMetricTile — a clickable left-rail tile (label + live value + mini
 * sparkline) that selects which metric the big PerfGraphCard renders, mirroring
 * the Windows Task Manager Performance tab's left column.
 */

import { cn } from "@/lib/utils"
import { PerfSparkline } from "./perf-sparkline"

export interface PerfMetricTileProps {
  label: string
  /** Pre-formatted current value. */
  value: string
  /** Series values, oldest → newest. */
  points: number[]
  color: string
  active: boolean
  onSelect: () => void
  "data-testid"?: string
}

export function PerfMetricTile({
  label,
  value,
  points,
  color,
  active,
  onSelect,
  "data-testid": testId,
}: PerfMetricTileProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
        active ? "border-primary/40 bg-primary/10" : "border-transparent bg-muted/40 hover:bg-muted"
      )}
    >
      <PerfSparkline points={points} color={color} className="h-8 w-16 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        <div className="font-mono text-sm font-semibold tabular-nums">{value}</div>
      </div>
    </button>
  )
}
