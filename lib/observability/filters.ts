/**
 * Variable/filter-bar logic for the observability dashboard.
 *
 * Filters are applied client-side over the already-windowed span set (the
 * windowed Dexie read happens in `lib/db/agent-traces.ts:queryByWindow`).
 * Semantics: AND across dimensions, OR within a dimension — the standard
 * Grafana template-variable behavior.
 */

import type { AgentTraceSpan, SpanOperationName, SpanSurface } from "@/types/agent-trace/span"
import type { Dimension } from "./breakdown"
import { modelKeyOf } from "./model-key"

export interface TraceFilters {
  model?: string[]
  surface?: SpanSurface[]
  operation?: SpanOperationName[]
  tool?: string[]
  session?: string[]
  /** Cost-attribution dimensions (ADR-0130). */
  provider?: string[]
  project?: string[]
}

/**
 * Pure toggle: add/remove `value` from the given dimension's selection,
 * dropping a dimension entirely once its last value is removed so
 * `isFilterEmpty` stays accurate. Shared by the variable-filter bar and the
 * click-to-filter breakdown panels (donut / bar).
 */
export function toggleFilterValue(
  filters: TraceFilters,
  dim: Dimension,
  value: string
): TraceFilters {
  const current = (filters[dim] as string[] | undefined) ?? []
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
  const out: TraceFilters = { ...filters }
  if (next.length === 0) delete out[dim]
  else (out[dim] as string[]) = next
  return out
}

/** True when `value` is currently selected under `dim`. */
export function isValueSelected(filters: TraceFilters, dim: Dimension, value: string): boolean {
  return ((filters[dim] as string[] | undefined) ?? []).includes(value)
}

/** True when no dimension narrows the set. */
export function isFilterEmpty(f: TraceFilters): boolean {
  return (
    !f.model?.length &&
    !f.surface?.length &&
    !f.operation?.length &&
    !f.tool?.length &&
    !f.session?.length &&
    !f.provider?.length &&
    !f.project?.length
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
      matches(f.session, s.sessionId) &&
      // Same resolution as the breakdown dimension: the raw provider id when
      // the emitter kept one, else the OTel vendor name.
      matches(
        f.provider,
        typeof s.metadata?.providerId === "string" ? s.metadata.providerId : s.providerName
      ) &&
      matches(f.project, s.projectId)
  )
}
