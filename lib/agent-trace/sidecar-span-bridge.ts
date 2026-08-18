/**
 * Repatriate sidecar spans into the local `agentTraces` store.
 *
 * The sidecar measures the out-of-process half of every turn, but until now it
 * could only *export* those spans — through the OTel SDK, which only starts
 * when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set. A default install
 * configures no collector, so the renderer's waterfall showed a chat span with
 * a multi-second hole in the middle and nothing to put in it.
 *
 * `sidecar/telemetry.mjs` now also emits each finished span back over the
 * existing `ClaudeEvent` channel. This module turns those events into real
 * spans through the ordinary emitter, so they land in Dexie, the waterfall, and
 * any configured OTLP export by exactly the same path as renderer-side spans.
 *
 * Shaped after `lib/mcp/log-bridge.ts`, which does the same for `mcp_log`.
 */

import { onClaudeMessage } from "@/lib/claude/ipc"
import { isAgentTraceSpanEvent, type AgentTraceSpanEvent } from "@cognia/agent-config-types"
import { emitFinishedSpan, providerNameFromId } from "@cognia/agent-trace"
import type { AgentTraceSpan, SpanOperationName } from "@/types/agent-trace/span"

import { parseTraceparent } from "./trace-context"

const KNOWN_OPERATIONS: ReadonlySet<string> = new Set([
  "invoke_agent",
  "execute_tool",
  "chat",
  "invoke_workflow",
  "retrieval",
  "embeddings",
])

function operationOf(event: AgentTraceSpanEvent): SpanOperationName {
  const name = event.operationName
  return name && KNOWN_OPERATIONS.has(name) ? (name as SpanOperationName) : "invoke_agent"
}

/**
 * Build the local span for one repatriated event, or `null` when it cannot be
 * attached to a trace.
 *
 * A span with no parseable `traceparent` is DROPPED rather than given a fresh
 * trace id: a sidecar span that is not under the turn that spawned it is worse
 * than no span — it appears in the trace list as a second, phantom trace for
 * work that already has one.
 */
export function spanFromSidecarEvent(event: AgentTraceSpanEvent): Partial<AgentTraceSpan> | null {
  if (!event.spanId || typeof event.startTime !== "number") return null
  const parent = event.traceparent ? parseTraceparent(event.traceparent) : null
  if (!parent) return null
  return {
    spanId: event.spanId,
    id: event.spanId,
    traceId: parent.traceId,
    parentSpanId: parent.rootSpanId,
    startTime: event.startTime,
    ...(typeof event.endTime === "number" ? { endTime: event.endTime } : {}),
    ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
    operationName: operationOf(event),
    providerName: providerNameFromId(event.providerName ?? "anthropic"),
    sessionId: event.sessionId ?? "",
    surface: "chat",
    // The sidecar is the RECEIVING side of the renderer → sidecar hop. Marking
    // it `server` is what lets a backend render the hop as a distributed trace
    // instead of two unrelated internal spans.
    spanKind: "server",
    status: event.errorType ? "error" : "ok",
    ...(event.errorType ? { errorType: event.errorType } : {}),
    ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
    metadata: {
      origin: "sidecar",
      ...(event.name ? { spanName: event.name } : {}),
      ...(event.attributes ?? {}),
    },
  }
}

/** Turn one repatriated event into a persisted span. Returns whether it landed. */
export function forwardSidecarSpan(event: AgentTraceSpanEvent): boolean {
  const span = spanFromSidecarEvent(event)
  if (!span) return false
  // `emitFinishedSpan` (not start/end) because the sidecar already measured the
  // work — re-timing it with the renderer's clock would report the IPC latency
  // as part of the model call.
  return emitFinishedSpan(span) !== null
}

/**
 * Subscribe to live sidecar spans. Returns the same `Unlisten` shape Tauri uses
 * elsewhere. Outside Tauri `onClaudeMessage` has no IPC listener, so callers
 * guard with `isTauri()` upstream.
 */
export async function subscribeToSidecarSpans(): Promise<() => void> {
  return onClaudeMessage((evt) => {
    if (!isAgentTraceSpanEvent(evt)) return
    forwardSidecarSpan(evt)
  })
}
