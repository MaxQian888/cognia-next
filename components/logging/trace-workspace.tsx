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
 *
 * The timeline owns the zoom window; the waterfall below narrows to the same
 * window, so brushing the strip filters the rows rather than just rescaling a
 * picture next to them. Selection is shared in both directions.
 *
 * Layout is driven by the channel's OWN measured width (`useElementWidth`), not
 * by viewport media queries: the shell rail, the channel list and the settings
 * drawer between them take several hundred px the viewport knows nothing about,
 * so a `md:` breakpoint would have rendered three 150px columns in a 500px pane
 * and called it "wide". Three tiers, all container-relative:
 *
 *   < 768px    list, with the waterfall + span detail in a bottom sheet
 *   < 1180px   two columns: list │ waterfall over span detail
 *   ≥ 1180px   three columns: list │ waterfall │ span detail
 *
 * The toolbar collapses on the same measurement (see `ObservabilityToolbar`).
 */

import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LayoutDashboardIcon,
  ListTreeIcon,
  SearchIcon,
} from "lucide-react"

import { TraceSpanDetail } from "@/components/logging/trace-span-detail"
import { TraceExportMenu } from "@/components/logging/trace-export-menu"
import { TraceTimeline } from "@/components/logging/trace-timeline"
import { ObservabilityDashboard } from "@/components/observability/observability-dashboard"
import { ObservabilitySettingsSheet } from "@/components/observability/observability-settings-sheet"
import { ObservabilityToolbar } from "@/components/observability/observability-toolbar"
import { defaultLayouts } from "@/components/observability/panel-registry"
import { WaterfallRow } from "@/components/observability/waterfall-row"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
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
import { useObservabilityHotkeys } from "@/hooks/observability/use-observability-hotkeys"
import { useObservabilitySeries } from "@/hooks/observability/use-observability-series"
import { useObservabilityUrlSync } from "@/hooks/observability/use-observability-url-sync"
import { useRefreshTick } from "@/hooks/observability/use-refresh-tick"
import { useTraceDetail } from "@/hooks/observability/use-trace-detail"
import { useElementWidth } from "@/hooks/use-element-width"
import { useResizableLayout } from "@/hooks/ui"
import type { Dimension } from "@/lib/observability/breakdown"
import { paletteColor } from "@/lib/observability/chart-palette"
import {
  DASHBOARD_CONFIG_VERSION,
  type DashboardConfig,
} from "@/lib/observability/dashboard-config"
import { toggleFilterValue, type TraceFilters } from "@/lib/observability/filters"
import { formatMs, formatTimestamp, formatUsd } from "@/lib/observability/format-utils"
import { mergeThresholds } from "@/lib/observability/thresholds"
import { flattenWaterfall, type TraceRollupRow } from "@/lib/observability/trace-rollup"
import type {
  TimelineGrouping,
  TimelineScale,
  TimelineWindow,
} from "@/lib/observability/trace-timeline"
import { cn } from "@/lib/utils"
import { useObservabilityStore } from "@/stores/observability/observability-store"
import { TRACE_SUB_VIEWS, type TraceSubView } from "@/stores/logging/log-workspace-store"
import type { SpanOperationName } from "@/types/agent-trace/span"

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

/** The preset an empty dashboard widens to. */
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

export type TraceLayoutTier = "stacked" | "split" | "columns"

/** Pure width → layout tier. `0` means "not measured yet"; the widest tier is
 * the static-export default, matching what the server renders. */
export function traceLayoutTier(width: number): TraceLayoutTier {
  if (width <= 0) return "columns"
  if (width < STACKED_BELOW) return "stacked"
  if (width < TWO_COLUMN_BELOW) return "split"
  return "columns"
}

export interface TraceWorkspaceProps {
  /** Explore (per-trace) vs Dashboard (aggregate). */
  subView: TraceSubView
  onSubViewChange: (subView: TraceSubView) => void
  errorsOnly: boolean
  onErrorsOnlyChange: (errorsOnly: boolean) => void
  /** Deep-linked / restored selection. */
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
  // Distinct storage keys: the two groups do not share a panel-id set, and
  // `useResizableLayout` persists a flat `{ id: size }` map keyed by panel id.
  const columnsLayout = useResizableLayout("cognia-logs-trace-layout")
  const splitLayout = useResizableLayout("cognia-logs-trace-layout-split")
  const splitDetailLayout = useResizableLayout("cognia-logs-trace-layout-split-detail")

