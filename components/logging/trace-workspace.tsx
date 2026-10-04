"use client"

/**
 * The `/logs` Traces channel — the whole agent-trace surface.
 *
 * It started as the per-trace explorer that ADR-0074's successor docs kept
 * promising and that nothing ever mounted (`/logs` passed
 * `includeAgentTrace={false}`, so the span merge, the trace view button and
 * the stats bar were all unreachable). The aggregate half of the same data
 * lived a route away, at `/observability`: a second time-range control, a
 * second filter model, a second Dexie window read and a second trace table
 * with its own waterfall drawer. Two pages, one span table, and no way to
 * carry a filter from one to the other.
 *
 * There is one surface now, with two sub-views over one read:
 *
 *   toolbar          range · variable filters · auto-refresh · export · settings
 *   ───────────────  ────────────────────────────────────────────────────────────
 *   explore          trace list → timeline + waterfall → span detail
 *   dashboard        the Grafana-style panel grid (KPIs, series, breakdowns)
 *
 * Everything above the switch is shared, and shared literally: `useObservabilityData`
 * performs the single windowed + filtered read, `useObservabilitySeries` folds
 * it into the panels' series and `useTraceList` folds the same array into the
 * list's rows. Narrowing to one model or widening the range moves both views,
 * and their numbers cannot disagree because there is only one fold behind them.
 * The Dashboard drills back into Explore (`DashboardDrill`): a failing-count
 * stat turns on errors-only, a chart point pins the range to its bucket, and a
 * breakdown row's "Show traces" narrows to its value.
 *
 * The timeline owns the zoom window; the waterfall below narrows to the same
 * window, so brushing the strip filters the rows rather than just rescaling a
 * picture next to them. Selection is shared in both directions.
 *
 * **Where state lives.** The channel unmounts whenever the user steps over to
 * the Logs channel, so anything that should survive "show this trace in logs"
 * and back lives in the observability store, not here: the search, the span
 * open in the detail pane, the timeline's scale / grouping / collapse and its
 * zoom (pinned to the trace it was drawn on). The search, span and errors-only
 * also ride the URL (`tq` / `tspan` / `terr`, `useTraceExploreUrlSync`); the
 * range and filters ride it as `trange` / `tfrom` / `tto` / `tf`
 * (`useObservabilityUrlSync`). The `/logs` shell owns the selected `traceId`,
 * the sub-view (`tview`) and errors-only; this component reports changes to
 * them through its props and never writes those params itself — except
 * `terr`, which the Explore URL sync mirrors from the `errorsOnly` prop.
 *
 * **The list holds still.** Auto-refresh used to push every row down a slot
 * per new trace, under the user's cursor. While the user is past page 1 or has
 * a trace selected, the list is frozen at the newest span start it has seen
 * (`freezeAfter`) and newer traces are only counted — "N new · show" brings
 * them in. A selection is revealed by jumping to its page (`page: null`), and
 * one that is not in the list at all (outside the range, filtered out) says so
 * instead of quietly highlighting nothing; an id with no spans at all reads
 * "Trace not found" with a way to clear it.
 *
 * **Keyboard.** The list is one roving tab stop (↑/↓ or j/k, Home/End); Esc
 * (or the pane's close button) clears the selection; `v` flips the sub-view
 * (`useObservabilityHotkeys`, rebindable in Settings → Shortcuts).
 *
 * Layout is driven by the channel's OWN measured width (`useElementWidth`), not
 * by viewport media queries: the shell rail, the channel list and the settings
 * drawer between them take several hundred px the viewport knows nothing about,
 * so a `md:` breakpoint would have rendered three 150px columns in a 500px pane
 * and called it "wide". Three tiers, all container-relative, plus "not yet
 * measured" — which renders nothing for one layout pass rather than mounting
 * (and persisting the sizes of) a three-column group that is about to vanish:
 *
 *   < 768px    list, with the waterfall + span detail in a bottom sheet
 *              (resizable between the two)
 *   < 1180px   two columns: list │ waterfall over span detail
 *   ≥ 1180px   three columns: list │ waterfall │ span detail
 *
 * The toolbar collapses on the same measurement (see `ObservabilityToolbar`);
 * labels INSIDE the panes fold by CSS container queries (`@container`), for
 * the same reason.
 */

import { useCallback, useDeferredValue, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LayoutDashboardIcon,
  ListTreeIcon,
  SearchIcon,
  SearchXIcon,
  XIcon,
} from "lucide-react"

