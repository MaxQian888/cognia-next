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
      eventId: `${context.sessionId}:${context.turnId}:${context.attemptId}:${sequence}`,
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

export type EnvelopeOrderObservation =
  | { kind: "accept" }
  | { kind: "duplicate" }
  | { kind: "gap"; expectedSequence: number; receivedSequence: number }

/**
 * Track at-least-once canonical delivery by the full ordering scope. Sequence
 * numbers are only comparable inside one session/turn/attempt tuple; treating
 * attemptId alone as global can suppress a later turn that reused it.
 */
export function createEnvelopeOrderTracker(): {
  observe(envelope: AgentEventEnvelope): EnvelopeOrderObservation
} {
  const nextByAttempt = new Map<string, number>()
  return {
    observe(envelope) {
      const key = `${envelope.sessionId}\u001f${envelope.turnId}\u001f${envelope.attemptId}`
      const expected = nextByAttempt.get(key) ?? 0
      if (envelope.sequence < expected) return { kind: "duplicate" }
      nextByAttempt.set(key, envelope.sequence + 1)
      if (envelope.sequence > expected) {
        return {
          kind: "gap",
          expectedSequence: expected,
          receivedSequence: envelope.sequence,
        }
      }
      return { kind: "accept" }
    },
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

/** Map the legacy capture union into the canonical log without re-parsing wire events. */
export function canonicalEventFromCaptureEvent(
  event: CaptureStreamEvent
): CanonicalAgentEvent | null {
  switch (event.type) {
    case "text-delta":
      return { kind: "text-delta", delta: event.delta }
    case "thinking-delta":
      return { kind: "thinking-delta", delta: event.delta }
    case "commentary-delta":
      return {
        kind: "commentary-delta",
        delta: event.delta,
        ...(event.messageId ? { messageId: event.messageId } : {}),
        ...(typeof event.done === "boolean" ? { done: event.done } : {}),
      }
    case "tool-call":
      return {
        kind: "tool-call",
        toolName: event.toolName,
        input: event.input,
        ...(event.id ? { toolCallId: event.id } : {}),
      }
    case "tool-result":
      return {
        kind: "tool-result",
        toolName: event.toolName,
        ...(event.id ? { toolCallId: event.id } : {}),
        ...(event.input ? { input: event.input } : {}),
        result: event.result,
        ...(typeof event.isError === "boolean" ? { isError: event.isError } : {}),
      }
    case "usage":
      return {
        kind: "usage",
        usage: { ...event.usage },
        ...(event.partial ? { partial: true } : {}),
      }
    case "compact":
      return {
        kind: "compact",
        trigger: event.trigger,
        preTokens: event.preTokens,
        postTokens: event.postTokens,
      }
    case "tool-summary":
      return null
  }
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
