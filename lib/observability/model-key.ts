/**
 * Canonical model key for a span. Mirrors the derivation in
 * `lib/db/agent-traces.ts:aggregateStats` so the dashboard's filter, breakdown
 * and series layers all bucket models identically.
 */

import type { AgentTraceSpan } from "@/types/agent-trace/span"

/** Sentinel used when a span carries no model identity. */
export const UNKNOWN_MODEL = "(unknown)" as const

export function modelKeyOf(span: AgentTraceSpan): string {
  return span.responseModel ?? span.requestModel ?? UNKNOWN_MODEL
}