import { TraceSpanDetail } from "@/components/logging/trace-span-detail"
import { TraceExportMenu } from "@/components/logging/trace-export-menu"
import { TraceTimeline } from "@/components/logging/trace-timeline"
import { ObservabilityDashboard } from "@/components/observability/observability-dashboard"
import { ObservabilityLoadError } from "@/components/observability/observability-empty-state"
import { ObservabilitySettingsSheet } from "@/components/observability/observability-settings-sheet"
import { ObservabilityToolbar } from "@/components/observability/observability-toolbar"
import {
  defaultLayouts,
  panelById,
  type DashboardDrill,
} from "@/components/observability/panel-registry"
import { WaterfallList } from "@/components/observability/waterfall-row"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Toggle } from "@/components/ui/toggle"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { useTraceList } from "@/hooks/logging/use-trace-list"
import {
  useObservabilityControls,
  useResolvedRange,
} from "@/hooks/observability/use-observability-controls"
import { useObservabilityData } from "@/hooks/observability/use-observability-data"
import { useObservabilityFormatters } from "@/hooks/observability/use-observability-formatters"
import { useObservabilityHotkeys } from "@/hooks/observability/use-observability-hotkeys"
import { useObservabilitySeries } from "@/hooks/observability/use-observability-series"
import { useObservabilityUrlSync } from "@/hooks/observability/use-observability-url-sync"
import { useRefreshTick } from "@/hooks/observability/use-refresh-tick"
import { useSpanLabels } from "@/hooks/observability/use-span-labels"
import { useTraceDetail } from "@/hooks/observability/use-trace-detail"
import { useTraceExploreUrlSync } from "@/hooks/observability/use-trace-explore-url-sync"
import { useElementWidth } from "@/hooks/use-element-width"
import { useResizableLayout } from "@/hooks/ui"
import type { Dimension } from "@/lib/observability/breakdown"
import { paletteColor } from "@/lib/observability/chart-palette"
import {
  DASHBOARD_CONFIG_VERSION,
  normalizePanelLayouts,
  type DashboardConfig,
} from "@/lib/observability/dashboard-config"
import {
  ensureFilterValue,
  toggleFilterValue,
  type TraceFilters,
} from "@/lib/observability/filters"
import { mergeThresholds } from "@/lib/observability/thresholds"
import {
  flattenWaterfall,
  type TraceRollupRow,
  type WaterfallNode,
} from "@/lib/observability/trace-rollup"
import type { TimelineWindow } from "@/lib/observability/trace-timeline"
import { cn } from "@/lib/utils"
import { useObservabilityStore } from "@/stores/observability/observability-store"
import { TRACE_SUB_VIEWS, type TraceSubView } from "@/stores/logging/log-workspace-store"
import type { AgentTraceSpan, SpanOperationName } from "@/types/agent-trace/span"

/** Bar color is keyed off operation so the same kind of work reads the same
 * across traces. Mirrors the timeline's lane ordering deliberately. */
const OP_ORDER: readonly SpanOperationName[] = [
  "invoke_agent",
  "execute_tool",
  "chat",
  "invoke_workflow",
  "retrieval",
  "embeddings",
]

const SUB_VIEW_ICONS: Record<TraceSubView, typeof ListTreeIcon> = {
  explore: ListTreeIcon,
  dashboard: LayoutDashboardIcon,
}

/** The preset an empty window widens to, in either sub-view. */
const WIDEST_PRESET = "30d" as const

/**
 * Container-width thresholds (px). Measured on the channel itself — see the
 * file header for why the viewport is the wrong ruler here.
 */
const STACKED_BELOW = 768
const TWO_COLUMN_BELOW = 1180
/**
 * Below this the expanded toolbar needs a second line (measured: 32px tall at
 * ≥1120, 68px below). This is the width of the toolbar's OWN slot, not the
 * channel's — the sub-view tabs sit beside it and eat ~200px, so deriving it
 * from the channel width would be off by exactly that and by however wide the
 * active locale renders "Explore"/"Dashboard".
 */
const COMPACT_TOOLBAR_BELOW = 1120
/** Phone step: below this the compact toolbar still needs three rows, and the
 * cadence select is the one control with an identical second home. */
const DENSE_TOOLBAR_BELOW = 420
const SUB_VIEW_LABELS_FROM = 560

export type TraceLayoutTier = "pending" | "stacked" | "split" | "columns"

/** Pure width → layout tier. `0` means "not measured yet" → `pending`, which
 * renders no pane group at all (see the file header). */
export function traceLayoutTier(width: number): TraceLayoutTier {
  if (width <= 0) return "pending"
  if (width < STACKED_BELOW) return "stacked"
  if (width < TWO_COLUMN_BELOW) return "split"
  return "columns"
}

/** Newest span start in the window — the cutoff a freeze pins (see header). */
function latestStartOf(spans: AgentTraceSpan[]): number | null {
  let latest: number | null = null
  for (const span of spans) {
    if (latest === null || span.startTime > latest) latest = span.startTime
  }
  return latest
}

