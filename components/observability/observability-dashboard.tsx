"use client"

/**
 * The aggregate (Grafana-style) view of the agent-trace spans — the panel grid
 * that used to be the whole `/observability` route.
 *
 * It is a *controlled pane* now, not a page. `/logs` → Traces owns the time
 * range, the variable filters, the refresh tick and the single Dexie window
 * read; this component receives the derived series and renders the grid. That
 * is what makes the channel's two sub-views agree by construction: the
 * Dashboard's KPI numbers and the Explore list are folds of the same array,
 * over the same window, under the same filters.
 *
 * What stayed here: the KPI strip and the chart grid under it, debounced layout persistence (a drag must
 * not write on every frame), and the whole-window states — first-read
 * skeletons, a failed read with Retry, and the empty window. What moved out:
 * the toolbar, the URL sync, the hotkeys, the settings sheet and the trace
 * list — all of them are channel-level concerns shared with Explore. The way
 * BACK to the list is `onDrill`, which every drillable panel calls.
 *
 * The skeleton only covers the FIRST read (`loading` is true until the live
 * query has answered once). An auto-refresh re-read keeps the previous answer
 * on screen, so a 5s cadence never flashes the grid to grey.
 */

import { useCallback, useRef } from "react"
import { useTranslations } from "next-intl"

import { Skeleton } from "@/components/ui/skeleton"
import { KpiStrip } from "./kpi-strip"
import { ObservabilityPanel } from "./observability-panel"
import { PanelGrid } from "./panel-grid"
import { ObservabilityEmptyState, ObservabilityLoadError } from "./observability-empty-state"
import type { DashboardDrill } from "./panel-registry"
import type { ObservabilitySeries } from "@/hooks/observability/use-observability-series"
import type { Dimension } from "@/lib/observability/breakdown"
import type { TraceFilters } from "@/lib/observability/filters"
import type { ThresholdConfig, ThresholdMetric } from "@/lib/observability/thresholds"
import type { PanelLayouts } from "@/stores/observability/observability-store"
import { cn } from "@/lib/utils"

export interface ObservabilityDashboardProps {
  /** Derived series over the windowed + filtered spans. */
  series: ObservabilitySeries
  layouts: PanelLayouts
  editMode: boolean
  hiddenPanels: string[]
  /** Resolved thresholds (shipped defaults merged with user overrides). */
  thresholds: Record<ThresholdMetric, ThresholdConfig>
  /** Active variable filters — drives the breakdown highlight + toggle. */
  filters: TraceFilters
  onLayoutChange: (layouts: PanelLayouts) => void
  /** Click-to-filter from a breakdown slice/bar. */
  onFilterValue: (dim: Dimension, value: string) => void
  /**
   * The window holds no spans at all — as opposed to the filters hiding
   * everything, which the per-panel "no data" hints already cover.
   */
  empty: boolean
  /** Widen to the longest preset. Absent → the empty state hides the button. */
  onWidenRange?: () => void
  /** The first window read has not answered yet. */
  loading?: boolean
  /** The window read failed; rendered instead of the grid, with `onRetry`. */
  error?: Error | null
  onRetry?: () => void
  /** Dashboard → Explore drill (failing stats, chart points, "Show traces"). */
  onDrill?: (drill: DashboardDrill) => void
  className?: string
}

/**
 * Skeleton shaped like the live first screen at any width: the KPI strip's
 * cells (2 / 4 / 8 per row by the same container queries the strip uses), then
 * chart tiles that pair up only when the pane is wide enough for the grid's
 * two-column `lg` layout. It used to be a fixed 12-column desktop grid, so a
 * phone saw four squeezed tiles per row and then the strip-and-full-width
 * charts it actually loads into.
 */
const SKELETON_KPI_CELLS = 8
const SKELETON_CHARTS = ["@3xl/obs:col-span-1", "@3xl/obs:col-span-1", "@3xl/obs:col-span-2"]

export function ObservabilityDashboard({
  series,
  layouts,
  editMode,
  hiddenPanels,
  thresholds,
  filters,
  onLayoutChange,
  onFilterValue,
  empty,
  onWidenRange,
  loading = false,
  error = null,
  onRetry,
  onDrill,
  className,
}: ObservabilityDashboardProps) {
  const t = useTranslations("observability")
  // Debounce layout persistence so a drag doesn't write on every frame.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleLayoutChange = useCallback(
    (next: PanelLayouts) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => onLayoutChange(next), 300)
    },
    [onLayoutChange]
  )

  if (error && onRetry) {
    return (
      <div
        className={cn("flex min-h-0 flex-1 flex-col", className)}
        data-testid="observability-dashboard"
      >
        <ObservabilityLoadError error={error} onRetry={onRetry} />
      </div>
    )
  }

  if (loading) {
    return (
      <div
        className={cn("@container/obs min-h-0 flex-1 overflow-hidden", className)}
        data-testid="observability-dashboard"
        aria-busy="true"
      >
        <p role="status" className="sr-only">
          {t("loading")}
        </p>
        <div data-testid="observability-dashboard-skeleton">
          <div className="-mt-px -ml-px grid grid-cols-2 border-b @lg/obs:grid-cols-4 @5xl/obs:grid-cols-8">
            {Array.from({ length: SKELETON_KPI_CELLS }, (_, index) => (
              <div key={index} className="space-y-2 border-t border-l px-3 py-2.5">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 p-2 @3xl/obs:grid-cols-2">
            {SKELETON_CHARTS.map((span, index) => (
              <Skeleton key={index} className={cn("h-56", span)} />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (empty) {
    return (
      <div
        className={cn("flex min-h-0 flex-1 flex-col", className)}
        data-testid="observability-dashboard"
      >
        <ObservabilityEmptyState onWidenRange={onWidenRange} />
      </div>
    )
  }

  return (
    <div
      className={cn("min-h-0 flex-1 overflow-auto", className)}
      data-testid="observability-dashboard"
    >
      <KpiStrip
        kpis={series.kpis}
        hiddenPanels={hiddenPanels}
        thresholds={thresholds}
        onDrillErrors={onDrill ? () => onDrill({ kind: "errors" }) : undefined}
      />
      <div className="p-2">
        <PanelGrid
          layouts={layouts}
          editMode={editMode}
          hiddenPanels={hiddenPanels}
          onLayoutChange={handleLayoutChange}
          renderPanel={(panel) => (
            <ObservabilityPanel
              panel={panel}
              series={series}
              editMode={editMode}
              thresholds={thresholds}
              filters={filters}
              onFilterValue={onFilterValue}
              onDrill={onDrill}
            />
          )}
        />
      </div>
    </div>
  )
}
