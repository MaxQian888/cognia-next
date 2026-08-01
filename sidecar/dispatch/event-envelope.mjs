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

/**
 * Map one raw sidecar wire message to zero-or-one CanonicalAgentEvent.
 * Messages with no canonical projection (protocol plumbing like
 * `plugin_tool_exec` round-trips) return null and are not enveloped.
 */
export function canonicalEventFromWireMessage(msg) {
  if (!msg || typeof msg !== "object") return null
  switch (msg.type) {
    case "event": {
      const event = msg.event
      if (!event || typeof event !== "object") return null
      if (event.type === "system" && event.subtype === "compact_boundary") {
        return {
          kind: "compact",
          trigger: event.compact_metadata?.trigger === "manual" ? "manual" : "auto",
          preTokens: event.compact_metadata?.pre_tokens,
          postTokens: event.compact_metadata?.post_tokens,
        }
      }
      // Raw SDK messages stay available as controlled diagnostics.
      return { kind: "diagnostic", runtime: "sidecar", payload: event }
    }
    case "permission_request":
      return {
        kind: "permission-request",
        requestId: msg.requestId,
        toolName: msg.toolName,
        input: msg.input,
      }
    case "permission_interrupted":
      return {
        kind: "warning",
        code: "permission_interrupted",
        message: String(msg.reason ?? "permission waiter interrupted"),
      }
    case "session_ended":
      return msg.error
        ? { kind: "failure", code: "session_error", message: String(msg.error) }
        : { kind: "lifecycle", phase: "ended" }
    case "capability_error":
      return { kind: "capability-error", capability: msg.capability, command: msg.command }
    default:
      return null
  }
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
 *   emit: (msg: any) => void,
 * }} params
 */
export function createEnvelopeEmitter(params) {
  let sequence = 0
  const { sessionId, runId, attemptId, parentRunId, hostRef, runtime, turnRef, emit } = params

  return function emitWithEnvelope(msg) {
    emit(msg)
    const event = canonicalEventFromWireMessage(msg)
    if (!event) return
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
