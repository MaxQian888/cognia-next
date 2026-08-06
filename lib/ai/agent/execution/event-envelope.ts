// TS-side canonical envelope helpers (ADR-0090 Phase 3).
//
// The Claude/AI-SDK rails wrap events in the SIDECAR
// (`sidecar/dispatch/event-envelope.mjs` — same wire shape, pinned by the
// shared fixture). This module wraps the EXTERNAL rail (ExternalAgentManager
// events, which never pass through the sidecar) and provides the
// capture-layer narrowing from canonical events back to the legacy
// `CaptureStreamEvent` union.

import type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"
import {
  isAgentEventEnvelope,
  isKnownCanonicalAgentEventKind,
} from "@cognia/agent-config-types/agent-execution"

import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import { redactText } from "@cognia/redact"

export { isAgentEventEnvelope, isKnownCanonicalAgentEventKind }

export interface EnvelopeContext {
  sessionId: string
  runId: string
  attemptId: string
  parentRunId?: string
  hostRef: string
  runtime: string
  turnId: string
}

/** Stateful sequencer mirroring the sidecar emitter (one per attempt). */
export function createEnvelopeSequencer(context: EnvelopeContext) {
  let sequence = 0
  return function envelope(event: CanonicalAgentEvent): AgentEventEnvelope {
    const out: AgentEventEnvelope = {
      schemaVersion: 1,
      eventId: `${context.sessionId}:${context.attemptId}:${sequence}`,
      sequence,
      sessionId: context.sessionId,
      runId: context.runId,
      turnId: context.turnId,
      attemptId: context.attemptId,
      ...(context.parentRunId ? { parentRunId: context.parentRunId } : {}),
      hostRef: context.hostRef,
      runtime: context.runtime,
      timestamp: new Date().toISOString(),
      event,
    }
    sequence += 1
    return out
  }
}

/**
 * Map an external-agent stream event (`ExternalAgentEvent`-shaped) onto a
 * canonical event. Unknown kinds become controlled diagnostics — never
 * dropped silently.
 */
export function canonicalEventFromExternalEvent(event: {
  type: string
  [key: string]: unknown
}): CanonicalAgentEvent {
  switch (event.type) {
    case "text":
    case "text_delta":
      return { kind: "text-delta", delta: String(event.text ?? event.delta ?? "") }
    case "thinking":
    case "reasoning":
      return { kind: "thinking-delta", delta: String(event.text ?? event.delta ?? "") }
    case "commentary_delta":
      return {
        kind: "commentary-delta",
        delta: String(event.text ?? event.delta ?? ""),
        ...(typeof event.messageId === "string" ? { messageId: event.messageId } : {}),
        ...(typeof event.done === "boolean" ? { done: event.done } : {}),
      }
    case "tool_call":
      return {
        kind: "tool-call",
        toolName: String(event.name ?? event.toolName ?? "unknown"),
        input: (event.input as Record<string, unknown>) ?? {},
        toolCallId: typeof event.id === "string" ? event.id : undefined,
      }
    case "tool_result":
      return {
        kind: "tool-result",
        toolName: String(event.name ?? event.toolName ?? "unknown"),
        toolCallId: typeof event.id === "string" ? event.id : undefined,
        result: event.result,
        isError: event.isError === true,
      }
    case "permission_request":
      return {
        kind: "permission-request",
        requestId: String(event.requestId ?? ""),
        toolName: String(event.toolName ?? "unknown"),
        input: event.input as Record<string, unknown> | undefined,
      }
    case "session_started":
      return { kind: "lifecycle", phase: "started" }
    case "session_ended":
    case "turn_completed":
      return { kind: "lifecycle", phase: "ended" }
    case "error":
      return {
        kind: "failure",
        code: String(event.code ?? "external_error"),
        message: String(event.message ?? "external agent error"),
      }
    default:
      return { kind: "diagnostic", runtime: "external", payload: event }
  }
}

/**
 * Remove PII/credentials before a canonical envelope crosses the durable-log
 * boundary. Envelope ids and ordering metadata remain stable; only string
 * leaves in the canonical event are replaced with redaction placeholders.
 */
export function redactAgentEventEnvelope(envelope: AgentEventEnvelope): AgentEventEnvelope {
  const serialized = JSON.stringify(envelope.event)
  const redacted = redactText(serialized).redacted
  return { ...envelope, event: JSON.parse(redacted) as CanonicalAgentEvent }
}

/**
 * Narrow a canonical event back to the legacy capture union. Returns null
 * for kinds the capture layer has no representation for (lifecycle,
 * permission plumbing, diagnostics) — those stay envelope-only.
 */
export function captureEventFromCanonical(event: CanonicalAgentEvent): CaptureStreamEvent | null {
  switch (event.kind) {
    case "text-delta":
      return { type: "text-delta", delta: event.delta }
    case "thinking-delta":
      return { type: "thinking-delta", delta: event.delta }
    case "commentary-delta":
      return {
        type: "commentary-delta",
        delta: event.delta,
        ...(event.messageId ? { messageId: event.messageId } : {}),
        ...(typeof event.done === "boolean" ? { done: event.done } : {}),
      }
    case "tool-call":
      return {
        type: "tool-call",
        toolName: event.toolName,
        input: event.input,
        id: event.toolCallId,
      }
    case "tool-result":
      return {
        type: "tool-result",
        toolName: event.toolName,
        id: event.toolCallId,
        input: event.input,
        result: event.result,
        isError: event.isError,
      }
    case "tool-summary":
      return {
        type: "tool-summary",
        summary: event.summary,
        toolCallIds: event.toolCallIds,
      }
    case "usage":
      return {
        type: "usage",
        usage: event.usage as CaptureStreamEvent extends { usage: infer U } ? U : never,
        partial: event.partial,
      } as CaptureStreamEvent
    case "compact":
      return {
        type: "compact",
        trigger: event.trigger,
        preTokens: event.preTokens ?? 0,
        postTokens: event.postTokens ?? 0,
      }
    default:
      return null
  }
}
