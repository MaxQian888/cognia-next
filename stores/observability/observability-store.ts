"use client"

/**
 * Persisted UI state for the `/logs` Traces channel (both sub-views): panel
 * grid layout, time-range selection, auto-refresh cadence, the variable
 * filters, and the Explore timeline's scale / grouping / zoom.
 *
 * Kept as its own store (rather than bloating `stores/ui/ui-store.ts`) to
 * match the repo's per-domain store convention (`stores/terminal`,
 * `stores/workflow`, …) and to keep the heavily-shared UI store lean.
 *
 * `editMode` is intentionally transient (not persisted) — the grid always
 * reopens locked so a stray drag from a previous session can't shuffle panels
 * on load.
 *
 * The timeline's scale, grouping and collapse are persisted preferences; its
 * zoom window is transient (a zoom belongs to one trace and one sitting) but
 * still lives HERE rather than in `TraceWorkspace` state, because the channel
 * unmounts whenever the user steps over to the Logs channel and back — and a
 * jump to "show this trace in logs" followed by a return used to throw the
 * zoom, the scale and the grouping away every time.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import type { RangePreset } from "@/lib/observability/time-range"
import type { TraceFilters } from "@/lib/observability/filters"
import type { ThresholdMetric, ThresholdOverrides } from "@/lib/observability/thresholds"
import type { DashboardConfig } from "@/lib/observability/dashboard-config"
import type {
  TimelineGrouping,
  TimelineScale,
  TimelineWindow,
} from "@/lib/observability/trace-timeline"
import {
  TRACE_CONTROL_PARAMS,
  TRACE_EXPLORE_PARAMS,
  consumedLegacyKeys,
} from "@/lib/observability/url-state"

export type Breakpoint = "lg" | "md" | "sm"

/** Minimal grid item shape — structurally compatible with react-grid-layout's
 * `Layout` so it round-trips through `onLayoutChange` without coupling the
 * store to the library. */
export interface PanelLayoutItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}

export type PanelLayouts = Record<Breakpoint, PanelLayoutItem[]>

/** Allowed auto-refresh cadences in ms (0 = off). */
export const REFRESH_OPTIONS = [0, 5_000, 10_000, 30_000, 60_000] as const
export type RefreshMs = (typeof REFRESH_OPTIONS)[number]

/** A timeline zoom, pinned to the trace it was drawn on. */
export interface TimelineZoom {
  traceId: string
  window: TimelineWindow
}

interface ObservabilityState {
  /** null → fall back to the registry default layout. */
  layouts: PanelLayouts | null
  rangePreset: RangePreset | "custom"
  customSince: number | null
  customUntil: number | null
  refreshMs: RefreshMs
  filters: TraceFilters
  editMode: boolean
  /** User overrides for the shipped threshold defaults. */
  thresholds: ThresholdOverrides
  /** Panel ids the user has hidden from the grid. */
  hiddenPanels: string[]
  /** Explore timeline: Duration vs Sequence. */
  timelineScale: TimelineScale
  /** Explore timeline: what a lane collects. */
  timelineGrouping: TimelineGrouping
  /** Explore timeline folded down to its toolbar, giving the waterfall the pane. */
  timelineCollapsed: boolean
  /** Explore timeline zoom. Transient — see the file header. */
  timelineZoom: TimelineZoom | null
  /**
   * Explore's trace-list search and the span open in its detail pane.
   * Transient like the zoom, and here for the same reason; they also ride the
   * URL (`tq` / `tspan`), and the URL sync writes them into THIS store rather
   * than component state so a hydrate is a plain store write, not a
   * set-state-in-effect.
   */
  exploreQuery: string
  exploreSpanId: string | null

