/**
 * Variable/filter-bar logic for the observability dashboard.
 *
 * Filters are applied client-side over the already-windowed span set (the
 * windowed Dexie read happens in `lib/db/agent-traces.ts:queryByWindow`).
 * Semantics: AND across dimensions, OR within a dimension — the standard
 * Grafana template-variable behavior.
 */

import type { AgentTraceSpan, SpanOperationName, SpanSurface } from "@/types/agent-trace/span"
import { modelKeyOf } from "./model-key"

export interface TraceFilters {
  model?: string[]
  surface?: SpanSurface[]
  operation?: SpanOperationName[]
  tool?: string[]
  session?: string[]
}

/** True when no dimension narrows the set. */
export function isFilterEmpty(f: TraceFilters): boolean {
  return (
    !f.model?.length &&
    !f.surface?.length &&
    !f.operation?.length &&
    !f.tool?.length &&
    !f.session?.length
  )
}

function matches<T extends string>(selected: T[] | undefined, value: T | undefined): boolean {
  if (!selected || selected.length === 0) return true
  if (value === undefined) return false
  return selected.includes(value)
}

/** Apply all active filter dimensions (AND across dims, OR within a dim). */
export function applyFilters(spans: AgentTraceSpan[], f: TraceFilters): AgentTraceSpan[] {
  if (isFilterEmpty(f)) return spans
  return spans.filter(
    (s) =>
      matches(f.model, modelKeyOf(s)) &&
      matches(f.surface, s.surface) &&
      matches(f.operation, s.operationName) &&
      matches(f.tool, s.toolName) &&
      matches(f.session, s.sessionId)
  )
}
