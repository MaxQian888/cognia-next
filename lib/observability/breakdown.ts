/**
 * Per-dimension rollups for the donut / bar breakdown panels and the
 * filter-bar option lists.
 */

import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { modelKeyOf } from "./model-key"

export type Dimension = "model" | "surface" | "operation" | "tool" | "session"

export interface BreakdownRow {
  key: string
  spans: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  errors: number
  avgLatencyMs: number
}

/** Which measure a breakdown panel plots — user-switchable at the panel. */
export type BreakdownMetric = "spans" | "cost" | "errors"

/** Read the selected measure off a breakdown row. */
export function breakdownValue(row: BreakdownRow, metric: BreakdownMetric): number {
  switch (metric) {
    case "cost":
      return row.costUsd
    case "errors":
      return row.errors
    default:
      return row.spans
  }
}

/** Top-N rows sorted by the selected measure (desc), tie-broken by key. */
export function topByMetric(
  rows: BreakdownRow[],
  metric: BreakdownMetric,
  n: number
): BreakdownRow[] {
  return [...rows]
    .sort(
      (a, b) => breakdownValue(b, metric) - breakdownValue(a, metric) || a.key.localeCompare(b.key)
    )
    .slice(0, n)
}

/** Resolve a span's value for a dimension. Returns null when absent (e.g. a
 * non-tool span under the "tool" dimension) so it's skipped from rollups. */
function dimValue(span: AgentTraceSpan, dim: Dimension): string | null {
  switch (dim) {
    case "model":
      return modelKeyOf(span)
    case "surface":
      return span.surface
    case "operation":
      return span.operationName
    case "tool":
      return span.toolName ?? null
    case "session":
      return span.sessionId
  }
}

function isError(span: AgentTraceSpan): boolean {
  return Boolean(span.errorType || span.errorMessage)
}

/** Group spans by a dimension, sorted by span count descending. */
export function breakdownBy(spans: AgentTraceSpan[], dim: Dimension): BreakdownRow[] {
  const map = new Map<string, BreakdownRow & { _latencySum: number; _latencyCount: number }>()
  for (const s of spans) {
    const key = dimValue(s, dim)
    if (key === null) continue
    let row = map.get(key)
    if (!row) {
      row = {
        key,
        spans: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        errors: 0,
        avgLatencyMs: 0,
        _latencySum: 0,
        _latencyCount: 0,
      }
      map.set(key, row)
    }
    row.spans += 1
    if (typeof s.costUsdEstimate === "number") row.costUsd += s.costUsdEstimate
    if (s.usage) {
      row.inputTokens += s.usage.inputTokens
      row.outputTokens += s.usage.outputTokens
    }
    if (isError(s)) row.errors += 1
    if (typeof s.durationMs === "number") {
      row._latencySum += s.durationMs
      row._latencyCount += 1
    }
  }
  const rows: BreakdownRow[] = []
  for (const row of map.values()) {
    row.avgLatencyMs = row._latencyCount > 0 ? row._latencySum / row._latencyCount : 0
    const { _latencySum, _latencyCount, ...clean } = row
    void _latencySum
    void _latencyCount
    rows.push(clean)
  }
  rows.sort((a, b) => b.spans - a.spans || a.key.localeCompare(b.key))
  return rows
}

/** Distinct values present for a dimension, sorted alphabetically. Used to
 * populate the filter-bar option lists from the windowed span set. */
export function distinctValues(spans: AgentTraceSpan[], dim: Dimension): string[] {
  const set = new Set<string>()
  for (const s of spans) {
    const v = dimValue(s, dim)
    if (v !== null) set.add(v)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}
