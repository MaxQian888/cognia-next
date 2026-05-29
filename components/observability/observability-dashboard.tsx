"use client"

/**
 * Grafana-style Agent observability dashboard. Live wrapper that wires the
 * control/data/series hooks to the toolbar, the draggable panel grid, and the
 * trace-waterfall drawer. Reads persisted spans from Dexie over the selected
 * time window; `useLiveQuery` + the refresh tick keep it current.
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
import {
  useObservabilityStore,
  type PanelLayouts,
} from "@/stores/observability/observability-store"
import { ObservabilityToolbar } from "./observability-toolbar"
import { ObservabilityPanel } from "./observability-panel"
import { PanelGrid } from "./panel-grid"
import { TraceWaterfallDrawer } from "./trace-waterfall-drawer"
import { defaultLayouts } from "./panel-registry"

export function ObservabilityDashboard() {
  const t = useTranslations("observability")
  const controls = useObservabilityControls()
  const tick = useRefreshTick(controls.refreshMs)
  const range = useResolvedRange(tick)
  const { spans, windowSpans } = useObservabilityData(range, controls.filters, tick)
  const series = useObservabilitySeries(spans, range)

  const storedLayouts = useObservabilityStore((s) => s.layouts)
  const layouts = useMemo(() => storedLayouts ?? defaultLayouts(), [storedLayouts])

  const [selectedTrace, setSelectedTrace] = useState<string | null>(null)

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
          onPreset={controls.setRangePreset}
          onCustom={controls.setCustomRange}
          onRefreshMs={controls.setRefreshMs}
          onFilters={controls.setFilters}
          onToggleEdit={() => controls.setEditMode(!controls.editMode)}
          onResetLayout={controls.resetLayouts}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <PanelGrid
          layouts={layouts}
          editMode={controls.editMode}
          onLayoutChange={handleLayoutChange}
          renderPanel={(panel) => (
            <ObservabilityPanel
              panel={panel}
              series={series}
              editMode={controls.editMode}
              onSelectTrace={setSelectedTrace}
            />
          )}
        />
      </div>

      <TraceWaterfallDrawer traceId={selectedTrace} onClose={() => setSelectedTrace(null)} />
    </div>
  )
}
