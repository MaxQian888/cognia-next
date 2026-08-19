"use client"

/**
 * The `/logs` Traces channel — the agent-trace surface that ADR-0074's
 * successor docs kept promising ("the log panel's agent-trace tab") and that
 * nothing ever mounted: `/logs` passed `includeAgentTrace={false}`, so the
 * span merge, the trace view button and the stats bar were all unreachable.
 *
 * Three resizable columns, list → waterfall → span, with a timeline strip
 * over the middle column:
 *
 *   trace list           timeline + waterfall            span detail
 *   ─────────────        ────────────────────            ─────────────
 *   rollupTraces()       buildTraceTimeline()            TraceSpanDetail
 *   useTraceList         buildWaterfall()                (pure)
 *                        useTraceDetail
 *
 * The timeline owns the zoom window; the waterfall below narrows to the same
 * window, so brushing the strip filters the rows rather than just rescaling a
 * picture next to them. Selection is shared in both directions.
 *
 * Everything below the UI already existed. This file is the composition root
 * that finally wires it: `useTraceList` (window read + rollup + paging + the
 * headline summary, all from ONE IndexedDB scan), `useTraceDetail` (one
 * trace's spans → waterfall geometry), the shared `WaterfallRow` from the
 * observability dashboard, and `AgentTraceStatsBarView` fed from the list's
 * own summary — so the headline numbers and the rows below them are literally
 * the same fold and can never disagree.
 *
 * Narrow viewports drop to one column: the list, with the waterfall and span
 * detail in a sheet.
 */

import { useCallback, useDeferredValue, useMemo, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GaugeIcon,
  SearchIcon,
} from "lucide-react"

import { AgentTraceStatsBarView } from "@/components/logging/agent-trace-stats-bar"
import { TraceSpanDetail } from "@/components/logging/trace-span-detail"
import { TraceExportMenu } from "@/components/logging/trace-export-menu"
import { TraceTimeline } from "@/components/logging/trace-timeline"
import { WaterfallRow } from "@/components/observability/waterfall-row"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Toggle } from "@/components/ui/toggle"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { useTraceList } from "@/hooks/logging/use-trace-list"
import { useTraceDetail } from "@/hooks/observability/use-trace-detail"
import { useIsNarrow, useResizableLayout } from "@/hooks/ui"
import { paletteColor } from "@/lib/observability/chart-palette"
import { formatMs, formatTimestamp, formatUsd } from "@/lib/observability/format-utils"
import { flattenWaterfall, type TraceRollupRow } from "@/lib/observability/trace-rollup"
import type {
  TimelineGrouping,
  TimelineScale,
  TimelineWindow,
} from "@/lib/observability/trace-timeline"
import { AGENT_TRACE_WINDOWS, type AgentTraceStatsWindow } from "@/lib/observability/trace-window"
import { cn } from "@/lib/utils"
import type { SpanOperationName } from "@/types/agent-trace/span"

/** Bar color is keyed off operation so the same kind of work reads the same
 * across traces. Mirrors the observability drawer's ordering deliberately. */
const OP_ORDER: readonly SpanOperationName[] = [
  "invoke_agent",
  "execute_tool",
  "chat",
  "invoke_workflow",
  "retrieval",
  "embeddings",
]

export interface TraceWorkspaceProps {
  window: AgentTraceStatsWindow
  onWindowChange: (window: AgentTraceStatsWindow) => void
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
  window,
  onWindowChange,
  errorsOnly,
  onErrorsOnlyChange,
  selectedTraceId,
  onSelectTrace,
  onOpenInLogs,
  onOpenSession,
  className,
}: TraceWorkspaceProps) {
  const t = useTranslations("logging.workspace.traces")
  const narrow = useIsNarrow()
  const layout = useResizableLayout("cognia-logs-trace-layout")

  const [query, setQuery] = useState("")
  // Typing re-runs the rollup filter over the whole window; deferring keeps the
  // input responsive and lets React drop intermediate passes.
  const deferredQuery = useDeferredValue(query)
  const [page, setPage] = useState(0)
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null)
  const [timelineScale, setTimelineScale] = useState<TimelineScale>("duration")
  const [timelineGrouping, setTimelineGrouping] = useState<TimelineGrouping>("operation")
  const [timelineWindow, setTimelineWindow] = useState<TimelineWindow | null>(null)

  // `page` is the raw intent; `safePage` is it clamped to the filtered set, and
  // every control below steps from `safePage` so a narrower filter can never
  // strand the pager past the last page.
  const {
    traces,
    windowTotal,
    matchedTotal,
    pageCount,
    page: safePage,
    loading,
    summary,
    spanCount,
    windowSpanCount,
    truncated,
  } = useTraceList({
    window,
    errorsOnly,
    query: deferredQuery,
    page,
  })

  const { waterfall, loading: traceLoading } = useTraceDetail(selectedTraceId)
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

  const handleWindow = useCallback(
    (next: AgentTraceStatsWindow) => {
      onWindowChange(next)
      setPage(0)
    },
    [onWindowChange]
  )

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
          <Select
            value={window}
            onValueChange={(value) => handleWindow(value as AgentTraceStatsWindow)}
          >
            <SelectTrigger className="h-8 w-[110px] text-xs" aria-label={t("windowLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {AGENT_TRACE_WINDOWS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`windows.${value}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Toggle
            size="sm"
            pressed={errorsOnly}
            onPressedChange={handleErrorsOnly}
            className="h-7 gap-1 px-2 text-xs"
            aria-label={t("errorsOnly")}
            data-testid="trace-errors-only"
          >
            <AlertTriangleIcon className="size-3.5" />
            {t("errorsOnly")}
          </Toggle>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {t("counts", { matched: matchedTotal, total: windowTotal })}
          </span>
        </div>
        {truncated && (
          <p
            className="text-[11px] text-warning"
            role="status"
            data-testid="trace-truncated-notice"
          >
            {t("truncated", { shown: spanCount, total: windowSpanCount })}
          </p>
        )}
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

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)} data-testid="trace-workspace">
      <div className="flex items-start justify-between gap-3 border-b px-3 py-2">
        {/* Fed from `useTraceList`'s fold rather than its own live query — the
            live-query variant would re-scan the identical window on every span
            that lands. */}
        <AgentTraceStatsBarView summary={summary} window={window} className="min-w-0 flex-1" />
        {/* The dashboard is the aggregate view of the same spans — charts,
            percentiles, breakdowns. This channel is the per-trace view. */}
        <Button asChild variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs">
          <Link href="/observability">
            <GaugeIcon className="mr-1 size-3.5" />
            <span className="hidden sm:inline">{t("openDashboard")}</span>
          </Link>
        </Button>
      </div>

      {narrow ? (
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
      ) : (
        <div className="min-h-0 flex-1">
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={layout.defaultLayout}
            onLayoutChanged={layout.onLayoutChanged}
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
      )}
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
