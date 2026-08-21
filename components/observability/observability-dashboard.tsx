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
 * not write on every frame), and the whole-window empty state. What moved out:
 * the toolbar, the URL sync, the hotkeys, the settings sheet and the trace
 * drill-down — all of them are channel-level concerns shared with Explore.
 */

import { useCallback, useRef } from "react"

import { ObservabilityPanel } from "./observability-panel"
import { PanelGrid } from "./panel-grid"
import { ObservabilityEmptyState } from "./observability-empty-state"
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
  className?: string
}

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
  className,
}: ObservabilityDashboardProps) {
  // Debounce layout persistence so a drag doesn't write on every frame.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleLayoutChange = useCallback(
    (next: PanelLayouts) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => onLayoutChange(next), 300)
    },
    [onLayoutChange]
  )

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
          />
        )}
      />
    </div>
  )
}
