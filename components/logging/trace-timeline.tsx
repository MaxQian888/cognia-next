"use client"

/**
 * The trace timeline strip — one trace's whole shape in a few rows — and the
 * header of the trace pane it sits at the top of.
 *
 * Sits above the waterfall in the `/logs` Traces channel. The waterfall
 * answers "what called what"; this answers "what was it doing, and when".
 * Lanes come from `buildTraceTimeline`, which is pure and separately tested;
 * everything here is interaction:
 *
 *  - **Scale** — Duration (real elapsed time) or Sequence (one equal slot per
 *    span). Sequence is the mode that survives a trace with one 40s model call
 *    and thirty sub-millisecond tool calls.
 *  - **Grouping** — lanes by operation, surface, model, or agent. Operation and
 *    surface lanes are labelled in the app language; the raw OTel id is the
 *    lane's `title`.
 *  - **Zoom** — drag across the strip OR across the lanes to select a window;
 *    the ruler, the lanes, and (via `onWindowChange`) the waterfall below all
 *    narrow to it. `+` / `-` zoom around the centre and `0` resets while focus
 *    is anywhere in the strip; double-click or the reset chip restores the
 *    full trace.
 *  - **Selection** — clicking a block selects that span, shared with the
 *    waterfall and the detail pane.
 *  - **Search** — `highlightQuery` dims blocks that do not match instead of
 *    removing them, so a filtered trace keeps its shape. The matcher is the
 *    trace LIST's (`lib/observability/trace-search.ts`), so a query that keeps
 *    a trace in the list lights the same trace up here, and vice versa.
 *  - **Collapse** — the strip folds to its toolbar, and the lane area is
 *    height-capped and scrolls, so a trace with a dozen agent lanes can no
 *    longer push the waterfall off the pane.
 *
 * The toolbar is ALSO the trace pane's header. The pane used to stack a
 * header (trace id · duration · "N spans" · windowed chip · export) on top of
 * this toolbar (scale · grouping · "N spans" · duration · …): two rows, the
 * same two numbers twice. `leading` and `actions` slot the trace id and the
 * pane's buttons into the one row, and the span count reads "N of M spans"
 * while zoomed instead of being repeated by a separate chip. The toolbar
 * renders in every state (loading, empty), so the trace's identity, export
 * and close never disappear while its spans load.
 *
 * Blocks are absolutely positioned percentages, so resizing the pane costs a
 * layout, not a re-render.
 */

import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import {
  useObservabilityFormatters,
  type ObservabilityFormatters,
} from "@/hooks/observability/use-observability-formatters"
import { useSpanLabels, type SpanLabels } from "@/hooks/observability/use-span-labels"
import { paletteColor } from "@/lib/observability/chart-palette"
import { matchesTraceQuery, normalizeTraceQuery } from "@/lib/observability/trace-search"
import {
  buildTraceTimeline,
  isZoomed,
  windowFromDrag,
  zoomWindow,
  type TimelineBlock,
  type TimelineGrouping,
  type TimelineLane,
  type TimelineScale,
  type TimelineWindow,
  type TraceTimeline as TraceTimelineModel,
} from "@/lib/observability/trace-timeline"
import { cn } from "@/lib/utils"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

export const TIMELINE_SCALES: readonly TimelineScale[] = ["duration", "sequence"]
export const TIMELINE_GROUPINGS: readonly TimelineGrouping[] = [
  "operation",
  "surface",
  "model",
  "agent",
]

/** Keyboard zoom step: `+` halves the window, `-` doubles it. */
export const ZOOM_STEP = 2

const LANE_LABEL_WIDTH = "9.5rem"

/** Roving-tabindex cursor: which block is tab-reachable, per lane. */
interface FocusKey {
  laneIndex: number
  blockIndex: number
}

