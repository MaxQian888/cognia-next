"use client"

/**
 * Grafana-style Agent observability dashboard. Live wrapper that wires the
 * control/data/series hooks to the toolbar, the draggable panel grid, and the
 * trace-waterfall drawer. Reads persisted spans from Dexie over the selected
 * time window; `useLiveQuery` + the refresh tick keep it current.
 *
 * Cross-cutting behavior lives here: click-to-filter from breakdown panels,
 * user-tunable thresholds, panel visibility, export/import, a manual refresh +
 * last-updated readout, deep-linkable range/filters (`useObservabilityUrlSync`),
 * keyboard shortcuts, and a full-dashboard empty state.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { GaugeIcon } from "lucide-react"
import {
  useObservabilityControls,
  useResolvedRange,
} from "@/hooks/observability/use-observability-controls"
import { useRefreshTick } from "@/hooks/observability/use-refresh-tick"
import { useObservabilityData } from "@/hooks/observability/use-observability-data"
import { useObservabilitySeries } from "@/hooks/observability/use-observability-series"
import { useObservabilityHotkeys } from "@/hooks/observability/use-observability-hotkeys"
import { useObservabilityUrlSync } from "@/hooks/observability/use-observability-url-sync"
import {
  useObservabilityStore,
  type PanelLayouts,
} from "@/stores/observability/observability-store"
import { ObservabilityToolbar } from "./observability-toolbar"
import { ObservabilityPanel } from "./observability-panel"
import { PanelGrid } from "./panel-grid"
import { TraceWaterfallDrawer } from "./trace-waterfall-drawer"
import { ObservabilityEmptyState } from "./observability-empty-state"
import { ObservabilitySettingsSheet } from "./observability-settings-sheet"
import { defaultLayouts } from "./panel-registry"
import { toggleFilterValue } from "@/lib/observability/filters"
import { mergeThresholds } from "@/lib/observability/thresholds"
import {
  DASHBOARD_CONFIG_VERSION,
  type DashboardConfig,
} from "@/lib/observability/dashboard-config"
import type { Dimension } from "@/lib/observability/breakdown"

/** The preset an empty dashboard widens to. */
const WIDEST_PRESET = "30d" as const

export function ObservabilityDashboard() {
  const t = useTranslations("observability")
  const controls = useObservabilityControls()
  const { tick, lastUpdated, refresh } = useRefreshTick(controls.refreshMs)
  const range = useResolvedRange(tick)
  const { spans, windowSpans, loading } = useObservabilityData(range, controls.filters, tick)
  const series = useObservabilitySeries(spans, range)
  useObservabilityUrlSync()

  const storedLayouts = useObservabilityStore((s) => s.layouts)
  const layouts = useMemo(() => storedLayouts ?? defaultLayouts(), [storedLayouts])
  const thresholds = useMemo(() => mergeThresholds(controls.thresholds), [controls.thresholds])

  const [selectedTrace, setSelectedTrace] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Debounce layout persistence so a drag doesn't write on every frame.
  const setLayouts = controls.setLayouts
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleLayoutChange = useCallback(
    (next: PanelLayouts) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => setLayouts(next), 300)
    },
    [setLayouts]
  )

  // Click-to-filter from breakdown panels: toggle the value in the filters.
  const setFilters = controls.setFilters
  const filters = controls.filters
  const handleFilterValue = useCallback(
    (dim: Dimension, value: string) => setFilters(toggleFilterValue(filters, dim, value)),
    [setFilters, filters]
  )

  // Portable config snapshot for export.
  const buildConfig = useCallback(
    (): DashboardConfig => ({
      version: DASHBOARD_CONFIG_VERSION,
      layouts: storedLayouts,
      hiddenPanels: controls.hiddenPanels,
      thresholds: controls.thresholds,
      rangePreset: controls.rangePreset,
      customSince: controls.customSince,
      customUntil: controls.customUntil,
      refreshMs: controls.refreshMs,
      filters: controls.filters,
    }),
    [
      storedLayouts,
      controls.hiddenPanels,
      controls.thresholds,
      controls.rangePreset,
      controls.customSince,
      controls.customUntil,
      controls.refreshMs,
      controls.filters,
    ]
  )

  // Keyboard shortcuts (e / r / f / s).
  const setEditMode = controls.setEditMode
  const editMode = controls.editMode
  useObservabilityHotkeys({
    onToggleEdit: () => setEditMode(!editMode),
    onRefresh: refresh,
    onOpenSettings: () => setSettingsOpen(true),
    onFocusFilter: () => {
      document.querySelector<HTMLElement>('[data-testid="variable-filter-bar"] button')?.focus()
    },
  })

  const showEmpty = !loading && windowSpans.length === 0

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="observability-dashboard">
      <header className="flex shrink-0 flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <GaugeIcon className="size-5 text-muted-foreground" />
          <div className="min-w-0">
            <h1 className="text-sm font-semibold leading-tight">{t("title")}</h1>
            <p className="truncate text-xs text-muted-foreground">{t("subtitle")}</p>
          </div>
        </div>
        <ObservabilityToolbar
          preset={controls.rangePreset}
          customSince={controls.customSince}
          customUntil={controls.customUntil}
          refreshMs={controls.refreshMs}
          filters={controls.filters}
          editMode={controls.editMode}
          windowSpans={windowSpans}
          lastUpdated={lastUpdated}
          traces={series.traces}
          onPreset={controls.setRangePreset}
          onCustom={controls.setCustomRange}
          onRefreshMs={controls.setRefreshMs}
          onRefresh={refresh}
          onFilters={controls.setFilters}
          onToggleEdit={() => controls.setEditMode(!controls.editMode)}
          onResetLayout={controls.resetLayouts}
          onOpenSettings={() => setSettingsOpen(true)}
          buildConfig={buildConfig}
          onImportConfig={controls.importConfig}
        />
      </header>

      {showEmpty ? (
        <ObservabilityEmptyState
          onWidenRange={
            controls.rangePreset === WIDEST_PRESET
              ? undefined
              : () => controls.setRangePreset(WIDEST_PRESET)
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <PanelGrid
            layouts={layouts}
            editMode={controls.editMode}
            hiddenPanels={controls.hiddenPanels}
            onLayoutChange={handleLayoutChange}
            renderPanel={(panel) => (
              <ObservabilityPanel
                panel={panel}
                series={series}
                editMode={controls.editMode}
                onSelectTrace={setSelectedTrace}
                thresholds={thresholds}
                filters={controls.filters}
                onFilterValue={handleFilterValue}
              />
            )}
          />
        </div>
      )}

      <TraceWaterfallDrawer traceId={selectedTrace} onClose={() => setSelectedTrace(null)} />
      <ObservabilitySettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
