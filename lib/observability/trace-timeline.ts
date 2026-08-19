/**
 * Lane model for the agent-trace timeline.
 *
 * The waterfall (`./trace-rollup.ts:buildWaterfall`) answers "what called
 * what" — one row per span, indented by parentage. It cannot answer "what was
 * this trace *doing* over its lifetime", because a chat turn with 20 tool
 * calls is 20 rows you have to scroll, and nothing shows that 18 of them ran
 * inside one model call.
 *
 * This module projects the same spans onto a small number of horizontal lanes
 * — model work, tool work, retrieval, and so on — so a whole trace fits in a
 * strip. It is the data behind `components/logging/trace-timeline.tsx`.
 *
 * Pure: no Dexie, no React, no `Date.now()`. Geometry is emitted as
 * percentages against an explicit window so the caller can zoom by narrowing
 * the window rather than by re-deriving anything.
 */

import type { AgentTraceSpan, SpanOperationName } from "@/types/agent-trace/span"

/**
 * How the horizontal axis is measured.
 *
 * - `duration` — real elapsed time. Truthful, but a trace with one 40s model
 *   call and 30 sub-millisecond tool calls renders as one bar and a smear.
 * - `sequence` — one equal slot per span in chronological order. Loses timing
 *   and shows structure: which lane was busy, in what order, how often.
 */
export type TimelineScale = "duration" | "sequence"

/** What a lane collects. */
export type TimelineGrouping = "operation" | "surface" | "model" | "agent"

export interface TimelineWindow {
  since: number
  until: number
}

export interface TimelineBlock {
  spanId: string
  parentSpanId?: string
  label: string
  startTime: number
  durationMs: number
  /** Left edge, 0–100, against the active window. */
  offsetPct: number
  /** Width, 0–100. Never 0 — a zero-duration span still has to be clickable. */
  widthPct: number
  isError: boolean
  /** Nesting depth within the trace, for subtle shading. */
  depth: number
  costUsd: number
  tokens: number
  operationName: SpanOperationName
}

export interface TimelineLane {
  id: string
  /** Display label. `operation`/`surface` ids are already human-readable; a
   * model or agent lane is labelled by its value. */
  label: string
  blocks: TimelineBlock[]
  spanCount: number
  errorCount: number
  /** Summed span duration — can exceed the trace duration when work overlaps,
   * which is exactly the signal a lane header should carry. */
  busyMs: number
  costUsd: number
  tokens: number
}

export interface TimelineMarker {
  spanId: string
  name: string
  at: number
  offsetPct: number
}

export interface TimelineTick {
  offsetPct: number
  label: string
  at: number
}

export interface TraceTimeline {
  lanes: TimelineLane[]
  /** The window the geometry is relative to. */
  window: TimelineWindow
  /** Full trace bounds, regardless of the active window. */
  traceStart: number
  traceEnd: number
  totalMs: number
  spanCount: number
  errorCount: number
  costUsd: number
  tokens: number
  markers: TimelineMarker[]
  ticks: TimelineTick[]
  scale: TimelineScale
  grouping: TimelineGrouping
}

export interface BuildTimelineOptions {
  scale?: TimelineScale
  grouping?: TimelineGrouping
  /** Zoom. Omit for the full trace. Reversed bounds are normalized. */
  window?: TimelineWindow | null
  /** Target number of axis ticks. */
  tickCount?: number
}

/** Lane order for `operation` grouping — the order work actually flows in. */
const OPERATION_LANES: readonly SpanOperationName[] = [
  "invoke_agent",
  "chat",
  "execute_tool",
  "retrieval",
  "embeddings",
  "invoke_workflow",
]

const EMPTY_TIMELINE_WINDOW: TimelineWindow = { since: 0, until: 0 }

function isError(span: AgentTraceSpan): boolean {
  return Boolean(span.errorType || span.errorMessage)
}

function spanEnd(span: AgentTraceSpan): number {
  return span.endTime ?? span.startTime + (span.durationMs ?? 0)
}

function spanDuration(span: AgentTraceSpan): number {
  return Math.max(0, span.durationMs ?? spanEnd(span) - span.startTime)
}

/** Short label for one block. Tool name beats operation name — "Bash" is what
 * the user is looking for, "execute_tool" is what everything is. */
export function blockLabel(span: AgentTraceSpan): string {
  if (span.toolName) return span.toolName
  if (span.agentName) return span.agentName
  return span.operationName
}