export interface TraceTimelineProps {
  spans: AgentTraceSpan[]
  loading?: boolean
  scale: TimelineScale
  onScaleChange: (scale: TimelineScale) => void
  grouping: TimelineGrouping
  onGroupingChange: (grouping: TimelineGrouping) => void
  /** Active zoom, or `null` for the whole trace. Owned by the host so the
   * waterfall below can narrow to the same window. */
  window: TimelineWindow | null
  onWindowChange: (window: TimelineWindow | null) => void
  selectedSpanId?: string | null
  onSelectSpan?: (spanId: string) => void
  /** The channel's search text; non-matching blocks are dimmed, not hidden. */
  highlightQuery?: string
  /** Strip folded to its toolbar. */
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  /** Start of the header row (the trace's identity). */
  leading?: ReactNode
  /** End of the header row (export, close). */
  actions?: ReactNode
  className?: string
}

/** True when `block` matches the channel search (see the file header). */
export function blockMatchesQuery(block: TimelineBlock, needle: string): boolean {
  return matchesTraceQuery(
    { name: block.label, traceId: block.traceId, surface: block.surface },
    needle
  )
}

/** A lane's display label: translated for enum groupings, raw otherwise. */
function laneLabel(lane: TimelineLane, grouping: TimelineGrouping, labels: SpanLabels): string {
  if (grouping === "operation") return labels.operation(lane.label)
  if (grouping === "surface") return labels.surface(lane.label)
  return lane.label
}

export function TraceTimeline({
  spans,
  loading = false,
  scale,
  onScaleChange,
  grouping,
  onGroupingChange,
  window: activeWindow,
  onWindowChange,
  selectedSpanId,
  onSelectSpan,
  highlightQuery = "",
  collapsed = false,
  onCollapsedChange,
  leading,
  actions,
  className,
}: TraceTimelineProps) {
  const t = useTranslations("logging.workspace.traces.timeline")
  const colors = useThemeColors()
  const labels = useSpanLabels()

  const timeline = useMemo(
    () => buildTraceTimeline(spans, { scale, grouping, window: activeWindow }),
    [spans, scale, grouping, activeWindow]
  )

  const needle = normalizeTraceQuery(highlightQuery)
  const zoomed = isZoomed(timeline)
  const hasLanes = !loading && timeline.lanes.length > 0

  const laneColors = useMemo(() => {
    const map = new Map<string, string>()
    timeline.lanes.forEach((lane, index) => map.set(lane.id, paletteColor(colors, index)))
    return map
  }, [timeline.lanes, colors])

  const zoomBy = useCallback(
    (factor: number) => {
      if (timeline.lanes.length === 0 && !zoomed) return
      onWindowChange(zoomWindow(timeline, factor))
    },
    [timeline, zoomed, onWindowChange]
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Never steal keys from the grouping select or anything else that types.
    const target = event.target as HTMLElement
    if (target.closest("input, textarea, [role='combobox'], [contenteditable='true']")) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === "+" || event.key === "=") {
      event.preventDefault()
      zoomBy(1 / ZOOM_STEP)
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault()
      zoomBy(ZOOM_STEP)
    } else if (event.key === "0") {
      event.preventDefault()
      onWindowChange(null)
    }
  }

  return (
    <section
      className={cn("flex flex-col gap-1.5 border-b px-3 py-2", className)}
      aria-label={t("regionLabel")}
      aria-keyshortcuts="+ - 0"
      data-testid="trace-timeline"
      data-collapsed={collapsed ? "true" : "false"}
      onKeyDown={handleKeyDown}
    >
      <TimelineToolbar
        timeline={timeline}
        totalSpans={spans.length}
        showControls={hasLanes || zoomed}
        scale={scale}
        onScaleChange={onScaleChange}
        grouping={grouping}
        onGroupingChange={onGroupingChange}
        zoomed={zoomed}
        onZoom={zoomBy}
        onResetZoom={() => onWindowChange(null)}
        collapsed={collapsed}
        onCollapsedChange={onCollapsedChange}
        leading={leading}
        actions={actions}
      />

      {loading ? (
        <div
          role="status"
          className="py-2 text-xs text-muted-foreground"
          data-testid="trace-timeline-loading"
        >
          {t("loading")}
        </div>
      ) : timeline.lanes.length === 0 ? (
        <div className="py-2 text-xs text-muted-foreground" data-testid="trace-timeline-empty">
          {zoomed ? t("emptyWindow") : t("empty")}
        </div>
      ) : collapsed ? null : (
        <>
          <TimelineRuler timeline={timeline} />
          <TimelineLanes
            timeline={timeline}
            grouping={grouping}
            labels={labels}
            laneColors={laneColors}
            needle={needle}
            selectedSpanId={selectedSpanId ?? null}
            onSelectSpan={onSelectSpan}
            onWindowChange={onWindowChange}
          />
        </>
      )}
    </section>
  )
}

