/**
 * Trace-level rollups.
 *
 *  - `rollupTraces` groups the windowed spans by `traceId` into one row per
 *    trace for the "recent traces" table.
 *  - `buildWaterfall` turns one trace's spans (from
 *    `lib/db/agent-traces.ts:queryByTrace`, already oldest-first) into a
 *    parent/child tree with offset/width geometry for the Tempo-style drawer.
 */

import type { AgentTraceSpan } from "@/types/agent-trace/span"

export interface TraceRollupRow {
  traceId: string
  /** Name of the earliest-starting (root-ish) span. */
  rootName: string
  startTime: number
  /** Wall-clock span of the whole trace (last end − first start). */
  durationMs: number
  spanCount: number
  errorCount: number
  totalCostUsd: number
  surface: string
}

function isError(span: AgentTraceSpan): boolean {
  return Boolean(span.errorType || span.errorMessage)
}

function spanLabel(span: AgentTraceSpan): string {
  if (span.operationName === "execute_tool" && span.toolName) return span.toolName
  if (span.agentName) return `${span.operationName} · ${span.agentName}`
  return span.operationName
}

/** One row per trace, newest-first. */
export function rollupTraces(spans: AgentTraceSpan[]): TraceRollupRow[] {
  const groups = new Map<string, AgentTraceSpan[]>()
  for (const s of spans) {
    const arr = groups.get(s.traceId)
    if (arr) arr.push(s)
    else groups.set(s.traceId, [s])
  }
  const rows: TraceRollupRow[] = []
  for (const [traceId, group] of groups) {
    let minStart = Number.POSITIVE_INFINITY
    let maxEnd = Number.NEGATIVE_INFINITY
    let errorCount = 0
    let totalCostUsd = 0
    let root = group[0]
    for (const s of group) {
      if (s.startTime < minStart) {
        minStart = s.startTime
        root = s
      }
      const end = s.endTime ?? s.startTime + (s.durationMs ?? 0)
      if (end > maxEnd) maxEnd = end
      if (isError(s)) errorCount += 1
      totalCostUsd += s.costUsdEstimate ?? 0
    }
    rows.push({
      traceId,
      rootName: spanLabel(root),
      startTime: minStart,
      durationMs: Math.max(0, maxEnd - minStart),
      spanCount: group.length,
      errorCount,
      totalCostUsd,
      surface: root.surface,
    })
  }
  rows.sort((a, b) => b.startTime - a.startTime)
  return rows
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

/**
 * Build the span tree for one trace. Spans whose parent is missing from the
 * set (or who point at themselves) become roots. A visited-set guards against
 * cyclic `parentSpanId` chains.
 */
export function buildWaterfall(traceSpans: AgentTraceSpan[]): Waterfall {
  if (traceSpans.length === 0) {
    return { roots: [], traceStart: 0, traceEnd: 0, totalMs: 0 }
  }

  const byId = new Map<string, AgentTraceSpan>()
  for (const s of traceSpans) byId.set(s.spanId, s)

  let traceStart = Number.POSITIVE_INFINITY
  let traceEnd = Number.NEGATIVE_INFINITY
  for (const s of traceSpans) {
    if (s.startTime < traceStart) traceStart = s.startTime
    const end = s.endTime ?? s.startTime + (s.durationMs ?? 0)
    if (end > traceEnd) traceEnd = end
  }

  const childrenOf = new Map<string, AgentTraceSpan[]>()
  const roots: AgentTraceSpan[] = []
  for (const s of traceSpans) {
    const parentId = s.parentSpanId
    const hasParent = parentId !== undefined && parentId !== s.spanId && byId.has(parentId)
    if (hasParent) {
      const arr = childrenOf.get(parentId!)
      if (arr) arr.push(s)
      else childrenOf.set(parentId!, [s])
    } else {
      roots.push(s)
    }
  }

  const sortByStart = (a: AgentTraceSpan, b: AgentTraceSpan) => a.startTime - b.startTime

  const visited = new Set<string>()
  const toNode = (span: AgentTraceSpan, depth: number): WaterfallNode => {
    visited.add(span.spanId)
    const kids = (childrenOf.get(span.spanId) ?? [])
      .filter((c) => !visited.has(c.spanId))
      .sort(sortByStart)
    return {
      span,
      label: spanLabel(span),
      depth,
      offsetMs: Math.max(0, span.startTime - traceStart),
      widthMs: Math.max(0, span.durationMs ?? (span.endTime ?? span.startTime) - span.startTime),
      isError: isError(span),
      children: kids.map((c) => toNode(c, depth + 1)),
    }
  }

  const rootNodes = roots.sort(sortByStart).map((r) => toNode(r, 0))
  return {
    roots: rootNodes,
    traceStart,
    traceEnd,
    totalMs: Math.max(0, traceEnd - traceStart),
  }
}

/** Flatten a waterfall into pre-order rows for list rendering. */
export function flattenWaterfall(wf: Waterfall): WaterfallNode[] {
  const out: WaterfallNode[] = []
  const walk = (node: WaterfallNode) => {
    out.push(node)
    for (const c of node.children) walk(c)
  }
  for (const r of wf.roots) walk(r)
  return out
}
