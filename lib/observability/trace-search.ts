/**
 * The ONE text matcher behind the Traces channel's search box.
 *
 * The box filters the trace LIST (`useTraceList`) and, once a trace is open,
 * highlights blocks in its TIMELINE (`TraceTimeline`). Those two used to run
 * different matchers — the list compared root name / trace id / surface, the
 * timeline compared block label / operation id / span id — so typing a surface
 * kept a trace in the list and then dimmed every block in it, and typing a span
 * id highlighted a block in a trace the list had just hidden. Both now ask the
 * same three questions of whatever they are looking at:
 *
 *   name     the trace's root label (list) or the block's label (timeline)
 *   traceId  identical for every span in a trace, so an id search lights the
 *            whole timeline — the trace IS the match
 *   surface  the trace root's surface (list) or the span's own (timeline)
 *
 * Pure, case-insensitive, whitespace-trimmed.
 */

export interface TraceSearchFields {
  name: string
  traceId: string
  surface: string
}

/** Normalize raw input once; an empty needle matches everything. */
export function normalizeTraceQuery(query: string): string {
  return query.trim().toLowerCase()
}

/** True when `fields` match an already-normalized `needle`. */
export function matchesTraceQuery(fields: TraceSearchFields, needle: string): boolean {
  if (needle.length === 0) return true
  return (
    fields.name.toLowerCase().includes(needle) ||
    fields.traceId.toLowerCase().includes(needle) ||
    fields.surface.toLowerCase().includes(needle)
  )
}
