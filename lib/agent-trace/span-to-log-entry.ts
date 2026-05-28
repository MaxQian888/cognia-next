/**
 * Pure converters between `AgentTraceSpan` and `StructuredLogEntry`.
 *
 * The agent-trace transport persists spans to Dexie in their native shape;
 * the log panel renders them as regular log entries via the trace view tab.
 * Both paths go through `spanToLogEntry` so the UI never sees the raw span
 * shape — it sees a normal `StructuredLogEntry` with the span tucked into
 * `data.span` for the detail panel.
 *
 * Phase 2 will add `spanToOtlpAttributes` next to this file when the OTLP
 * exporter lands; the `gen_ai.*` ↔ camelCase mapping table belongs there,
 * not here, so this module stays UI-shaped.
 */

import type { StructuredLogEntry } from "@/types/logging"
import {
  AGENT_TRACE_SPAN_KIND,
  type AgentTraceSpan,
  type AgentTraceSpanLogPayload,
} from "@/types/agent-trace/span"

/** Module name used by the log panel's "agent trace only" preset filter. */
export const AGENT_TRACE_MODULE = "agent.trace"

/**
 * Type-guard: returns true when an unknown value carries the required span
 * fields. We don't validate every field — just the structural identity bits
 * (`spanId`, `traceId`, `operationName`, `sessionId`, `startTime`) plus the
 * `id` primary key. Callers (adapters) use this to opt-in to conversion.
 */
export function isAgentTraceSpanShape(value: unknown): value is AgentTraceSpan {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    typeof v.spanId === "string" &&
    typeof v.traceId === "string" &&
    typeof v.operationName === "string" &&
    typeof v.sessionId === "string" &&
    typeof v.startTime === "number"
  )
}

/**
 * Convert a finished span into the unified-logger entry shape consumed by
 * the log panel + downstream transports. The full span is preserved under
 * `data.span` so the detail panel can render every field without losing
 * fidelity (`StructuredLogEntry.data` is the conventional escape hatch for
 * payload-rich entries).
 */
export function spanToLogEntry(span: AgentTraceSpan): StructuredLogEntry {
  const isError = Boolean(span.errorType || span.errorMessage)
  const payload: AgentTraceSpanLogPayload = { kind: AGENT_TRACE_SPAN_KIND, span }
  return {
    id: span.id,
    timestamp: new Date(span.startTime).toISOString(),
    level: isError ? "error" : "info",
    message: formatSpanMessage(span),
    module: AGENT_TRACE_MODULE,
    traceId: span.traceId,
    sessionId: span.sessionId,
    data: payload as unknown as Record<string, unknown>,
    tags: buildSpanTags(span),
  }
}

function buildSpanTags(span: AgentTraceSpan): string[] {
  const tags: string[] = [`surface:${span.surface}`, `op:${span.operationName}`]
  if (span.providerName) tags.push(`provider:${span.providerName}`)
  if (span.toolName) tags.push(`tool:${span.toolName}`)
  if (span.pluginId) tags.push(`plugin:${span.pluginId}`)
  if (span.agentId) tags.push(`agent:${span.agentId}`)
  if (span.errorType) tags.push(`error:${span.errorType}`)
  return tags
}

function formatSpanMessage(span: AgentTraceSpan): string {
  const parts: string[] = [`[${span.operationName}]`]
  if (span.toolName) parts.push(span.toolName)
  if (span.agentName) parts.push(span.agentName)
  else if (span.agentId) parts.push(span.agentId)
  if (span.responseModel) parts.push(`model=${span.responseModel}`)
  else if (span.requestModel) parts.push(`model=${span.requestModel}`)
  if (typeof span.durationMs === "number") parts.push(`${span.durationMs}ms`)
  if (typeof span.costUsdEstimate === "number" && span.costUsdEstimate > 0) {
    parts.push(`$${span.costUsdEstimate.toFixed(4)}`)
  }
  if (span.usage) {
    parts.push(`tokens=${span.usage.inputTokens}/${span.usage.outputTokens}`)
    if (span.usage.cacheReadTokens > 0) parts.push(`cacheRead=${span.usage.cacheReadTokens}`)
  }
  if (span.errorMessage) parts.push(`error: ${span.errorMessage}`)
  return parts.join(" ")
}

/** Extract the embedded `AgentTraceSpan` from an entry produced by
 * `spanToLogEntry`. Returns null when the entry isn't a span entry. */
export function extractSpanFromLogEntry(entry: StructuredLogEntry): AgentTraceSpan | null {
  const data = entry.data as Record<string, unknown> | undefined
  if (!data || data.kind !== AGENT_TRACE_SPAN_KIND) return null
  const span = data.span
  if (!isAgentTraceSpanShape(span)) return null
  return span
}