/** Which lane a span belongs to, under the chosen grouping. */
export function laneKeyFor(span: AgentTraceSpan, grouping: TimelineGrouping): string {
  switch (grouping) {
    case "operation":
      return span.operationName
    case "surface":
      return span.surface
    case "model":
      return span.responseModel ?? span.requestModel ?? "—"
    case "agent":
      return span.agentName ?? span.agentId ?? span.toolName ?? span.operationName
  }
}

/**
 * Depth of each span within the trace, by walking `parentSpanId`. Orphans and
 * cycles resolve to depth 0 rather than looping.
 */
function depthsOf(spans: AgentTraceSpan[]): Map<string, number> {
  const byId = new Map(spans.map((span) => [span.spanId, span]))
  const depths = new Map<string, number>()
  for (const span of spans) {
    let depth = 0
    let cursor: AgentTraceSpan | undefined = span
    const seen = new Set<string>([span.spanId])
    while (cursor?.parentSpanId && !seen.has(cursor.parentSpanId)) {
      const parent = byId.get(cursor.parentSpanId)
      if (!parent) break
      seen.add(parent.spanId)
      depth += 1
      cursor = parent
      if (depth > 64) break
    }
    depths.set(span.spanId, depth)
  }
  return depths
}

function normalizeWindow(window: TimelineWindow): TimelineWindow {
  return {
    since: Math.min(window.since, window.until),
    until: Math.max(window.since, window.until),
  }
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** Human-readable axis label. Mirrors `formatMs`, kept local so this module
 * stays dependency-free. */
function tickLabel(ms: number): string {
  if (ms < 1) return "0"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function buildTicks(
  window: TimelineWindow,
  traceStart: number,
  scale: TimelineScale,
  visibleCount: number,
  tickCount: number
): TimelineTick[] {
  const count = Math.max(2, Math.floor(tickCount))
  if (scale === "sequence") {
    // Sequence mode has no time axis; the ruler counts spans instead.
    if (visibleCount === 0) return []
    const steps = Math.min(count, visibleCount)
    const ticks: TimelineTick[] = []
    for (let i = 0; i < steps; i++) {
      const index = Math.round((i / (steps - 1 || 1)) * (visibleCount - 1))
      ticks.push({
        offsetPct: clampPct(((index + 0.5) / visibleCount) * 100),
        label: `#${index + 1}`,
        at: index,
      })
    }
    return ticks
  }

  const span = window.until - window.since
  if (span <= 0) return []
  const ticks: TimelineTick[] = []
  for (let i = 0; i < count; i++) {
    const at = window.since + (span * i) / (count - 1)
    ticks.push({
      offsetPct: clampPct(((at - window.since) / span) * 100),
      label: tickLabel(at - traceStart),
      at,
    })
  }
  return ticks
}

/**
 * Project one trace's spans onto lanes.
 *
 * Spans outside the active window are dropped, so zooming genuinely reduces
 * what is drawn rather than clipping it visually. A lane that ends up empty is
 * dropped too — an empty "embeddings" row is noise, not information.
 */
export function buildTraceTimeline(
  spans: AgentTraceSpan[],
  options: BuildTimelineOptions = {}
): TraceTimeline {
  const scale = options.scale ?? "duration"
  const grouping = options.grouping ?? "operation"
  const tickCount = options.tickCount ?? 5

  if (spans.length === 0) {
    return {
      lanes: [],
      window: EMPTY_TIMELINE_WINDOW,
      traceStart: 0,
      traceEnd: 0,
      totalMs: 0,
      spanCount: 0,
      errorCount: 0,
      costUsd: 0,
      tokens: 0,
      markers: [],
      ticks: [],
      scale,
      grouping,
    }
  }

  let traceStart = Number.POSITIVE_INFINITY
  let traceEnd = Number.NEGATIVE_INFINITY
  for (const span of spans) {
    if (span.startTime < traceStart) traceStart = span.startTime
    const end = spanEnd(span)
    if (end > traceEnd) traceEnd = end
  }

  const window = options.window
    ? normalizeWindow(options.window)
    : { since: traceStart, until: traceEnd }

  const visible = spans
    .filter((span) => spanEnd(span) >= window.since && span.startTime <= window.until)
    .sort((a, b) => a.startTime - b.startTime || a.spanId.localeCompare(b.spanId))

  const depths = depthsOf(spans)
  const windowMs = Math.max(0, window.until - window.since)

  const geometryFor = (
    span: AgentTraceSpan,
    index: number
  ): { offsetPct: number; widthPct: number } => {
    if (scale === "sequence") {
      const slot = 100 / Math.max(1, visible.length)
      return { offsetPct: clampPct(index * slot), widthPct: Math.max(0.4, slot) }
    }
    if (windowMs <= 0) return { offsetPct: 0, widthPct: 100 }
    const rawOffset = ((span.startTime - window.since) / windowMs) * 100
    const rawWidth = (spanDuration(span) / windowMs) * 100
    const offsetPct = clampPct(rawOffset)
    // A sub-millisecond tool call still has to be hittable; clamp to a floor
    // and never let a block run past the right edge.
    const widthPct = Math.min(Math.max(rawWidth, 0.4), Math.max(0.4, 100 - offsetPct))
    return { offsetPct, widthPct }
  }

  const laneMap = new Map<string, TimelineLane>()
  const markers: TimelineMarker[] = []
  let errorCount = 0
  let costUsd = 0
  let tokens = 0

  visible.forEach((span, index) => {
    const key = laneKeyFor(span, grouping)
    const { offsetPct, widthPct } = geometryFor(span, index)
    const usage = span.usage
    const spanTokens = usage ? usage.inputTokens + usage.outputTokens : 0
    const spanCost = span.costUsdEstimate ?? 0
    const failed = isError(span)

    const block: TimelineBlock = {
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      label: blockLabel(span),
      startTime: span.startTime,
      durationMs: spanDuration(span),
      offsetPct,
      widthPct,
      isError: failed,
      depth: depths.get(span.spanId) ?? 0,
      costUsd: spanCost,
      tokens: spanTokens,
      operationName: span.operationName,
    }

    const lane = laneMap.get(key)
    if (lane) {
      lane.blocks.push(block)
      lane.spanCount += 1
      lane.errorCount += failed ? 1 : 0
      lane.busyMs += block.durationMs
      lane.costUsd += spanCost
      lane.tokens += spanTokens
    } else {
      laneMap.set(key, {
        id: key,
        label: key,
        blocks: [block],
        spanCount: 1,
        errorCount: failed ? 1 : 0,
        busyMs: block.durationMs,
        costUsd: spanCost,
        tokens: spanTokens,
      })
    }

    errorCount += failed ? 1 : 0
    costUsd += spanCost
    tokens += spanTokens

    // Mid-span events ride the same axis as their span so a "tool_call" tick
    // lands where it happened, not where the span started.
    for (const event of span.events ?? []) {
      if (event.at < window.since || event.at > window.until) continue
      const offset =
        scale === "sequence"
          ? offsetPct + widthPct / 2
          : windowMs > 0
            ? ((event.at - window.since) / windowMs) * 100
            : 0
      markers.push({
        spanId: span.spanId,
        name: event.name,
        at: event.at,
        offsetPct: clampPct(offset),
      })
    }
  })

  const lanes = [...laneMap.values()].sort(laneComparator(grouping))

  return {
    lanes,
    window,
    traceStart,
    traceEnd,
    totalMs: Math.max(0, traceEnd - traceStart),
    spanCount: visible.length,
    errorCount,
    costUsd,
    tokens,
    markers,
    ticks: buildTicks(window, traceStart, scale, visible.length, tickCount),
    scale,
    grouping,
  }
}

/**
 * Lane ordering. `operation` follows the fixed flow order above so the strip
 * reads top-to-bottom the way work happens; every other grouping has no
 * inherent order, so it sorts by weight (busiest first) with a stable
 * alphabetical tiebreak.
 */
function laneComparator(grouping: TimelineGrouping): (a: TimelineLane, b: TimelineLane) => number {
  if (grouping === "operation") {
    const rank = (id: string) => {
      const index = OPERATION_LANES.indexOf(id as SpanOperationName)
      return index < 0 ? OPERATION_LANES.length : index
    }
    return (a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id)
  }
  return (a, b) => b.spanCount - a.spanCount || a.id.localeCompare(b.id)
}

/**
 * Convert a horizontal drag (two 0–1 fractions of the strip) into an absolute
 * window. Returns `null` for a drag too small to be a deliberate selection —
 * otherwise every stray click would zoom to a 2ms sliver.
 */
export function windowFromDrag(
  timeline: TraceTimeline,
  fromFraction: number,
  toFraction: number,
  minimumFraction = 0.02
): TimelineWindow | null {
  const lo = Math.min(fromFraction, toFraction)
  const hi = Math.max(fromFraction, toFraction)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  if (hi - lo < minimumFraction) return null
  const span = timeline.window.until - timeline.window.since
  if (span <= 0) return null
  return {
    since: timeline.window.since + span * Math.max(0, lo),
    until: timeline.window.since + span * Math.min(1, hi),
  }
}

/** True when the timeline is showing less than the whole trace. */
export function isZoomed(timeline: TraceTimeline): boolean {
  return timeline.window.since > timeline.traceStart || timeline.window.until < timeline.traceEnd
}
