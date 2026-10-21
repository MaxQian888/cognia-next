/**
 * The plugin contract's share of `lib/observability/trace-timeline.ts`, which re-exports these.
 */
import type { SpanOperationName, SpanSurface } from "../../types/agent-trace/span"

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
  /** The span's own surface — one of the three fields the channel's search
   * matches (`lib/observability/trace-search.ts`). */
  surface: SpanSurface
  /** Same for every block in a timeline; carried so a block can be matched on
   * its own without the caller threading the trace id alongside. */
  traceId: string
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
