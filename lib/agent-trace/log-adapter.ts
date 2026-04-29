/**
 * Agent-trace adapter — stub.
 *
 * Cognia's logging panel surfaces agent-trace events alongside regular log
 * entries (the "trace view" tab). cognia-next has no agent-trace subsystem
 * yet — when one lands, replace these no-ops with real adapters and the
 * panel's trace view will light up.
 */

import type { StructuredLogEntry } from "@/lib/logger"

/** Synthetic module name used by the panel's "agent trace only" filter. */
export const AGENT_TRACE_MODULE = "agent.trace"

export type AgentTraceEvent = Record<string, unknown> & { id?: string; timestamp?: string }
export type AgentTraceDbRow = AgentTraceEvent

/** No-op: returns null until a real agent-trace event source exists. */
export function agentTraceEventToLogEntry(_event: AgentTraceEvent): StructuredLogEntry | null {
  return null
}

/** No-op: returns null until persisted agent-trace history exists. */
export function dbAgentTraceToLogEntry(_row: AgentTraceDbRow): StructuredLogEntry | null {
  return null
}

/**
 * Shape of agent-trace data attached to a log entry's `data` payload — used by
 * the log detail panel's "Agent Trace Detail" section. Stubbed here since
 * cognia-next's agent-trace subsystem doesn't exist yet — `getAgentTraceLogData`
 * always returns null, so this type is only kept for the rendering code's
 * structural checks.
 */
export interface AgentTraceTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface AgentTraceCostEstimate {
  inputCost: number
  outputCost: number
  totalCost: number
}

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

/**
 * Extracts the agent-trace payload from a log entry. Returns null when the
 * entry is not an agent-trace event (i.e. always, until that subsystem ships).
 */
export function getAgentTraceLogData(_entry: StructuredLogEntry): AgentTraceLogData | null {
  return null
}