function TimelineToolbar({
  timeline,
  totalSpans,
  showControls,
  scale,
  onScaleChange,
  grouping,
  onGroupingChange,
  zoomed,
  onZoom,
  onResetZoom,
  collapsed,
  onCollapsedChange,
  leading,
  actions,
}: {
  timeline: TraceTimelineModel
  totalSpans: number
  showControls: boolean
  scale: TimelineScale
  onScaleChange: (scale: TimelineScale) => void
  grouping: TimelineGrouping
  onGroupingChange: (grouping: TimelineGrouping) => void
  zoomed: boolean
  onZoom: (factor: number) => void
  onResetZoom: () => void
  collapsed: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  leading?: ReactNode
  actions?: ReactNode
}) {
  const t = useTranslations("logging.workspace.traces.timeline")
  const fmt = useObservabilityFormatters()

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="trace-timeline-toolbar">
      {onCollapsedChange && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onCollapsedChange(!collapsed)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("expand") : t("collapse")}
          title={collapsed ? t("expand") : t("collapse")}
          data-testid="timeline-collapse"
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5" aria-hidden />
          ) : (
            <ChevronDownIcon className="size-3.5" aria-hidden />
          )}
        </Button>
      )}

      {leading}

      {showControls && (
        <>
          <div
            role="radiogroup"
            aria-label={t("scaleLabel")}
            className="flex items-center rounded-md border p-0.5"
          >
            {TIMELINE_SCALES.map((value) => (
              <Button
                key={value}
                type="button"
                role="radio"
                aria-checked={scale === value}
                variant={scale === value ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => onScaleChange(value)}
                data-testid={`timeline-scale-${value}`}
              >
                {t(`scales.${value}`)}
              </Button>
            ))}
          </div>

          <Select
            value={grouping}
            onValueChange={(value) => onGroupingChange(value as TimelineGrouping)}
          >
            <SelectTrigger className="h-6 w-[120px] text-[11px]" aria-label={t("groupingLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {TIMELINE_GROUPINGS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`groupings.${value}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
        <span data-testid="timeline-total-spans">
          {zoomed
            ? t("spansOf", { count: timeline.spanCount, total: totalSpans })
            : t("spans", { count: totalSpans })}
        </span>
        {timeline.lanes.length > 0 && (
          <span
            title={
              zoomed ? t("totalDuration", { value: fmt.duration(timeline.totalMs) }) : undefined
            }
          >
            {fmt.duration(timeline.window.until - timeline.window.since)}
          </span>
        )}
        {timeline.tokens > 0 && <span>{t("tokens", { value: fmt.compact(timeline.tokens) })}</span>}
        {timeline.costUsd > 0 && <span>{fmt.usd(timeline.costUsd)}</span>}
        {timeline.errorCount > 0 && (
          <Badge variant="outline" className="h-4 gap-1 px-1 text-[10px] text-destructive">
            <AlertTriangleIcon className="size-2.5" aria-hidden />
            <span className="sr-only">{t("errorCount", { count: timeline.errorCount })}</span>
            <span aria-hidden>{fmt.integer(timeline.errorCount)}</span>
          </Badge>
        )}
        {showControls && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => onZoom(1 / ZOOM_STEP)}
              aria-label={t("zoomIn")}
              title={t("zoomInHint")}
              data-testid="timeline-zoom-in"
            >
              <ZoomInIcon className="size-3" aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => onZoom(ZOOM_STEP)}
              disabled={!zoomed}
              aria-label={t("zoomOut")}
              title={t("zoomOutHint")}
              data-testid="timeline-zoom-out"
            >
              <ZoomOutIcon className="size-3" aria-hidden />
            </Button>
          </>
        )}
        {zoomed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={onResetZoom}
            title={t("resetZoomHint")}
            data-testid="timeline-reset-zoom"
          >
            {t("resetZoom")}
          </Button>
        )}
        {actions}
      </div>
    </div>
  )
}