  setLayouts: (layouts: PanelLayouts) => void
  resetLayouts: () => void
  setRangePreset: (preset: RangePreset) => void
  setCustomRange: (since: number, until: number) => void
  setRefreshMs: (ms: RefreshMs) => void
  setFilters: (filters: TraceFilters) => void
  setEditMode: (editMode: boolean) => void
  setThreshold: (metric: ThresholdMetric, value: { warn: number; crit: number }) => void
  resetThresholds: () => void
  setHiddenPanels: (ids: string[]) => void
  togglePanelVisibility: (id: string) => void
  setTimelineScale: (scale: TimelineScale) => void
  setTimelineGrouping: (grouping: TimelineGrouping) => void
  setTimelineCollapsed: (collapsed: boolean) => void
  /** `window === null` clears the zoom. */
  setTimelineZoom: (traceId: string, window: TimelineWindow | null) => void
  setExploreQuery: (query: string) => void
  setExploreSpanId: (spanId: string | null) => void
  /** Apply an imported/portable config, replacing the persisted view state. */
  importConfig: (cfg: DashboardConfig) => void
  /**
   * Restore every field to its shipped default.
   *
   * The `/logs` workspace's "Reset" action used to cover the whole Traces
   * channel because its one control (the coarse window) lived in the log
   * workspace store. The channel's range, filters, refresh cadence, thresholds,
   * panel layout and panel visibility live here now, so a reset that skipped
   * this store would leave the user in the view they were trying to escape.
   */
  resetView: () => void
}

/** Shipped defaults — the store body and {@link ObservabilityState.resetView}
 * read the same object so they cannot drift. */
const DEFAULTS = {
  layouts: null,
  rangePreset: "1h",
  customSince: null,
  customUntil: null,
  refreshMs: 10_000,
  filters: {},
  editMode: false,
  thresholds: {},
  hiddenPanels: [],
  timelineScale: "duration",
  timelineGrouping: "operation",
  timelineCollapsed: false,
  timelineZoom: null,
  exploreQuery: "",
  exploreSpanId: null,
} satisfies Pick<
  ObservabilityState,
  | "layouts"
  | "rangePreset"
  | "customSince"
  | "customUntil"
  | "refreshMs"
  | "filters"
  | "editMode"
  | "thresholds"
  | "hiddenPanels"
  | "timelineScale"
  | "timelineGrouping"
  | "timelineCollapsed"
  | "timelineZoom"
  | "exploreQuery"
  | "exploreSpanId"
>

/**
 * Query params the Traces channel's deep-link syncs own: the view controls
 * (`hooks/observability/use-observability-url-sync.ts`, which re-exports this)
 * and the Explore state (`hooks/observability/use-trace-explore-url-sync.ts`).
 * The key names themselves live in `lib/observability/url-state.ts`.
 *
 * Collected HERE rather than beside the hooks so
 * {@link ObservabilityState.resetView} can clear them without importing a React
 * module — and without the import cycle that would create, since the hooks
 * already import this store. The sub-view key (`tview`) is deliberately absent:
 * the `/logs` shell owns it, and its own reset clears it.
 */
export const OBSERVABILITY_URL_PARAMS = [...TRACE_CONTROL_PARAMS, ...TRACE_EXPLORE_PARAMS] as const

/**
 * Drop the owned params (and any pre-rename legacy params a `channel=traces`
 * link still carries) from the address bar without navigating.
 *
 * A reset that only touched the store would be undone the moment the channel
 * remounts: the syncs hydrate from the URL on mount and take priority over
 * persisted state, so the range and filters the user just cleared would come
 * straight back out of the query string.
 */
function clearObservabilityUrlParams(): void {
  if (typeof window === "undefined") return
  const params = new URLSearchParams(window.location.search)
  for (const key of consumedLegacyKeys(params)) params.delete(key)
  for (const key of OBSERVABILITY_URL_PARAMS) params.delete(key)
  const qs = params.toString()
  window.history.replaceState(
    window.history.state,
    "",
    qs ? `${window.location.pathname}?${qs}` : window.location.pathname
  )
}

