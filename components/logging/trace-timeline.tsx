"use client"

/**
 * The trace timeline strip — one trace's whole shape in a few rows.
 *
 * Sits above the waterfall in the `/logs` Traces channel. The waterfall
 * answers "what called what"; this answers "what was it doing, and when".
 * Lanes come from `buildTraceTimeline`, which is pure and separately tested;
 * everything here is interaction:
 *
 *  - **Scale** — Duration (real elapsed time) or Sequence (one equal slot per
 *    span). Sequence is the mode that survives a trace with one 40s model call
 *    and thirty sub-millisecond tool calls.
 *  - **Grouping** — lanes by operation, surface, model, or agent.
 *  - **Zoom** — drag across the strip to select a window; the ruler, the
 *    lanes, and (via `onWindowChange`) the waterfall below all narrow to it.
 *    Double-click or the reset chip restores the full trace.
 *  - **Selection** — clicking a block selects that span, shared with the
 *    waterfall and the detail pane.
 *  - **Search** — `highlightQuery` dims blocks that do not match instead of
 *    removing them, so a filtered trace keeps its shape.
 *
 * Blocks are absolutely positioned percentages, so resizing the pane costs a
 * layout, not a re-render.
 */

import { memo, useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, ZoomOutIcon } from "lucide-react"

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
import { paletteColor } from "@/lib/observability/chart-palette"
import { formatMs, formatTokens, formatUsd } from "@/lib/observability/format-utils"
import {
  buildTraceTimeline,
  isZoomed,
  windowFromDrag,
  type TimelineBlock,
  type TimelineGrouping,
  type TimelineLane,
  type TimelineScale,
  type TimelineWindow,
  type TraceTimeline,
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
  /** Case-insensitive match; non-matching blocks are dimmed, not hidden. */
  highlightQuery?: string
  className?: string
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
  className,
}: TraceTimelineProps) {
  const t = useTranslations("logging.workspace.traces.timeline")
  const colors = useThemeColors()

  const timeline = useMemo(
    () => buildTraceTimeline(spans, { scale, grouping, window: activeWindow }),
    [spans, scale, grouping, activeWindow]
  )

  const needle = highlightQuery.trim().toLowerCase()
  const zoomed = isZoomed(timeline)

  const laneColors = useMemo(() => {
    const map = new Map<string, string>()
    timeline.lanes.forEach((lane, index) => map.set(lane.id, paletteColor(colors, index)))
    return map
  }, [timeline.lanes, colors])

  if (loading) {
    return (
      <div
        role="status"
        className={cn("px-3 py-4 text-xs text-muted-foreground", className)}
        data-testid="trace-timeline-loading"
      >
        {t("loading")}
      </div>
    )
  }

  if (timeline.lanes.length === 0) {
    return (
      <div
        className={cn("px-3 py-4 text-xs text-muted-foreground", className)}
        data-testid="trace-timeline-empty"
      >
        {zoomed ? t("emptyWindow") : t("empty")}
      </div>
    )
  }

  return (
    <section
      className={cn("flex flex-col gap-1.5 border-b px-3 py-2", className)}
      aria-label={t("regionLabel")}
      data-testid="trace-timeline"
    >
      <TimelineToolbar
        timeline={timeline}
        scale={scale}
        onScaleChange={onScaleChange}
        grouping={grouping}
        onGroupingChange={onGroupingChange}
        zoomed={zoomed}
        onResetZoom={() => onWindowChange(null)}
      />

      <TimelineRuler timeline={timeline} />

      <TimelineLanes
        timeline={timeline}
        laneColors={laneColors}
        needle={needle}
        selectedSpanId={selectedSpanId ?? null}
        onSelectSpan={onSelectSpan}
        onWindowChange={onWindowChange}
      />
    </section>
  )
}

function TimelineToolbar({
  timeline,
  scale,
  onScaleChange,
  grouping,
  onGroupingChange,
  zoomed,
  onResetZoom,
}: {
  timeline: TraceTimeline
  scale: TimelineScale
  onScaleChange: (scale: TimelineScale) => void
  grouping: TimelineGrouping
  onGroupingChange: (grouping: TimelineGrouping) => void
  zoomed: boolean
  onResetZoom: () => void
}) {
  const t = useTranslations("logging.workspace.traces.timeline")

  return (
    <div className="flex flex-wrap items-center gap-1.5">
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

      <div className="ml-auto flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
        <span data-testid="timeline-total-spans">{t("spans", { count: timeline.spanCount })}</span>
        <span>{formatMs(timeline.window.until - timeline.window.since)}</span>
        {timeline.tokens > 0 && <span>{formatTokens(timeline.tokens)}</span>}
        {timeline.costUsd > 0 && <span>{formatUsd(timeline.costUsd)}</span>}
        {timeline.errorCount > 0 && (
          <Badge variant="outline" className="h-4 gap-1 px-1 text-[10px] text-destructive">
            <AlertTriangleIcon className="size-2.5" aria-hidden />
            {timeline.errorCount}
          </Badge>
        )}
        {zoomed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={onResetZoom}
            data-testid="timeline-reset-zoom"
          >
            <ZoomOutIcon className="size-3" aria-hidden />
            {t("resetZoom")}
          </Button>
        )}
      </div>
    </div>
  )
}

