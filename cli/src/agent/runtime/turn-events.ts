/**
 * The one place a headless turn's events become canonical envelopes.
 *
 * `CaptureStreamEvent` is the capture layer's internal union and stays that
 * way — it is a rendering shape, not a contract. Everything that leaves the
 * runtime (stdout `--stream-json`, the SDK's `events()`, RPC event records, the
 * persisted session log) is an `AgentEventEnvelope`, so those four surfaces can
 * never drift from one another.
 *
 * This module also owns the side-effect boundary in practice: `text-delta` and
 * `tool-call` are exactly the events that make a turn unreplayable, so the
 * emitter marks the tracker as it forwards them rather than leaving each call
 * site to remember.
 */

import type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

import type { SideEffectTracker } from "./retry"

export interface TurnIdentity {
  sessionId: string
  runId: string
  turnId: string
  attemptId: string
  providerAttemptId?: string
  parentRunId?: string
  hostRef: string
  runtime: string
}

export interface EnvelopeEmitter {
  /** Wrap a canonical event and deliver it. Returns the envelope emitted. */
  emit(event: CanonicalAgentEvent): AgentEventEnvelope
  /** Project a capture event, marking side effects. Null when it has no canonical form. */
  fromCapture(event: CaptureStreamEvent): AgentEventEnvelope | null
  /** Envelopes emitted this attempt, in order. */
  readonly emitted: readonly AgentEventEnvelope[]
  /** Next sequence number. Monotonic within an attempt, starting at 0. */
  readonly sequence: number
}

export interface EmitterOptions {
  identity: TurnIdentity
  /** Delivered to the caller (stdout writer, SDK subscriber, RPC channel). */
  onEnvelope?: (envelope: AgentEventEnvelope) => void
  /** Marked when an event crosses the replay boundary. */
  sideEffects?: SideEffectTracker
  /**
   * Raw provider payloads stay OFF unless explicitly enabled. A `diagnostic`
   * event carries whatever the runtime handed us, which is the one kind that
   * can contain unredacted provider internals.
   */
  includeDiagnostics?: boolean
  now?: () => Date
}

/**
 * Map a capture event onto its canonical form.
 *
 * Unknown types become `diagnostic` rather than being dropped: a silently
 * discarded event is indistinguishable from one that never happened, and the
 * persisted log is supposed to be the record of what occurred.
 */
export function canonicalFromCapture(event: CaptureStreamEvent): CanonicalAgentEvent {
  switch (event.type) {
    case "text-delta":
      return { kind: "text-delta", delta: event.delta ?? "" }
    case "thinking-delta":
      return { kind: "thinking-delta", delta: event.delta ?? "" }
    case "commentary-delta":
      return {
        kind: "commentary-delta",
        delta: event.delta ?? "",
        ...(event.messageId ? { messageId: event.messageId } : {}),
        ...(typeof event.done === "boolean" ? { done: event.done } : {}),
      }
    case "tool-call":
      return {
        kind: "tool-call",
        toolName: event.toolName,
        input: event.input ?? {},
        ...(event.id ? { toolCallId: event.id } : {}),
      }
    case "tool-result":
      return {
        kind: "tool-result",
        toolName: event.toolName,
        ...(event.id ? { toolCallId: event.id } : {}),
        ...(event.input ? { input: event.input } : {}),
        result: event.result,
        ...(event.isError ? { isError: true } : {}),
      }
    case "usage":
      return {
        kind: "usage",
        usage: (event.usage ?? {}) as Record<string, unknown>,
        ...(typeof event.partial === "boolean" ? { partial: event.partial } : {}),
      }
    case "compact":
      return {
        kind: "compact",
        trigger: event.trigger === "manual" ? "manual" : "auto",
        ...(typeof event.preTokens === "number" ? { preTokens: event.preTokens } : {}),
        ...(typeof event.postTokens === "number" ? { postTokens: event.postTokens } : {}),
      }
    case "retry":
      return {
        kind: "retry",
        phase: event.phase,
        attempt: event.attempt,
        maxRetries: event.maxRetries,
        code: event.code,
        ...(typeof event.delayMs === "number" ? { delayMs: event.delayMs } : {}),
        ...(event.message !== undefined ? { message: event.message } : {}),
      }
    default:
      return { kind: "diagnostic", runtime: "capture", payload: event }
  }
}

/**
 * Which capture events make a turn unreplayable.
 *
 * `text-delta` counts because the caller has already SEEN it — replaying the
 * turn would print the answer twice. `tool-call` counts because the tool has
 * already run. `thinking-delta` and `usage` do not: neither is shown as an
 * answer nor changes the world.
 */
export function sideEffectReason(event: CanonicalAgentEvent): string | null {
  switch (event.kind) {
    case "text-delta":
      return event.delta.length > 0 ? "assistant text was emitted" : null
    case "tool-call":
      return `tool ${event.toolName} was invoked`
    case "tool-result":
      return `tool ${event.toolName} produced a result`
    case "compact":
      return "the context was compacted"
    default:
      return null
  }
}

export function createEnvelopeEmitter(options: EmitterOptions): EnvelopeEmitter {
  const now = options.now ?? (() => new Date())
  const emitted: AgentEventEnvelope[] = []
  let sequence = 0

  const emit = (event: CanonicalAgentEvent): AgentEventEnvelope => {
    const identity = options.identity
    const envelope: AgentEventEnvelope = {
      schemaVersion: 1,
      eventId: `${identity.sessionId}:${identity.turnId}:${identity.attemptId}:${sequence}`,
      sequence,
      sessionId: identity.sessionId,
      runId: identity.runId,
      turnId: identity.turnId,
      attemptId: identity.attemptId,
      ...(identity.providerAttemptId ? { providerAttemptId: identity.providerAttemptId } : {}),
      ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}),
      hostRef: identity.hostRef,
      runtime: identity.runtime,
      timestamp: now().toISOString(),
      event,
    }
    sequence += 1
    emitted.push(envelope)
    const reason = sideEffectReason(event)
    if (reason) options.sideEffects?.mark(reason)
    options.onEnvelope?.(envelope)
    return envelope
  }

  return {
    emit,
    fromCapture(event) {
      const canonical = canonicalFromCapture(event)
      // A diagnostic is the only kind that can carry raw provider internals,
      // so it is suppressed unless the caller explicitly opted in.
      if (canonical.kind === "diagnostic" && !options.includeDiagnostics) return null
      return emit(canonical)
    },
    get emitted() {
      return emitted
    },
    get sequence() {
      return sequence
    },
  }
}

/** Mint a run id. Distinct prefix from session ids so logs stay greppable. */
export function mintRunId(now: number, rand: number): string {
  return `run_${now.toString(36)}${rand.toString(36).slice(2, 8)}`
}

/** Mint a turn id, scoped to its run. */
export function mintTurnId(runId: string, index: number): string {
  return `${runId}:t${index}`
}

/** Mint an attempt id. Each retry gets its own, so identities never collide. */
export function mintAttemptId(turnId: string, attempt: number): string {
  return `${turnId}:a${attempt}`
}
