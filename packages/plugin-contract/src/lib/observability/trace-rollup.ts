/**
 * The plugin contract's share of `lib/observability/trace-rollup.ts`, which re-exports these.
 */
import type { AgentTraceSpan } from "../../types/agent-trace/span"

export interface TraceRollupRow {
  traceId: string
  /** Name of the earliest-starting (root-ish) span, raw (`invoke_agent · Planner`)
   * — what CSV export and search carry. */
  rootName: string
  /** The root span's name parts, so the UI can translate the operation. */
  rootOperation: string
  rootAgentName?: string
  rootToolName?: string
  startTime: number
  /** Wall-clock span of the whole trace (last end − first start). */
  durationMs: number
  spanCount: number
  errorCount: number
  totalCostUsd: number
  surface: string
}

export interface WaterfallNode {
  span: AgentTraceSpan
  label: string
  depth: number
  /** ms from trace start to this span's start. */
  offsetMs: number
  /** this span's duration in ms (>= 0). */
  widthMs: number
  isError: boolean
  children: WaterfallNode[]
}

export interface Waterfall {
  roots: WaterfallNode[]
  traceStart: number
  traceEnd: number
  totalMs: number
}