/**
 * v0 → v1: drop a panel layout written before the registry changed shape.
 *
 * When the dashboard folded into `/logs` → Traces the registry gained five
 * panels (`kpi-rate`, `kpi-tools`, `kpi-tool-failures`, `bd-operation`,
 * `bd-tool`) and lost one (`traces`). `PanelGrid` renders one child per
 * registry entry, and react-grid-layout invents a `{w:1,h:1}` item at the
 * bottom of the grid for any child the saved layout has no entry for — so
 * without this every existing install would have opened on five unreadable
 * tiles beneath a curated grid, a break only upgraders ever see.
 *
 * Dropping `layouts` hands them back to `defaultLayouts()` (the call sites read
 * `stored ?? defaultLayouts()`), which is exactly what a fresh install gets. A
 * hand-arranged grid is worth less than a legible one, and the grid is
 * re-arrangeable in place. Everything else the user chose — range, cadence,
 * filters, thresholds — is preserved.
 *
 * Exported for its test, mirroring `migrateLogWorkspace` in
 * `stores/logging/log-workspace-store.ts`.
 */
export function migrateObservabilityView(
  persisted: unknown,
  from: number
): Partial<ObservabilityState> {
  const p = (persisted ?? {}) as Partial<ObservabilityState>
  if (from >= 1) return p
  const { layouts: _layouts, ...kept } = p
  return {
    ...kept,
    layouts: null,
    // The removed panel cannot be hidden any more; leaving its id behind would
    // carry it into every exported `DashboardConfig` forever.
    hiddenPanels: (kept.hiddenPanels ?? []).filter((id) => id !== "traces"),
  }
}

export const useObservabilityStore = create<ObservabilityState>()(
  persist(
    (set) => ({
      ...DEFAULTS,

      setLayouts: (layouts) => set({ layouts }),
      resetLayouts: () => set({ layouts: null }),
      setRangePreset: (preset) => set({ rangePreset: preset }),
      setCustomRange: (since, until) =>
        set({ rangePreset: "custom", customSince: since, customUntil: until }),
      setRefreshMs: (ms) => set({ refreshMs: ms }),
      setFilters: (filters) => set({ filters }),
      setEditMode: (editMode) => set({ editMode }),
      setThreshold: (metric, value) =>
        set((s) => ({ thresholds: { ...s.thresholds, [metric]: value } })),
      resetThresholds: () => set({ thresholds: {} }),
      setHiddenPanels: (ids) => set({ hiddenPanels: ids }),
      togglePanelVisibility: (id) =>
        set((s) => ({
          hiddenPanels: s.hiddenPanels.includes(id)
            ? s.hiddenPanels.filter((p) => p !== id)
            : [...s.hiddenPanels, id],
        })),
      setTimelineScale: (timelineScale) => set({ timelineScale }),
      setTimelineGrouping: (timelineGrouping) => set({ timelineGrouping }),
      setTimelineCollapsed: (timelineCollapsed) => set({ timelineCollapsed }),
      setTimelineZoom: (traceId, window) =>
        set({ timelineZoom: window ? { traceId, window } : null }),
      setExploreQuery: (exploreQuery) => set({ exploreQuery }),
      setExploreSpanId: (exploreSpanId) => set({ exploreSpanId }),
      importConfig: (cfg) =>
        set({
          layouts: cfg.layouts,
          hiddenPanels: cfg.hiddenPanels,
          thresholds: cfg.thresholds,
          rangePreset: cfg.rangePreset,
          refreshMs: cfg.refreshMs,
          filters: cfg.filters,
          customSince: cfg.rangePreset === "custom" ? (cfg.customSince ?? null) : null,
          customUntil: cfg.rangePreset === "custom" ? (cfg.customUntil ?? null) : null,
        }),
      resetView: () => {
        set({ ...DEFAULTS })
        clearObservabilityUrlParams()
      },
    }),
    {
      name: "cognia-observability",
      storage: persistLocalStorage(),
      version: 1,
      migrate: (persisted, from) => migrateObservabilityView(persisted, from) as ObservabilityState,
      // editMode, timelineZoom and the explore query/span stay transient — see
      // the file header and the field docs.
      partialize: (s) => ({
        layouts: s.layouts,
        rangePreset: s.rangePreset,
        customSince: s.customSince,
        customUntil: s.customUntil,
        refreshMs: s.refreshMs,
        filters: s.filters,
        thresholds: s.thresholds,
        hiddenPanels: s.hiddenPanels,
        timelineScale: s.timelineScale,
        timelineGrouping: s.timelineGrouping,
        timelineCollapsed: s.timelineCollapsed,
      }),
    }
  )
)
