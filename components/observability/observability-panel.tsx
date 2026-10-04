"use client"

/**
 * Maps a panel definition to its concrete panel component, feeding it the
 * right slice of the shared derived series. Kept separate from the dashboard
 * shell so the dispatch is unit-testable in isolation.
 *
 * `onDrill` is the one Dashboard → Explore seam: each panel kind translates
 * its own gesture (a failing-count stat, a chart point, a breakdown row's
 * "Show traces") into a `DashboardDrill` and the channel applies it.
 */

import { StatPanel } from "./stat-panel"
import { TimeSeriesPanel } from "./time-series-panel"
import { DonutPanel } from "./donut-panel"
import { BreakdownBarPanel } from "./breakdown-bar-panel"
import type { DashboardDrill, PanelDef } from "./panel-registry"
import type { ObservabilitySeries } from "@/hooks/observability/use-observability-series"
import type { BreakdownRow, Dimension } from "@/lib/observability/breakdown"
import type { TraceFilters } from "@/lib/observability/filters"
import type { ThresholdConfig, ThresholdMetric } from "@/lib/observability/thresholds"

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
    case "provider":
      return series.breakdownProvider
    case "project":
      return series.breakdownProject
    default:
      return series.breakdownModel
  }
}

export interface ObservabilityPanelProps {
  panel: PanelDef
  series: ObservabilitySeries
  editMode: boolean
  /** Resolved thresholds (defaults + user overrides). */
  thresholds: Record<ThresholdMetric, ThresholdConfig>
  /** Active variable filters — drives breakdown highlight + toggle. */
  filters: TraceFilters
  /** Toggle a dimension value in the filters (click-to-filter). */
  onFilterValue: (dim: Dimension, value: string) => void
  /** Dashboard → Explore drill. Absent → panels offer no drill. */
  onDrill?: (drill: DashboardDrill) => void
}

export function ObservabilityPanel({
  panel,
  series,
  editMode,
  thresholds,
  filters,
  onFilterValue,
  onDrill,
}: ObservabilityPanelProps) {
  const dimension = panel.dimension
  const showTraces =
    onDrill && dimension
      ? (value: string) => onDrill({ kind: "filter", dimension, value })
      : undefined
  switch (panel.kind) {
    case "stat":
      return (
        <StatPanel
          panel={panel}
          kpis={series.kpis}
          editMode={editMode}
          thresholds={thresholds}
          onDrill={onDrill && panel.drillErrors ? () => onDrill({ kind: "errors" }) : undefined}
        />
      )
    case "timeseries":
      return (
        <TimeSeriesPanel
          panel={panel}
          series={series}
          editMode={editMode}
          thresholds={thresholds}
          onDrillWindow={onDrill ? (window) => onDrill({ kind: "window", ...window }) : undefined}
        />
      )
    case "donut":
      return (
        <DonutPanel
          panel={panel}
          rows={breakdownFor(panel.dimension, series)}
          editMode={editMode}
          onSelectValue={
            panel.dimension ? (value) => onFilterValue(panel.dimension!, value) : undefined
          }
          selectedValues={
            panel.dimension ? (filters[panel.dimension] as string[] | undefined) : undefined
          }
          onShowTraces={showTraces}
        />
      )
    case "bar":
      return (
        <BreakdownBarPanel
          panel={panel}
          rows={breakdownFor(panel.dimension, series)}
          editMode={editMode}
          onSelectValue={
            panel.dimension ? (value) => onFilterValue(panel.dimension!, value) : undefined
          }
          selectedValues={
            panel.dimension ? (filters[panel.dimension] as string[] | undefined) : undefined
          }
          onShowTraces={showTraces}
        />
      )
  }
}
