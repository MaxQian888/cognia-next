"use client"

/**
 * Maps a panel definition to its concrete panel component, feeding it the
 * right slice of the shared derived series. Kept separate from the dashboard
 * shell so the dispatch is unit-testable in isolation.
 */

import { StatPanel } from "./stat-panel"
import { TimeSeriesPanel } from "./time-series-panel"
import { DonutPanel } from "./donut-panel"
import { BreakdownBarPanel } from "./breakdown-bar-panel"
import { RecentTracesPanel } from "./recent-traces-panel"
import type { PanelDef } from "./panel-registry"
import type { ObservabilitySeries } from "@/hooks/observability/use-observability-series"
import type { BreakdownRow } from "@/lib/observability/breakdown"
import type { Dimension } from "@/lib/observability/breakdown"

function breakdownFor(
  dimension: Dimension | undefined,
  series: ObservabilitySeries
): BreakdownRow[] {
  switch (dimension) {
    case "model":
      return series.breakdownModel
    case "surface":
      return series.breakdownSurface
    case "operation":
      return series.breakdownOperation
    case "tool":
      return series.breakdownTool
    default:
      return series.breakdownModel
  }
}

export interface ObservabilityPanelProps {
  panel: PanelDef
  series: ObservabilitySeries
  editMode: boolean
  onSelectTrace: (traceId: string) => void
}

export function ObservabilityPanel({
  panel,
  series,
  editMode,
  onSelectTrace,
}: ObservabilityPanelProps) {
  switch (panel.kind) {
    case "stat":
      return <StatPanel panel={panel} kpis={series.kpis} editMode={editMode} />
    case "timeseries":
      return <TimeSeriesPanel panel={panel} series={series} editMode={editMode} />
    case "donut":
      return (
        <DonutPanel
          panel={panel}
          rows={breakdownFor(panel.dimension, series)}
          editMode={editMode}
        />
      )
    case "bar":
      return (
        <BreakdownBarPanel
          panel={panel}
          rows={breakdownFor(panel.dimension, series)}
          editMode={editMode}
        />
      )
    case "traces":
      return (
        <RecentTracesPanel
          panel={panel}
          traces={series.traces}
          editMode={editMode}
          onSelectTrace={onSelectTrace}
        />
      )
  }
}