function TimelineRuler({ timeline }: { timeline: TraceTimeline }) {
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
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function TimelineLanes({
  timeline,
  laneColors,
  needle,
  selectedSpanId,
  onSelectSpan,
  onWindowChange,
}: {
  timeline: TraceTimeline
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

  const fractionAt = useCallback((clientX: number): number | null => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return null
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }, [])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Left button only, and never start a drag on top of a block — that is
      // a selection click, not a zoom gesture.
      if (event.button !== 0) return
      if ((event.target as HTMLElement).closest("[data-timeline-block]")) return
      const fraction = fractionAt(event.clientX)
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
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drag) return
      const fraction = fractionAt(event.clientX)
      if (fraction === null) return
      setDrag({ from: drag.from, to: fraction })
    },
    [drag, fractionAt]
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
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
    <div className="flex flex-col gap-1" data-testid="trace-timeline-lanes" ref={lanesRef}>
      {timeline.lanes.map((lane, laneIndex) => (
        <div key={lane.id} data-lane-index={laneIndex}>
          <LaneRow
            lane={lane}
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
          />
        </div>
      ))}

      {/* The zoom-gesture surface spans every lane, so a drag anywhere in the
          strip means the same thing. It sits under the blocks (which stop the
          gesture) and above nothing else. */}
      <div className="flex items-stretch gap-2">
        <div className="shrink-0" style={{ width: LANE_LABEL_WIDTH }} />
        <div
          ref={trackRef}
          role="presentation"
          className="relative h-4 min-w-0 flex-1 cursor-col-resize rounded-sm bg-muted/40"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => setDrag(null)}
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
          {selection && (
            <div
              aria-hidden
              className="absolute inset-y-0 bg-primary/25 ring-1 ring-primary/60"
              style={{ left: `${selection.left}%`, width: `${selection.width}%` }}
              data-testid="trace-timeline-selection"
            />
          )}
        </div>
      </div>
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
}: {
  lane: TimelineLane
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
}) {
  const t = useTranslations("logging.workspace.traces.timeline")
  const trackRef = useRef<HTMLDivElement | null>(null)
  const hasMatch = needle.length === 0 || lane.blocks.some((block) => matches(block, needle))

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
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
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
          {lane.label}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {lane.spanCount}
        </span>
        {lane.errorCount > 0 && (
          <AlertTriangleIcon
            className="size-2.5 shrink-0 text-destructive"
            aria-label={t("laneErrors", { count: lane.errorCount })}
          />
        )}
      </div>

      <div
        ref={trackRef}
        role="group"
        aria-label={lane.label}
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
            dimmed={needle.length > 0 && !matches(block, needle)}
            selected={block.spanId === selectedSpanId}
            tabbable={index === focusIndex}
            onSelect={onSelectSpan}
            onHoverChange={onHoverChange}
            onKeyDown={handleKeyDown}
            onFocusKeyChange={handleBlockFocus}
            laneLabel={lane.label}
          />
        ))}
        {hoveredBlock && <TimelineHoverCard block={hoveredBlock} />}
      </div>
    </div>
  )
}

/**
 * The single hover card for whichever block the pointer or focus is on. Anchored
 * inside the lane track, flipped to the left half when the block sits past the
 * midpoint so it never runs off the pane.
 */
function TimelineHoverCard({ block }: { block: TimelineBlock }) {
  const t = useTranslations("logging.workspace.traces.timeline")
  const anchorRight = block.offsetPct > 55
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
      <div className="text-[11px] text-muted-foreground tabular-nums">
        {block.operationName} · {formatMs(block.durationMs)}
        {block.tokens > 0 ? ` · ${formatTokens(block.tokens)}` : ""}
        {block.costUsd > 0 ? ` · ${formatUsd(block.costUsd)}` : ""}
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
}: {
  block: TimelineBlock
  index: number
  color: string
  dimmed: boolean
  selected: boolean
  tabbable: boolean
  onSelect?: (spanId: string) => void
  onHoverChange: (spanId: string | null) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => void
  onFocusKeyChange: (index: number) => void
  laneLabel: string
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
      aria-label={t("blockAria", {
        label: block.label,
        lane: laneLabel,
        duration: formatMs(block.durationMs),
      })}
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

function matches(block: TimelineBlock, needle: string): boolean {
  return (
    block.label.toLowerCase().includes(needle) ||
    block.operationName.toLowerCase().includes(needle) ||
    block.spanId.toLowerCase().includes(needle)
  )
}

export default TraceTimeline
