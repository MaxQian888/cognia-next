/**
 * Agent-trace adapter.
 *
 * Bridges between the agent-trace emitter / Dexie persistence layer and the
 * unified-log panel's existing rendering primitives.
 *
 * - `agentTraceEventToLogEntry` and `dbAgentTraceToLogEntry` accept span
 *   payloads (in-memory event or Dexie row — both are `AgentTraceSpan`-shaped
 *   today) and produce the `StructuredLogEntry` shape consumed by the log
 *   panel + transports. They return `null` for anything that isn't a span,
 *   preserving the legacy stub semantics.
 * - `getAgentTraceLogData` projects a `StructuredLogEntry` produced by the
 *   above converters back down into the `AgentTraceLogData` shape that the
 *   "Agent Trace Detail" section in the log-detail panel already renders.
 */

import type { StructuredLogEntry } from "@/lib/logging"
import {
  AGENT_TRACE_MODULE,
  extractSpanFromLogEntry,
  isAgentTraceSpanShape,
  spanToLogEntry,
} from "./span-to-log-entry"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

export { AGENT_TRACE_MODULE }

/** Generic in-memory event shape kept for legacy callers (the panel passes
 * arbitrary `Record<string, unknown>` through this adapter). When the event
 * is span-shaped, we convert; otherwise we return null. */
export type AgentTraceEvent = Record<string, unknown> & { id?: string; timestamp?: string }
export type AgentTraceDbRow = AgentTraceEvent

/** Convert an in-memory agent-trace event (currently always span-shaped) to
 * a `StructuredLogEntry`. */
export function agentTraceEventToLogEntry(event: AgentTraceEvent): StructuredLogEntry | null {
  return spanLikeToEntry(event)
}

/** Convert a persisted agent-trace row (`AgentTraceSpan` in Dexie v55) to a
 * `StructuredLogEntry`. */
export function dbAgentTraceToLogEntry(row: AgentTraceDbRow): StructuredLogEntry | null {
  return spanLikeToEntry(row)
}

function spanLikeToEntry(value: unknown): StructuredLogEntry | null {
  if (!isAgentTraceSpanShape(value)) return null
  return spanToLogEntry(value)
}

/** Token usage in the shape the legacy log-detail-panel renderer expects. */
export interface AgentTraceTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Cost estimate in the shape the legacy renderer expects. The SDK only
 * reports a single combined cost; we surface it as `totalCost` and leave
 * the per-side breakdown at 0 (the renderer hides 0 rows). */
export interface AgentTraceCostEstimate {
  inputCost: number
  outputCost: number
  totalCost: number
}

/** Shape attached to `StructuredLogEntry.data` when surfaced through this
 * adapter. Mirrors the renderer's existing structural checks. */
export interface AgentTraceLogData {
  eventType?: string
  toolName?: string
  toolArgs?: string
  duration?: number
  tokenUsage?: AgentTraceTokenUsage
  costEstimate?: AgentTraceCostEstimate
  error?: string
  responsePreview?: string
  files?: string[]
  modelId?: string
  stepNumber?: number
  success?: boolean
}

/** Extract the agent-trace payload out of a unified log entry for the log
 * detail panel. Returns null for entries that didn't originate from a span. */
export function getAgentTraceLogData(entry: StructuredLogEntry): AgentTraceLogData | null {
  const span = extractSpanFromLogEntry(entry)
  if (!span) return null
  return spanToLogData(span)
}

function spanToLogData(span: AgentTraceSpan): AgentTraceLogData {
  const tokenUsage: AgentTraceTokenUsage | undefined = span.usage
    ? {
        promptTokens: span.usage.inputTokens,
        completionTokens: span.usage.outputTokens,
        totalTokens: span.usage.inputTokens + span.usage.outputTokens,
      }
    : undefined

  const costEstimate: AgentTraceCostEstimate | undefined =
    typeof span.costUsdEstimate === "number" && span.costUsdEstimate > 0
      ? { inputCost: 0, outputCost: 0, totalCost: span.costUsdEstimate }
      : undefined

  const modelId = span.responseModel ?? span.requestModel
  const success = !(span.errorType || span.errorMessage)

  return {
    eventType: span.operationName,
    toolName: span.toolName,
    duration: span.durationMs,
    tokenUsage,
    costEstimate,
    error: span.errorMessage,
    responsePreview: span.outputPreview,
    modelId,
    success,
  }
}