function tickText(
  tick: { at: number },
  timeline: TraceTimelineModel,
  fmt: ObservabilityFormatters,
  sequenceLabel: (index: number) => string
): string {
  return timeline.scale === "sequence"
    ? sequenceLabel(tick.at + 1)
    : fmt.duration(Math.max(0, tick.at - timeline.traceStart))
}

function TimelineRuler({ timeline }: { timeline: TraceTimelineModel }) {
  const t = useTranslations("logging.workspace.traces.timeline")
  const fmt = useObservabilityFormatters()
  if (timeline.ticks.length === 0) return null
  return (
    <div className="flex items-end gap-2" aria-hidden data-testid="trace-timeline-ruler">
      <div className="shrink-0" style={{ width: LANE_LABEL_WIDTH }} />
      <div className="relative h-3 min-w-0 flex-1">
        {timeline.ticks.map((tick) => (
          <span
            key={`${tick.at}-${tick.offsetPct}`}
            className="absolute top-0 -translate-x-1/2 text-[10px] text-muted-foreground tabular-nums"
            style={{ left: `${tick.offsetPct}%` }}
          >
            {tickText(tick, timeline, fmt, (index) => t("sequenceTick", { index }))}
          </span>
        ))}
      </div>
    </div>
  )
}

function TimelineLanes({
  timeline,
  grouping,
  labels,
  laneColors,
  needle,
  selectedSpanId,
  onSelectSpan,
  onWindowChange,
}: {
  timeline: TraceTimelineModel
  grouping: TimelineGrouping
  labels: SpanLabels
  laneColors: Map<string, string>
  needle: string
  selectedSpanId: string | null
  onSelectSpan?: (spanId: string) => void
  onWindowChange: (window: TimelineWindow | null) => void
}) {
  const t = useTranslations("logging.workspace.traces.timeline")
  const trackRef = useRef<HTMLDivElement | null>(null)
  const lanesRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  // One hovered span for the whole strip, so exactly one hover card exists.
  const [hovered, setHovered] = useState<string | null>(null)
  const [focusKey, setFocusKey] = useState<FocusKey | null>(null)

  /** ↑/↓ between lanes, landing on the nearest block by position. */
  const moveLane = useCallback(
    (fromLane: number, delta: -1 | 1, blockIndex: number) => {
      const nextLane = fromLane + delta
      const lane = timeline.lanes[nextLane]
      if (!lane || lane.blocks.length === 0) return
      const nextBlock = Math.min(blockIndex, lane.blocks.length - 1)
      setFocusKey({ laneIndex: nextLane, blockIndex: nextBlock })
      lanesRef.current
        ?.querySelectorAll<HTMLElement>("[data-lane-index]")
        [nextLane]?.querySelector<HTMLButtonElement>(`[data-block-index="${nextBlock}"]`)
        ?.focus()
    },
    [timeline.lanes]
  )

  /**
   * Pointer x → 0–1 across the plotting area, or `null` outside it. The brush
   * track is the ruler for every row: lanes and brush share the same label
   * gutter and the same flex-1 track, so one rect measures them all — which is
   * what lets a drag start on a lane's empty space, not only on the brush.
   */
  const fractionAt = useCallback((clientX: number, clamp: boolean): number | null => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return null
    const raw = (clientX - rect.left) / rect.width
    if (!clamp && (raw < 0 || raw > 1)) return null
    return Math.min(1, Math.max(0, raw))
  }, [])

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      // Left button only, and never start a drag on top of a block — that is
      // a selection click, not a zoom gesture.
      if (event.button !== 0) return
      if ((event.target as HTMLElement).closest("[data-timeline-block]")) return
      // A press in the lane-label gutter is not on the time axis at all.
      const fraction = fractionAt(event.clientX, false)
      if (fraction === null) return
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Capture is an optimisation; the drag still tracks without it.
      }
      setDrag({ from: fraction, to: fraction })
    },
    [fractionAt]
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!drag) return
      const fraction = fractionAt(event.clientX, true)
      if (fraction === null) return
      setDrag({ from: drag.from, to: fraction })
    },
    [drag, fractionAt]
  )

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!drag) return
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // capture may already be lost; the window update below still applies
      }
      const next = windowFromDrag(timeline, drag.from, drag.to)
      setDrag(null)
      if (next) onWindowChange(next)
    },
    [drag, timeline, onWindowChange]
  )

  const selection =
    drag && Math.abs(drag.to - drag.from) > 0.001
      ? { left: Math.min(drag.from, drag.to) * 100, width: Math.abs(drag.to - drag.from) * 100 }
      : null

  return (
    // The gesture surface spans the lanes AND the brush, so a drag anywhere in
    // the strip means the same thing; blocks opt out (see pointer-down).
    <div
      className="relative flex flex-col gap-1"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => setDrag(null)}
      data-testid="trace-timeline-gesture"
    >
      <div
        className="flex max-h-40 flex-col gap-1 overflow-y-auto"
        data-testid="trace-timeline-lanes"
        ref={lanesRef}
      >
        {timeline.lanes.map((lane, laneIndex) => (
          <div key={lane.id} data-lane-index={laneIndex}>
            <LaneRow
              lane={lane}
              label={laneLabel(lane, grouping, labels)}
              laneIndex={laneIndex}
              color={laneColors.get(lane.id) ?? "var(--primary)"}
              needle={needle}
              selectedSpanId={selectedSpanId}
              onSelectSpan={onSelectSpan}
              hovered={hovered}
              onHoverChange={setHovered}
              focusKey={focusKey}
              onFocusKeyChange={setFocusKey}
              onMoveLane={moveLane}
              operationLabel={labels.operation}
            />
          </div>
        ))}
      </div>

      <div className="flex items-stretch gap-2">
        <div className="shrink-0" style={{ width: LANE_LABEL_WIDTH }} />
        <div
          ref={trackRef}
          role="presentation"
          className="relative h-4 min-w-0 flex-1 cursor-col-resize rounded-sm bg-muted/40"
          onDoubleClick={() => onWindowChange(null)}
          title={t("brushHint")}
          data-testid="trace-timeline-brush"
        >
          {timeline.markers.map((marker, index) => (
            <span
              key={`${marker.spanId}-${index}`}
              aria-hidden
              className="absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/50"
              style={{ left: `${marker.offsetPct}%` }}
              data-testid="trace-timeline-marker"
            />
          ))}
        </div>
      </div>

      {selection && (
        // Drawn over every row of the plotting area, offset past the label
        // gutter, so the window being selected is visible across the lanes.
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 flex gap-2"
          style={{ left: 0, right: 0 }}
        >
          <div className="shrink-0" style={{ width: LANE_LABEL_WIDTH }} />
          <div className="relative min-w-0 flex-1">
            <div
              className="absolute inset-y-0 bg-primary/25 ring-1 ring-primary/60"
              style={{ left: `${selection.left}%`, width: `${selection.width}%` }}
              data-testid="trace-timeline-selection"
            />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * One lane. Blocks are plain buttons under a **roving tabindex**: only one is
 * tab-reachable, and the arrow keys move within (←/→) and across (↑/↓) lanes.
 * Giving every span its own tab stop turned a 400-span trace into 400 stops
 * between the search box and the waterfall.
 *
 * The hover card is rendered ONCE per lane, by the lane that owns the hovered
 * block, rather than wrapping every block in a Radix `Tooltip` — that mounted
 * a popper per span and was the single most expensive thing on this screen.
 */
function LaneRow({
  lane,
  label,
  laneIndex,
  color,
  needle,
  selectedSpanId,
  onSelectSpan,
  hovered,
  onHoverChange,
  focusKey,
  onFocusKeyChange,
  onMoveLane,
  operationLabel,
}: {
  lane: TimelineLane
  label: string
  laneIndex: number
  color: string
  needle: string
  selectedSpanId: string | null
  onSelectSpan?: (spanId: string) => void
  hovered: string | null
  onHoverChange: (spanId: string | null) => void
  focusKey: FocusKey | null
  onFocusKeyChange: (key: FocusKey) => void
  onMoveLane: (fromLane: number, delta: -1 | 1, blockIndex: number) => void
  operationLabel: (value: string) => string
}) {
  const t = useTranslations("logging.workspace.traces.timeline")
  const fmt = useObservabilityFormatters()
  const trackRef = useRef<HTMLDivElement | null>(null)
  const hasMatch =
    needle.length === 0 || lane.blocks.some((block) => blockMatchesQuery(block, needle))

  // Which block in THIS lane is tab-reachable: the selected one, else the
  // one the user last arrowed to, else the first.
  const selectedIndex = lane.blocks.findIndex((block) => block.spanId === selectedSpanId)
  const focusIndex =
    focusKey?.laneIndex === laneIndex
      ? Math.min(Math.max(0, focusKey.blockIndex), lane.blocks.length - 1)
      : selectedIndex >= 0
        ? selectedIndex
        : 0

  const focusBlockAt = useCallback((index: number) => {
    const node = trackRef.current?.querySelector<HTMLButtonElement>(`[data-block-index="${index}"]`)
    node?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault()
        const next = Math.min(
          lane.blocks.length - 1,
          Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1))
        )
        onFocusKeyChange({ laneIndex, blockIndex: next })
        focusBlockAt(next)
        return
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        onMoveLane(laneIndex, event.key === "ArrowDown" ? 1 : -1, index)
        return
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault()
        const next = event.key === "Home" ? 0 : lane.blocks.length - 1
        onFocusKeyChange({ laneIndex, blockIndex: next })
        focusBlockAt(next)
      }
    },
    [lane.blocks.length, laneIndex, onFocusKeyChange, focusBlockAt, onMoveLane]
  )

  // Stable per lane. An inline `() => onFocusKeyChange({laneIndex, blockIndex})`
  // is a new function every render, which defeats the `memo` on every block and
  // re-renders the whole lane on each hover.
  const handleBlockFocus = useCallback(
    (blockIndex: number) => onFocusKeyChange({ laneIndex, blockIndex }),
    [laneIndex, onFocusKeyChange]
  )

  const hoveredBlock = hovered
    ? (lane.blocks.find((block) => block.spanId === hovered) ?? null)
    : null

  return (
    <div className="flex items-center gap-2" data-testid={`timeline-lane-${lane.id}`}>
      <div className="flex min-w-0 shrink-0 items-center gap-1" style={{ width: LANE_LABEL_WIDTH }}>
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-[2px]"
          style={{ backgroundColor: color }}
        />
        <span className="min-w-0 truncate text-[11px] font-medium" title={lane.label}>
          {label}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {fmt.integer(lane.spanCount)}
        </span>
        {lane.errorCount > 0 && (
          <AlertTriangleIcon
            className="size-2.5 shrink-0 text-destructive"
            role="img"
            aria-label={t("laneErrors", { count: lane.errorCount })}
          />
        )}
      </div>

      <div
        ref={trackRef}
        role="group"
        aria-label={label}
        className={cn(
          "relative h-5 min-w-0 flex-1 rounded-sm bg-muted/30",
          !hasMatch && "opacity-40"
        )}
      >
        {lane.blocks.map((block, index) => (
          <TimelineBlockButton
            key={block.spanId}
            block={block}
            index={index}
            color={color}
            dimmed={needle.length > 0 && !blockMatchesQuery(block, needle)}
            selected={block.spanId === selectedSpanId}
            tabbable={index === focusIndex}
            onSelect={onSelectSpan}
            onHoverChange={onHoverChange}
            onKeyDown={handleKeyDown}
            onFocusKeyChange={handleBlockFocus}
            laneLabel={label}
            duration={fmt.duration(block.durationMs)}
          />
        ))}
        {hoveredBlock && (
          <TimelineHoverCard
            block={hoveredBlock}
            operation={operationLabel(hoveredBlock.operationName)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * The single hover card for whichever block the pointer or focus is on. Anchored
 * inside the lane track, flipped to the left half when the block sits past the
 * midpoint so it never runs off the pane.
 */
function TimelineHoverCard({ block, operation }: { block: TimelineBlock; operation: string }) {
  const t = useTranslations("logging.workspace.traces.timeline")
  const fmt = useObservabilityFormatters()
  const anchorRight = block.offsetPct > 55
  const parts = [operation, fmt.duration(block.durationMs)]
  if (block.tokens > 0) parts.push(t("tokens", { value: fmt.compact(block.tokens) }))
  if (block.costUsd > 0) parts.push(fmt.usd(block.costUsd))
  return (
    <div
      role="tooltip"
      data-testid="timeline-hover-card"
      className={cn(
        "pointer-events-none absolute bottom-full z-20 mb-1 w-max max-w-xs rounded-md border bg-popover px-2 py-1.5 shadow-md",
        anchorRight ? "right-0" : "left-0"
      )}
      style={anchorRight ? undefined : { left: `${Math.min(block.offsetPct, 92)}%` }}
    >
      <div className="text-xs font-medium">{block.label}</div>
      <div className="text-[11px] text-muted-foreground tabular-nums" title={block.operationName}>
        {parts.join(" · ")}
      </div>
      {block.isError && <div className="text-[11px] text-destructive">{t("blockError")}</div>}
    </div>
  )
}

const TimelineBlockButton = memo(function TimelineBlockButton({
  block,
  index,
  color,
  dimmed,
  selected,
  tabbable,
  onSelect,
  onHoverChange,
  onKeyDown,
  onFocusKeyChange,
  laneLabel,
  duration,
}: {
  block: TimelineBlock
  index: number
  color: string
  dimmed: boolean
  selected: boolean
  tabbable: boolean
  onSelect?: (spanId: string) => void
  onHoverChange: (spanId: string | null) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void
  onFocusKeyChange: (index: number) => void
  laneLabel: string
  duration: string
}) {
  const t = useTranslations("logging.workspace.traces.timeline")
  const interactive = typeof onSelect === "function"

  return (
    <button
      type="button"
      data-timeline-block=""
      data-block-index={index}
      data-testid={`timeline-block-${block.spanId}`}
      aria-current={selected ? "true" : undefined}
      aria-label={t("blockAria", { label: block.label, lane: laneLabel, duration })}
      disabled={!interactive}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onSelect?.(block.spanId)}
      onPointerEnter={() => onHoverChange(block.spanId)}
      onPointerLeave={() => onHoverChange(null)}
      onFocus={() => {
        onHoverChange(block.spanId)
        onFocusKeyChange(index)
      }}
      onBlur={() => onHoverChange(null)}
      onKeyDown={(event) => onKeyDown(event, index)}
      className={cn(
        "absolute top-0.5 bottom-0.5 min-w-[3px] rounded-[2px] transition-opacity",
        "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
        dimmed && "opacity-25",
        selected && "ring-2 ring-foreground ring-offset-1 ring-offset-background",
        !interactive && "pointer-events-none"
      )}
      style={{
        left: `${block.offsetPct}%`,
        width: `${block.widthPct}%`,
        backgroundColor: block.isError ? "var(--destructive)" : color,
        // Deeper spans read lighter, so nesting is visible without indentation.
        opacity: dimmed ? undefined : Math.max(0.55, 1 - block.depth * 0.12),
      }}
    />
  )
})

export default TraceTimeline