/** True when a key event came from something that types. */
function fromEditable(event: KeyboardEvent<HTMLElement>): boolean {
  const target = event.target as HTMLElement
  return Boolean(
    target.closest("input, textarea, select, [role='combobox'], [contenteditable='true']")
  )
}

export interface TraceWorkspaceProps {
  /** Explore (per-trace) vs Dashboard (aggregate). Owned by the shell (`tview`). */
  subView: TraceSubView
  onSubViewChange: (subView: TraceSubView) => void
  /** Owned by the shell; mirrored to `terr` by the Explore URL sync here. */
  errorsOnly: boolean
  onErrorsOnlyChange: (errorsOnly: boolean) => void
  /** Deep-linked / restored selection. Owned by the shell (`traceId`). */
  selectedTraceId: string | null
  onSelectTrace: (traceId: string | null) => void
  /** Switches to the Logs channel focused on one trace. */
  onOpenInLogs?: (traceId: string) => void
  /** Switches to the Logs channel focused on one session. */
  onOpenSession?: (sessionId: string) => void
  className?: string
}

export function TraceWorkspace({
  subView,
  onSubViewChange,
  errorsOnly,
  onErrorsOnlyChange,
  selectedTraceId,
  onSelectTrace,
  onOpenInLogs,
  onOpenSession,
  className,
}: TraceWorkspaceProps) {
  const t = useTranslations("logging.workspace.traces")
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarSlotRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(rootRef)
  // The slot is `flex-1` inside a non-wrapping row, so its width is
  // "row minus tabs" whichever mode the toolbar is in — measuring it cannot
  // feed back into the decision it drives.
  const toolbarWidth = useElementWidth(toolbarSlotRef)
  const tier = traceLayoutTier(width)
  const compactToolbar = toolbarWidth > 0 && toolbarWidth < COMPACT_TOOLBAR_BELOW
  const denseToolbar = toolbarWidth > 0 && toolbarWidth < DENSE_TOOLBAR_BELOW
  const showSubViewLabels = width === 0 || width >= SUB_VIEW_LABELS_FROM
  // Distinct storage keys: the groups do not share a panel-id set, and
  // `useResizableLayout` persists a flat `{ id: size }` map keyed by panel id.
  const columnsLayout = useResizableLayout("cognia-logs-trace-layout")
  const splitLayout = useResizableLayout("cognia-logs-trace-layout-split")
  const splitDetailLayout = useResizableLayout("cognia-logs-trace-layout-split-detail")
  const sheetLayout = useResizableLayout("cognia-logs-trace-layout-sheet")

  // ── Explore state that outlives the channel (see the file header) ─────────
  const query = useObservabilityStore((s) => s.exploreQuery)
  const setQuery = useObservabilityStore((s) => s.setExploreQuery)
  const selectedSpanId = useObservabilityStore((s) => s.exploreSpanId)
  const setSelectedSpanId = useObservabilityStore((s) => s.setExploreSpanId)
  const timelineScale = useObservabilityStore((s) => s.timelineScale)
  const setTimelineScale = useObservabilityStore((s) => s.setTimelineScale)
  const timelineGrouping = useObservabilityStore((s) => s.timelineGrouping)
  const setTimelineGrouping = useObservabilityStore((s) => s.setTimelineGrouping)
  const timelineCollapsed = useObservabilityStore((s) => s.timelineCollapsed)
  const setTimelineCollapsed = useObservabilityStore((s) => s.setTimelineCollapsed)
  const timelineZoom = useObservabilityStore((s) => s.timelineZoom)
  const setTimelineZoom = useObservabilityStore((s) => s.setTimelineZoom)

  // Typing re-runs the rollup filter over the whole window; deferring keeps the
  // input responsive and lets React drop intermediate passes.
  const deferredQuery = useDeferredValue(query)
  /** `null` = "the page holding the selection, else the first". */
  const [page, setPage] = useState<number | null>(null)
  const [freezeCutoff, setFreezeCutoff] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The stacked sheet opens for a trace the user (or a deep link) explicitly
  // chose — not merely because a selection survived a trip to the Dashboard.
  const [sheetTraceId, setSheetTraceId] = useState<string | null>(selectedTraceId)
  const [lastSubView, setLastSubView] = useState(subView)
  if (lastSubView !== subView) {
    // Render-phase adjustment (React's "storing information from previous
    // renders" pattern), not an effect: switching sub-view dismisses the sheet.
    setLastSubView(subView)
    setSheetTraceId(null)
  }

  // ── The one read both sub-views are folds of ──────────────────────────────
  const controls = useObservabilityControls()
  const { tick, lastUpdated, refresh } = useRefreshTick(controls.refreshMs)
  const range = useResolvedRange(tick)
  const {
    spans,
    windowSpans,
    loading,
    spanCount,
    windowSpanCount,
    truncated,
    error: readError,
    retry: retryRead,
  } = useObservabilityData(range, controls.filters, tick)
  const series = useObservabilitySeries(spans, range)
  useObservabilityUrlSync()

  const handleErrorsOnly = useCallback(
    (next: boolean) => {
      onErrorsOnlyChange(next)
      setPage(null)
    },
    [onErrorsOnlyChange]
  )
  // `terr` / `tq` / `tspan` ⇄ URL. Errors-only goes up through the SAME
  // wrapper a click on the toggle does, so a link's `terr` also resets paging.
  useTraceExploreUrlSync({ errorsOnly, onErrorsOnlyChange: handleErrorsOnly })

  const storedLayouts = useObservabilityStore((s) => s.layouts)
  const layouts = useMemo(() => storedLayouts ?? defaultLayouts(), [storedLayouts])
  const thresholds = useMemo(() => mergeThresholds(controls.thresholds), [controls.thresholds])

  // ── Freeze (see the file header) ──────────────────────────────────────────
  const latestStart = useMemo(() => latestStartOf(spans), [spans])
  const wantFreeze = selectedTraceId !== null || (page !== null && page > 0)
  if (wantFreeze && freezeCutoff === null && latestStart !== null) {
    setFreezeCutoff(latestStart)
  } else if (!wantFreeze && freezeCutoff !== null) {
    setFreezeCutoff(null)
  }

  const {
    traces,
    matched,
    all,
    windowTotal,
    matchedTotal,
    pageCount,
    page: safePage,
    pendingCount,
    selectedIndex,
  } = useTraceList({
    spans,
    loading,
    errorsOnly,
    query: deferredQuery,
    page,
    selectedTraceId,
    freezeAfter: wantFreeze ? freezeCutoff : null,
  })

  // Only Explore renders a waterfall; loading one trace's spans while the
  // dashboard is on screen would be a read nothing displays.
  const detail = useTraceDetail(subView === "explore" ? selectedTraceId : null)
  const { waterfall } = detail
  const allRows = useMemo(() => flattenWaterfall(waterfall), [waterfall])
  const colors = useThemeColors()

  // The timeline reads the raw spans, not the waterfall tree, so its lanes can
  // regroup independently of parentage.
  const traceSpans = useMemo(() => allRows.map((node) => node.span), [allRows])

  // A zoom belongs to the trace it was drawn on.
  const timelineWindow =
    timelineZoom && timelineZoom.traceId === selectedTraceId ? timelineZoom.window : null
  const handleWindowChange = useCallback(
    (next: TimelineWindow | null) => {
      if (selectedTraceId) setTimelineZoom(selectedTraceId, next)
    },
    [selectedTraceId, setTimelineZoom]
  )

  // Brushing the timeline filters the waterfall to the same window; a span that
  // overlaps the window at all survives, matching the timeline's own rule.
  const rows = useMemo(() => {
    if (!timelineWindow) return allRows
    const { since, until } = timelineWindow
    return allRows.filter((node) => {
      const start = node.span.startTime
      const end = node.span.endTime ?? start + (node.span.durationMs ?? 0)
      return end >= since && start <= until
    })
  }, [allRows, timelineWindow])

  // Default to the root span so the detail pane is never blank on open, and
  // drop a selection that belongs to a trace we just navigated away from.
  const selectedSpan = useMemo(() => {
    if (allRows.length === 0) return null
    const explicit = allRows.find((row) => row.span.spanId === selectedSpanId)?.span
    if (explicit) return explicit
    // Fall back to the first row still in view, then to the trace root — a
    // zoom that hides the previous selection should not blank the pane.
    return rows[0]?.span ?? allRows[0].span
  }, [allRows, rows, selectedSpanId])

  const handleSelectTrace = useCallback(
    (traceId: string) => {
      setSelectedSpanId(null)
      setTimelineZoom(traceId, null)
      setSheetTraceId(traceId)
      onSelectTrace(traceId)
    },
    [onSelectTrace, setSelectedSpanId, setTimelineZoom]
  )

  const clearSelection = useCallback(() => {
    setSelectedSpanId(null)
    setSheetTraceId(null)
    onSelectTrace(null)
  }, [onSelectTrace, setSelectedSpanId])

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value)
      setPage(null)
    },
    [setQuery]
  )

  // Click-to-filter from a breakdown panel narrows the trace list too — same
  // filters, same spans.
  const setFilters = controls.setFilters
  const filters = controls.filters
  const handleFilterValue = useCallback(
    (dim: Dimension, value: string) => {
      setFilters(toggleFilterValue(filters, dim, value))
      setPage(null)
    },
    [setFilters, filters]
  )

  const handleFilters = useCallback(
    (next: TraceFilters) => {
      setFilters(next)
      setPage(null)
    },
    [setFilters]
  )

  // Dashboard → Explore. Each drill narrows the SHARED controls, so the list
  // that opens is exactly the set the panel summarised.
  const setCustomRange = controls.setCustomRange
  const handleDrill = useCallback(
    (drill: DashboardDrill) => {
      if (drill.kind === "errors") handleErrorsOnly(true)
      else if (drill.kind === "window") setCustomRange(drill.since, drill.until)
      else setFilters(ensureFilterValue(filters, drill.dimension, drill.value))
      setPage(null)
      onSubViewChange("explore")
    },
    [handleErrorsOnly, setCustomRange, setFilters, filters, onSubViewChange]
  )

  const showPending = useCallback(() => {
    // Re-pin at "now": the held-back traces are listed, and if the freeze
    // still applies (a selection) it holds from here on.
    setFreezeCutoff(latestStart)
    setPage(null)
  }, [latestStart])

  const setRangePreset = controls.setRangePreset
  const widenRange =
    controls.rangePreset === WIDEST_PRESET ? undefined : () => setRangePreset(WIDEST_PRESET)

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

  // An imported file is only structurally valid: complete its layout against
  // the registry (missing panels, undersized tiles) and drop panel ids this
  // build does not have, exactly as the grid does for a stored layout.
  const importConfig = controls.importConfig
  const handleImportConfig = useCallback(
    (cfg: DashboardConfig) =>
      importConfig({
        ...cfg,
        layouts: cfg.layouts ? normalizePanelLayouts(cfg.layouts, defaultLayouts()) : null,
        hiddenPanels: cfg.hiddenPanels.filter((id) => panelById(id) !== undefined),
      }),
    [importConfig]
  )

  // Keyboard shortcuts (e / r / f / s / v). `e` only means anything on the grid.
  const setEditMode = controls.setEditMode
  const editMode = controls.editMode
  useObservabilityHotkeys({
    onToggleEdit: subView === "dashboard" ? () => setEditMode(!editMode) : undefined,
    onRefresh: refresh,
    onOpenSettings: () => setSettingsOpen(true),
    onFocusFilter: () => {
      document.querySelector<HTMLElement>('[data-testid="variable-filter-bar"] button')?.focus()
    },
    onToggleSubView: () => onSubViewChange(subView === "explore" ? "dashboard" : "explore"),
  })

  const handleExploreKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || selectedTraceId === null) return
    if (event.defaultPrevented || fromEditable(event)) return
    event.preventDefault()
    clearSelection()
  }

  const colorFor = useCallback(
    (node: WaterfallNode) => {
      if (node.isError) return colors.destructive
      const index = OP_ORDER.indexOf(node.span.operationName)
      return paletteColor(colors, index < 0 ? 0 : index)
    },
    [colors]
  )

  const renderWaterfall = () => (
    <div className="@container flex h-full min-h-0 flex-col" data-testid="trace-waterfall-pane">
      {selectedTraceId === null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
          {t("selectPrompt")}
        </div>
      ) : detail.error ? (
        <ObservabilityLoadError error={detail.error} onRetry={detail.retry} />
      ) : detail.notFound ? (
        <Empty className="border-0 py-10" data-testid="trace-not-found">
          <EmptyHeader>
            <EmptyTitle className="text-sm">{t("notFoundTitle")}</EmptyTitle>
            <EmptyDescription className="text-xs">
              {t("notFoundDescription", { id: selectedTraceId })}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              size="sm"
              onClick={clearSelection}
              data-testid="trace-not-found-clear"
            >
              {t("clearSelection")}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <TraceTimeline
            spans={traceSpans}
            loading={detail.loading}
            scale={timelineScale}
            onScaleChange={setTimelineScale}
            grouping={timelineGrouping}
            onGroupingChange={setTimelineGrouping}
            window={timelineWindow}
            onWindowChange={handleWindowChange}
            selectedSpanId={selectedSpan?.spanId ?? null}
            onSelectSpan={setSelectedSpanId}
            highlightQuery={deferredQuery}
            collapsed={timelineCollapsed}
            onCollapsedChange={setTimelineCollapsed}
            leading={
              <span
                className="max-w-[9rem] truncate font-mono text-xs"
                title={selectedTraceId}
                data-testid="trace-header-id"
              >
                {selectedTraceId.slice(0, 12)}
              </span>
            }
            actions={
              <>
                <TraceExportMenu
                  traceId={selectedTraceId}
                  spans={traceSpans}
                  className="h-6 gap-1 px-1.5 text-[11px]"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={clearSelection}
                  aria-label={t("closeTrace")}
                  title={t("closeTraceHint")}
                  data-testid="trace-close"
                >
                  <XIcon className="size-3.5" aria-hidden />
                </Button>
              </>
            }
          />

          <ScrollArea className="min-h-0 flex-1">
            {detail.loading ? (
              <div className="p-4 text-xs text-muted-foreground" role="status">
                {t("loading")}
              </div>
            ) : rows.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground">
                {timelineWindow ? t("windowEmpty") : t("waterfallEmpty")}
              </div>
            ) : (
              <WaterfallList
                className="px-3 py-2"
                label={t("waterfallLabel")}
                rows={rows}
                totalMs={waterfall.totalMs}
                colorFor={colorFor}
                selectedSpanId={selectedSpan?.spanId ?? null}
                onSelect={setSelectedSpanId}
              />
            )}
          </ScrollArea>
        </>
      )}
    </div>
  )

  const renderSpanDetail = (className?: string) => (
    <TraceSpanDetail
      span={detail.notFound || detail.error ? null : selectedSpan}
      traceStart={waterfall.traceStart}
      onOpenInLogs={onOpenInLogs}
      onOpenSession={onOpenSession}
      className={className}
    />
  )

  const selectionOutsideList =
    selectedTraceId !== null &&
    selectedIndex < 0 &&
    !loading &&
    !detail.notFound &&
    !detail.loading &&
    windowTotal > 0

  const renderList = () => (
    <div className="@container flex h-full min-h-0 flex-col" data-testid="trace-list-pane">
      <div className="flex flex-col gap-2 border-b p-2">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              aria-hidden
              className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchLabel")}
              className="h-8 pl-7 text-xs"
              data-testid="trace-search"
            />
          </div>
          <Toggle
            size="sm"
            pressed={errorsOnly}
            onPressedChange={handleErrorsOnly}
            className="h-8 shrink-0 gap-1 px-2 text-xs"
            aria-label={t("errorsOnly")}
            title={t("errorsOnly")}
            data-testid="trace-errors-only"
          >
            <AlertTriangleIcon className="size-3.5" aria-hidden />
            <span className="hidden @xs:inline">{t("errorsOnly")}</span>
          </Toggle>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {t("counts", { matched: matchedTotal, total: windowTotal })}
          </span>
          {pendingCount > 0 && (
            <Button
              variant="secondary"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={showPending}
              data-testid="trace-pending"
            >
              {t("pending", { count: pendingCount })}
            </Button>
          )}
        </div>
        {selectionOutsideList && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-dashed px-2 py-1.5 text-[11px] text-muted-foreground"
            data-testid="trace-selection-outside"
          >
            <SearchXIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{t("selectionOutside")}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 shrink-0 px-1.5 text-[11px]"
              onClick={clearSelection}
            >
              {t("clearSelection")}
            </Button>
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {readError ? (
          <ObservabilityLoadError error={readError} onRetry={retryRead} />
        ) : loading && traces.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground" role="status">
            {t("loading")}
          </div>
        ) : traces.length === 0 ? (
          <Empty className="border-0 py-10" data-testid="trace-list-empty">
            <EmptyHeader>
              <EmptyTitle className="text-sm">
                {windowTotal === 0 ? t("emptyTitle") : t("noMatchTitle")}
              </EmptyTitle>
              <EmptyDescription className="text-xs">
                {windowTotal === 0 ? t("emptyDescription") : t("noMatchDescription")}
              </EmptyDescription>
            </EmptyHeader>
            {widenRange && (
              <EmptyContent>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={widenRange}
                  data-testid="trace-list-widen"
                >
                  {t("widenRange")}
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <TraceList
            traces={traces}
            selectedTraceId={selectedTraceId}
            onSelect={handleSelectTrace}
            label={t("listLabel")}
          />
        )}
      </ScrollArea>

      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={safePage === 0}
            onClick={() => setPage(Math.max(0, safePage - 1))}
            data-testid="trace-page-prev"
          >
            <ChevronLeftIcon className="size-3.5" aria-hidden />
            {t("previousPage")}
          </Button>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {t("pageOf", { page: safePage + 1, total: pageCount })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(safePage + 1)}
            data-testid="trace-page-next"
          >
            {t("nextPage")}
            <ChevronRightIcon className="size-3.5" aria-hidden />
          </Button>
        </div>
      )}
    </div>
  )

  const renderExplore = () => {
    if (tier === "pending") {
      return <div className="min-h-0 flex-1" data-testid="trace-layout-pending" />
    }

    if (tier === "stacked") {
      const sheetOpen = sheetTraceId !== null && sheetTraceId === selectedTraceId
      return (
        <>
          <div className="min-h-0 flex-1">{renderList()}</div>
          <Sheet
            open={sheetOpen}
            onOpenChange={(open) => {
              if (!open) clearSelection()
            }}
          >
            <SheetContent
              side="bottom"
              className="flex h-dvh max-h-dvh flex-col gap-0 p-0"
              data-testid="trace-detail-sheet"
            >
              <SheetHeader className="sr-only">
                <SheetTitle>{t("detailTitle")}</SheetTitle>
                <SheetDescription>{t("detailDescription")}</SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1" data-testid="trace-sheet-split">
                <ResizablePanelGroup
                  orientation="vertical"
                  defaultLayout={sheetLayout.defaultLayout}
                  onLayoutChanged={sheetLayout.onLayoutChanged}
                >
                  <ResizablePanel id="trace-sheet-waterfall" defaultSize="55%" minSize="20%">
                    <div className="h-full overflow-hidden">{renderWaterfall()}</div>
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel id="trace-sheet-span" defaultSize="45%" minSize="15%">
                    {renderSpanDetail("h-full")}
                  </ResizablePanel>
                </ResizablePanelGroup>
              </div>
            </SheetContent>
          </Sheet>
        </>
      )
    }

    if (tier === "split") {
      // Two columns rather than three: below ~1180px a third column leaves the
      // waterfall too narrow to read a nested span's label, and the span detail
      // is a form of label/value rows that stacks happily under it.
      return (
        <div className="min-h-0 flex-1" data-testid="trace-split-layout">
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={splitLayout.defaultLayout}
            onLayoutChanged={splitLayout.onLayoutChanged}
          >
            <ResizablePanel id="trace-list" defaultSize="38%" minSize="25%" maxSize="55%">
              {renderList()}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel id="trace-detail" defaultSize="62%" minSize="45%">
              <ResizablePanelGroup
                orientation="vertical"
                defaultLayout={splitDetailLayout.defaultLayout}
                onLayoutChanged={splitDetailLayout.onLayoutChanged}
              >
                <ResizablePanel id="trace-waterfall" defaultSize="55%" minSize="25%">
                  {renderWaterfall()}
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel id="trace-span" defaultSize="45%" minSize="20%">
                  {renderSpanDetail("h-full")}
                </ResizablePanel>
              </ResizablePanelGroup>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )
    }

    return (
      <div className="min-h-0 flex-1" data-testid="trace-columns-layout">
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={columnsLayout.defaultLayout}
          onLayoutChanged={columnsLayout.onLayoutChanged}
        >
          <ResizablePanel id="trace-list" defaultSize="30%" minSize="20%" maxSize="45%">
            {renderList()}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="trace-waterfall" defaultSize="40%" minSize="25%">
            {renderWaterfall()}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="trace-span" defaultSize="30%" minSize="20%" maxSize="45%">
            {renderSpanDetail("h-full")}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={cn("flex h-full min-h-0 flex-col", className)}
      data-testid="trace-workspace"
      data-sub-view={subView}
      data-tier={tier}
    >
      <div className="flex items-start gap-2 border-b px-3 py-2">
        <Tabs
          value={subView}
          onValueChange={(value) => onSubViewChange(value as TraceSubView)}
          className="shrink-0"
        >
          <TabsList aria-label={t("subViewLabel")} className="h-8">
            {TRACE_SUB_VIEWS.map((value) => {
              const Icon = SUB_VIEW_ICONS[value]
              const label = t(`subViews.${value}`)
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  aria-label={label}
                  // Icon-only below the label width: the tooltip is the only
                  // visible name a pointer user gets, and it names the hotkey.
                  title={showSubViewLabels ? undefined : t("subViewHint", { view: label })}
                  data-testid={`trace-sub-view-${value}`}
                  className="gap-1.5"
                >
                  <Icon className="size-4" aria-hidden />
                  {showSubViewLabels && <span>{label}</span>}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>

        <div ref={toolbarSlotRef} className="flex min-w-0 flex-1">
          <ObservabilityToolbar
            preset={controls.rangePreset}
            customSince={controls.customSince}
            customUntil={controls.customUntil}
            refreshMs={controls.refreshMs}
            filters={controls.filters}
            editMode={controls.editMode}
            windowSpans={windowSpans}
            lastUpdated={lastUpdated}
            // Explore exports the list it shows; the Dashboard has no search
            // or errors-only control, so it exports every trace it counted.
            traces={subView === "dashboard" ? all : matched}
            onPreset={controls.setRangePreset}
            onCustom={controls.setCustomRange}
            onRefreshMs={controls.setRefreshMs}
            onRefresh={refresh}
            onFilters={handleFilters}
            onToggleEdit={() => controls.setEditMode(!controls.editMode)}
            onResetLayout={controls.resetLayouts}
            onOpenSettings={() => setSettingsOpen(true)}
            buildConfig={buildConfig}
            onImportConfig={handleImportConfig}
            showLayoutControls={subView === "dashboard"}
            compact={compactToolbar}
            dense={denseToolbar}
          />
        </div>
      </div>

      {truncated && (
        <p
          className="border-b px-3 py-1 text-[11px] text-warning"
          role="status"
          data-testid="trace-truncated-notice"
        >
          {t("truncated", { shown: spanCount, total: windowSpanCount })}
        </p>
      )}

      {subView === "dashboard" ? (
        <ObservabilityDashboard
          series={series}
          layouts={layouts}
          editMode={controls.editMode}
          hiddenPanels={controls.hiddenPanels}
          thresholds={thresholds}
          filters={controls.filters}
          onLayoutChange={controls.setLayouts}
          onFilterValue={handleFilterValue}
          empty={!loading && !readError && windowSpans.length === 0}
          onWidenRange={widenRange}
          loading={loading}
          error={readError}
          onRetry={retryRead}
          onDrill={handleDrill}
        />
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col"
          onKeyDown={handleExploreKeyDown}
          data-testid="trace-explore"
        >
          {renderExplore()}
        </div>
      )}

      <ObservabilitySettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}

interface TraceListProps {
  traces: TraceRollupRow[]
  selectedTraceId: string | null
  onSelect: (traceId: string) => void
  label: string
}

/**
 * The page of trace rows under one roving tab stop: the selected row, else the
 * row last moved to, else the first. ↑/↓ and j/k move, Home/End jump, Enter /
 * Space select (native buttons).
 */
function TraceList({ traces, selectedTraceId, onSelect, label }: TraceListProps) {
  const [cursor, setCursor] = useState<number | null>(null)
  const selectedIndex = traces.findIndex((trace) => trace.traceId === selectedTraceId)
  const tabIndex =
    cursor !== null && cursor < traces.length ? cursor : selectedIndex >= 0 ? selectedIndex : 0

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    let next: number | null = null
    if (event.key === "ArrowDown" || event.key === "j")
      next = Math.min(traces.length - 1, index + 1)
    else if (event.key === "ArrowUp" || event.key === "k") next = Math.max(0, index - 1)
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = traces.length - 1
    if (next === null) return
    event.preventDefault()
    setCursor(next)
    event.currentTarget
      .closest("ul")
      ?.querySelector<HTMLButtonElement>(`[data-trace-index="${next}"]`)
      ?.focus()
  }

  return (
    <ul aria-label={label} data-testid="trace-list">
      {traces.map((trace, index) => (
        <TraceRow
          key={trace.traceId}
          trace={trace}
          index={index}
          selected={trace.traceId === selectedTraceId}
          tabbable={index === tabIndex}
          onSelect={onSelect}
          onKeyDown={handleKeyDown}
          onFocusRow={setCursor}
        />
      ))}
    </ul>
  )
}

interface TraceRowProps {
  trace: TraceRollupRow
  index: number
  selected: boolean
  tabbable: boolean
  onSelect: (traceId: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void
  onFocusRow: (index: number) => void
}

function TraceRow({
  trace,
  index,
  selected,
  tabbable,
  onSelect,
  onKeyDown,
  onFocusRow,
}: TraceRowProps) {
  const t = useTranslations("logging.workspace.traces")
  const fmt = useObservabilityFormatters()
  const labels = useSpanLabels()
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(trace.traceId)}
        onKeyDown={(event) => onKeyDown(event, index)}
        onFocus={() => onFocusRow(index)}
        tabIndex={tabbable ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        data-trace-index={index}
        data-testid={`trace-row-${trace.traceId}`}
        className={cn(
          "w-full border-b px-3 py-2 text-left transition-colors hover:bg-accent/40",
          "focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none focus-visible:ring-2",
          selected && "bg-accent/60",
          trace.errorCount > 0 && "border-l-2 border-l-destructive"
        )}
      >
        <div className="flex items-center gap-1.5">
          {trace.errorCount > 0 && (
            <AlertTriangleIcon
              role="img"
              aria-label={t("traceFailed", { count: trace.errorCount })}
              className="size-3 shrink-0 text-destructive"
            />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={trace.rootName}>
            {trace.rootName}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {fmt.duration(trace.durationMs)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="tabular-nums">{fmt.dateTime(trace.startTime)}</span>
          <span className="tabular-nums">{t("spanCount", { count: trace.spanCount })}</span>
          {trace.totalCostUsd > 0 && (
            <span className="tabular-nums">{fmt.usd(trace.totalCostUsd)}</span>
          )}
          <Badge variant="outline" className="h-4 px-1 text-[10px]" title={trace.surface}>
            {labels.surface(trace.surface)}
          </Badge>
        </div>
      </button>
    </li>
  )
}

export default TraceWorkspace
