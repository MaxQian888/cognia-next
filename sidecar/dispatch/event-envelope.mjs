// Canonical agent-event envelope emitter (ADR-0090 Phase 3, plan §3.5).
//
// Wraps the raw dispatcher messages the host already emits into
// `AgentEventEnvelope` frames (`{ type: "agent_event", envelope }`) with
// monotonic per-attempt sequencing and idempotency-keyed event ids. The raw
// legacy messages keep flowing unchanged — envelope emission is ADDITIVE and
// only active for sessions that carry a frozen execution spec, so legacy
// sessions pay nothing.
//
// The envelope field shape is pinned against the TS side
// (`@cognia/agent-config-types/agent-execution`) by the shared fixture in
// `event-envelope.test.mjs` / `lib/ai/agent/execution/event-envelope.test.ts`.

import { canonicalEventsFromSdkMessage, createSdkMappingState } from "./sdk-canonical-events.mjs"

/**
 * Map one raw sidecar wire message to zero or more CanonicalAgentEvents.
 * Messages with no canonical projection (protocol plumbing like
 * `plugin_tool_exec` round-trips) return an empty array and are not enveloped.
 *
 * `type: "event"` carries a raw `SDKMessage` and delegates to the exhaustive
 * 39-member mapping in `sdk-canonical-events.mjs`; one SDK message can yield
 * several canonical events, which is why this returns a list.
 *
 * @param {any} msg
 * @param {{ sawStreamEvents: boolean }} [state] per-attempt SDK mapping state
 */
export function canonicalEventsFromWireMessage(msg, state) {
  if (!msg || typeof msg !== "object") return []
  switch (msg.type) {
    case "event": {
      const event = msg.event
      if (!event || typeof event !== "object") return []
      return canonicalEventsFromSdkMessage(event, state ?? createSdkMappingState())
    }
    case "permission_request":
      return [
        {
          kind: "permission-request",
          requestId: msg.requestId,
          toolName: msg.toolName,
          input: msg.input,
        },
      ]
    case "permission_interrupted":
      return [
        {
          kind: "warning",
          code: "permission_interrupted",
          message: String(msg.reason ?? "permission waiter interrupted"),
        },
      ]
    case "session_ended":
      return [
        msg.error
          ? { kind: "failure", code: "session_error", message: String(msg.error) }
          : { kind: "lifecycle", phase: "ended" },
      ]
    case "capability_error":
      return [{ kind: "capability-error", capability: msg.capability, command: msg.command }]
    default:
      return []
  }
}

/**
 * Single-event convenience wrapper kept for callers that only ever look at the
 * first projection. Returns null when there is none.
 *
 * @param {any} msg
 * @param {{ sawStreamEvents: boolean }} [state]
 */
export function canonicalEventFromWireMessage(msg, state) {
  return canonicalEventsFromWireMessage(msg, state)[0] ?? null
}

/**
 * Create an envelope-emitting wrapper. Returns `wrap(rawEmit)` composition:
 * every message flows through unchanged, and messages with a canonical
 * projection ALSO emit `{ type: "agent_event", envelope }`.
 *
 * @param {{
 *   sessionId: string,
 *   runId: string,
 *   attemptId: string,
 *   parentRunId?: string,
 *   hostRef: string,
 *   runtime: string,
 *   turnRef?: { id?: string },
 *   expectStructuredOutput?: boolean,
 *   emit: (msg: any) => void,
 * }} params
 */
export function createEnvelopeEmitter(params) {
  let sequence = 0
  const {
    sessionId,
    runId,
    attemptId,
    parentRunId,
    hostRef,
    runtime,
    turnRef,
    expectStructuredOutput,
    emit,
  } = params
  // Per-attempt, because both flags are properties of THIS attempt's options,
  // not of the process: whether partials stream, and whether a json_schema was
  // requested. The Claude rail rebuilds the session per send, so an attempt is
  // also a turn here.
  const sdkState = createSdkMappingState({ expectStructuredOutput })

  return function emitWithEnvelope(msg) {
    emit(msg)
    for (const event of canonicalEventsFromWireMessage(msg, sdkState)) {
      const envelope = {
        schemaVersion: 1,
        eventId: `${sessionId}:${attemptId}:${sequence}`,
        sequence,
        sessionId,
        runId,
        turnId: turnRef?.id ?? msg?.turnId ?? "turn-unbound",
        attemptId,
        ...(parentRunId ? { parentRunId } : {}),
        hostRef,
        runtime,
        timestamp: new Date().toISOString(),
        event,
      }
      sequence += 1
      emit({ type: "agent_event", sessionId, envelope })
    }
  }
}
