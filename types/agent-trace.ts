/**
 * Minimal agent-trace stubs.
 *
 * cognia-next has no agent-trace subsystem yet. The types exported here
 * give migrated agent code (lib/agent/utils.ts, lib/db/index.ts, the
 * external-agent settings page) enough surface to typecheck without
 * pulling in an observability runtime. Replace if/when agent-trace is
 * actually migrated.
 */

export type AgentTraceEventType =
  | "session_start"
  | "session_end"
  | "tool_call"
  | "tool_result"
  | "message"
  | "error"
  | "info"
  | string

export interface AgentTraceCostEstimate {
  totalCost?: number
  inputCost?: number
  outputCost?: number
  cacheCost?: number
}

export interface AgentTraceFileTouch {
  path: string
  bytes?: number
  action?: "read" | "write" | "delete"
}

export interface AgentTraceRecord {
  id: string
  sessionId: string
  type: AgentTraceEventType
  /** Optional richer event-type tag used by the trace UI helpers. */
  eventType?: string
  /** Step the event belongs to, if any. */
  stepId?: string
  timestamp: number
  /** Wall-clock duration in ms, when known. */
  duration?: number
  /** Cost estimate (USD), when the runtime can compute one. */
  costEstimate?: AgentTraceCostEstimate
  /** Files touched during this trace event. */
  files: AgentTraceFileTouch[]
  /** Free-form metadata bag. */
  metadata?: Record<string, unknown>
  data?: Record<string, unknown>
}

export interface SessionObservationSummary {
  sessionId: string
  startedAt?: number
  endedAt?: number
  eventCount: number
  errorCount: number
  toolCount: number
  health?: "ok" | "degraded" | "error" | "unknown"
}