  const [query, setQuery] = useState("")
  // Typing re-runs the rollup filter over the whole window; deferring keeps the
  // input responsive and lets React drop intermediate passes.
  const deferredQuery = useDeferredValue(query)
  const [page, setPage] = useState(0)
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null)
  const [timelineScale, setTimelineScale] = useState<TimelineScale>("duration")
  const [timelineGrouping, setTimelineGrouping] = useState<TimelineGrouping>("operation")
  const [timelineWindow, setTimelineWindow] = useState<TimelineWindow | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // ── The one read both sub-views are folds of ──────────────────────────────
  const controls = useObservabilityControls()
  const { tick, lastUpdated, refresh } = useRefreshTick(controls.refreshMs)
  const range = useResolvedRange(tick)
  const { spans, windowSpans, loading, spanCount, windowSpanCount, truncated } =
    useObservabilityData(range, controls.filters, tick)
  const series = useObservabilitySeries(spans, range)
  useObservabilityUrlSync()

  const storedLayouts = useObservabilityStore((s) => s.layouts)
  const layouts = useMemo(() => storedLayouts ?? defaultLayouts(), [storedLayouts])
  const thresholds = useMemo(() => mergeThresholds(controls.thresholds), [controls.thresholds])

  // `page` is the raw intent; `safePage` is it clamped to the filtered set, and
  // every control below steps from `safePage` so a narrower filter can never
  // strand the pager past the last page.
  const {
    traces,
    matched,
    windowTotal,
    matchedTotal,
    pageCount,
    page: safePage,
  } = useTraceList({
    spans,
    loading,
    errorsOnly,
    query: deferredQuery,
    page,
  })

  // Only Explore renders a waterfall; loading one trace's spans while the
  // dashboard is on screen would be a read nothing displays.
  const { waterfall, loading: traceLoading } = useTraceDetail(
    subView === "explore" ? selectedTraceId : null
  )
  const allRows = useMemo(() => flattenWaterfall(waterfall), [waterfall])
  const colors = useThemeColors()

  // The timeline reads the raw spans, not the waterfall tree, so its lanes can
  // regroup independently of parentage.
  const traceSpans = useMemo(() => allRows.map((node) => node.span), [allRows])

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
      // A zoom belongs to the trace it was drawn on.
      setTimelineWindow(null)
      onSelectTrace(traceId)
    },
    [onSelectTrace]
  )

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value)
    setPage(0)
  }, [])

  const handleErrorsOnly = useCallback(
    (next: boolean) => {
      onErrorsOnlyChange(next)
      setPage(0)
    },
    [onErrorsOnlyChange]
  )

  // Click-to-filter from a breakdown panel narrows the trace list too — same
  // filters, same spans.
  const setFilters = controls.setFilters
  const filters = controls.filters
  const handleFilterValue = useCallback(
    (dim: Dimension, value: string) => {
      setFilters(toggleFilterValue(filters, dim, value))
      setPage(0)
    },
    [setFilters, filters]
  )

  const handleFilters = useCallback(
    (next: TraceFilters) => {
      setFilters(next)
      setPage(0)
    },
    [setFilters]
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

  // Keyboard shortcuts (e / r / f / s). `e` only means anything on the grid.
  const setEditMode = controls.setEditMode
  const editMode = controls.editMode
  useObservabilityHotkeys({
    onToggleEdit: subView === "dashboard" ? () => setEditMode(!editMode) : undefined,
    onRefresh: refresh,
    onOpenSettings: () => setSettingsOpen(true),
    onFocusFilter: () => {
      document.querySelector<HTMLElement>('[data-testid="variable-filter-bar"] button')?.focus()
    },
  })

  const renderWaterfall = () => (
    <div className="flex h-full min-h-0 flex-col" data-testid="trace-waterfall-pane">
      {selectedTraceId === null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
          {t("selectPrompt")}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-3 py-2 text-xs">
            <span className="truncate font-mono" title={selectedTraceId}>
              {selectedTraceId.slice(0, 12)}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {formatMs(waterfall.totalMs)}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {t("spanCount", { count: rows.length })}
            </span>
            {timelineWindow && (
              <span className="text-primary tabular-nums" data-testid="trace-window-chip">
                {t("windowedTo", { count: rows.length, total: allRows.length })}
              </span>
            )}
            <TraceExportMenu
              traceId={selectedTraceId}
              spans={traceSpans}
              className="ml-auto h-6 gap-1 px-1.5 text-[11px]"
            />
          </div>

          <TraceTimeline
            spans={traceSpans}
            loading={traceLoading}
            scale={timelineScale}
            onScaleChange={setTimelineScale}
            grouping={timelineGrouping}
            onGroupingChange={setTimelineGrouping}
            window={timelineWindow}
            onWindowChange={setTimelineWindow}
            selectedSpanId={selectedSpan?.spanId ?? null}
            onSelectSpan={setSelectedSpanId}
            highlightQuery={deferredQuery}
          />

          <ScrollArea className="min-h-0 flex-1">
            {traceLoading ? (
              <div className="p-4 text-xs text-muted-foreground" role="status">
                {t("loading")}
              </div>
            ) : rows.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground">
                {timelineWindow ? t("windowEmpty") : t("waterfallEmpty")}
              </div>
            ) : (
              <ul className="px-3 py-2">
                {rows.map((node) => {
                  const index = OP_ORDER.indexOf(node.span.operationName)
                  return (
                    <WaterfallRow
                      key={node.span.spanId}
                      node={node}
                      totalMs={waterfall.totalMs}
                      color={
                        node.isError
                          ? colors.destructive
                          : paletteColor(colors, index < 0 ? 0 : index)
                      }
                      selected={selectedSpan?.spanId === node.span.spanId}
                      onSelect={setSelectedSpanId}
                    />
                  )
                })}
              </ul>
            )}
          </ScrollArea>
        </>
      )}
    </div>
  )

  const renderSpanDetail = (className?: string) => (
    <TraceSpanDetail
      span={selectedSpan}
      traceStart={waterfall.traceStart}
      onOpenInLogs={onOpenInLogs}
      onOpenSession={onOpenSession}
      className={className}
    />
  )

  const renderList = () => (
    <div className="flex h-full min-h-0 flex-col" data-testid="trace-list-pane">
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
            data-testid="trace-errors-only"
          >
            <AlertTriangleIcon className="size-3.5" />
            <span className="hidden sm:inline">{t("errorsOnly")}</span>
          </Toggle>
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {t("counts", { matched: matchedTotal, total: windowTotal })}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading && traces.length === 0 ? (
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
          </Empty>
        ) : (
          <ul>
            {traces.map((trace) => (
              <TraceRow
                key={trace.traceId}
                trace={trace}
                selected={trace.traceId === selectedTraceId}
                onSelect={handleSelectTrace}
                spansLabel={t("spanCount", { count: trace.spanCount })}
              />
            ))}
          </ul>
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
            <ChevronLeftIcon className="size-3.5" />
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
            <ChevronRightIcon className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  )

  const renderExplore = () => {
    if (tier === "stacked") {
      return (
        <>
          <div className="min-h-0 flex-1">{renderList()}</div>
          <Sheet
            open={selectedTraceId !== null}
            onOpenChange={(open) => {
              if (!open) onSelectTrace(null)
            }}
          >
            <SheetContent side="bottom" className="flex h-dvh max-h-dvh flex-col gap-0 p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>{t("detailTitle")}</SheetTitle>
                <SheetDescription>{t("detailDescription")}</SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-hidden">{renderWaterfall()}</div>
              <div className="min-h-0 flex-1 overflow-hidden border-t">{renderSpanDetail()}</div>
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
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  aria-label={t(`subViews.${value}`)}
                  data-testid={`trace-sub-view-${value}`}
                  className="gap-1.5"
                >
                  <Icon className="size-4" aria-hidden />
                  {showSubViewLabels && <span>{t(`subViews.${value}`)}</span>}
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
            traces={matched}
            onPreset={controls.setRangePreset}
            onCustom={controls.setCustomRange}
            onRefreshMs={controls.setRefreshMs}
            onRefresh={refresh}
            onFilters={handleFilters}
            onToggleEdit={() => controls.setEditMode(!controls.editMode)}
            onResetLayout={controls.resetLayouts}
            onOpenSettings={() => setSettingsOpen(true)}
            buildConfig={buildConfig}
            onImportConfig={controls.importConfig}
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
          empty={!loading && windowSpans.length === 0}
          onWidenRange={
            controls.rangePreset === WIDEST_PRESET
              ? undefined
              : () => controls.setRangePreset(WIDEST_PRESET)
          }
        />
      ) : (
        renderExplore()
      )}

      <ObservabilitySettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}

interface TraceRowProps {
  trace: TraceRollupRow
  selected: boolean
  onSelect: (traceId: string) => void
  spansLabel: string
}

function TraceRow({ trace, selected, onSelect, spansLabel }: TraceRowProps) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(trace.traceId)}
        aria-current={selected ? "true" : undefined}
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
            <AlertTriangleIcon aria-hidden className="size-3 shrink-0 text-destructive" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={trace.rootName}>
            {trace.rootName}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatMs(trace.durationMs)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="tabular-nums">{formatTimestamp(trace.startTime)}</span>
          <span className="tabular-nums">{spansLabel}</span>
          {trace.totalCostUsd > 0 && (
            <span className="tabular-nums">{formatUsd(trace.totalCostUsd)}</span>
          )}
          <Badge variant="outline" className="h-4 px-1 text-[10px]">
            {trace.surface}
          </Badge>
        </div>
      </button>
    </li>
  )
}

export default TraceWorkspace
