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
 * What stayed here: the grid itself, debounced layout persistence (a drag must
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

/** Skeleton tiles shaped like the default grid's first screen. */
const SKELETON_TILES = [
  "col-span-3 h-16",
  "col-span-3 h-16",
  "col-span-3 h-16",
  "col-span-3 h-16",
  "col-span-6 h-48",
  "col-span-6 h-48",
  "col-span-12 h-48",
] as const

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
        className={cn("min-h-0 flex-1 overflow-hidden p-2", className)}
        data-testid="observability-dashboard"
        aria-busy="true"
      >
        <p role="status" className="sr-only">
          {t("loading")}
        </p>
        <div className="grid grid-cols-12 gap-3" data-testid="observability-dashboard-skeleton">
          {SKELETON_TILES.map((tile, index) => (
            <Skeleton key={index} className={tile} />
          ))}
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
      className={cn("min-h-0 flex-1 overflow-auto p-2", className)}
      data-testid="observability-dashboard"
    >
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
  )
}
