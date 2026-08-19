/**
 * Shared `AgentTraceSpan` factory for observability unit tests.
 *
 * Lives in source (not a `*.test.ts`) so every pure-module test can build
 * spans without duplicating the boilerplate. Exercised by the co-located
 * tests, so it carries its own coverage.
 */

import type { AgentTraceSpan } from "@/types/agent-trace/span"

let seq = 0

/** Build a finished span with sensible defaults; override any field. */
export function makeSpan(partial: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  seq += 1
  const startTime = partial.startTime ?? 1_700_000_000_000 + seq * 1000
  const durationMs = partial.durationMs ?? 100
  const id = partial.id ?? partial.spanId ?? `span-${seq}`
  return {
    id,
    traceId: partial.traceId ?? `trace-${seq}`,
    spanId: partial.spanId ?? id,
    parentSpanId: partial.parentSpanId,
    startTime,
    endTime: partial.endTime ?? startTime + durationMs,
    durationMs,
    operationName: partial.operationName ?? "chat",
    providerName: partial.providerName ?? "anthropic",
    requestModel: partial.requestModel,
    responseModel: partial.responseModel,
    agentId: partial.agentId,
    agentName: partial.agentName,
    toolName: partial.toolName,
    usage: partial.usage,
    costUsdEstimate: partial.costUsdEstimate,
    finishReasons: partial.finishReasons,
    errorType: partial.errorType,
    errorMessage: partial.errorMessage,
    // v172 lifecycle/identity fields. Optional on the type (pre-v172 rows
    // lack them), so they pass through only when a test asks for them.
    spanKind: partial.spanKind,
    status: partial.status,
    runId: partial.runId,
    turnId: partial.turnId,
    attemptId: partial.attemptId,
    projectId: partial.projectId,
    sessionId: partial.sessionId ?? "session-1",
    surface: partial.surface ?? "chat",
    pluginId: partial.pluginId,
    handoff: partial.handoff,
    events: partial.events,
    inputPreview: partial.inputPreview,
    outputPreview: partial.outputPreview,
    metadata: partial.metadata,
  }
}
