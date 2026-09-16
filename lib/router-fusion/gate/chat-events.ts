/**
 * The shared chat event handler's entry into Router + Fusion (ADR-0188).
 *
 * The sidecar emits `call_reserve_request`, `call_attempt_result` and
 * `ledger_bypassed` only for a send that carried a ledger stamp; the other hooks
 * below act only while `turn-registry` has the session marked. On the off path
 * none of these frames exist and no session is marked, so nothing is loaded.
 *
 * Nothing here throws into the event loop. A host that cannot be loaded still
 * answers a pending reservation with `bypass`, so the sidecar continues the turn
 * unledgered at once instead of waiting out its timeout.
 */

import type {
  CallAttemptResultEvent,
  CallReserveRequestEvent,
  ClaudeEvent,
  LedgerBypassedEvent,
} from "@cognia/agent-config-types"
import { callReserveDecision } from "@/lib/claude/ipc"

import { recordFusionFault } from "./breaker"
import { toInfrastructureFault } from "./faults"
import { breakerThresholdOf, type RouterFusionGateSettings } from "./feature-gate"
import { loadRouterFusionHost, type RouterFusionHost } from "./load-engine"
import {
  clearFusionTurn,
  fusionTurnOf,
  fusionTurnSessions,
  noteFusionTurnBypass,
} from "./turn-registry"

export type RouterFusionSidecarFrame =
  CallReserveRequestEvent | CallAttemptResultEvent | LedgerBypassedEvent

export function isRouterFusionSidecarFrame(event: ClaudeEvent): event is RouterFusionSidecarFrame {
  return (
    event.type === "call_reserve_request" ||
    event.type === "call_attempt_result" ||
    event.type === "ledger_bypassed"
  )
}

export interface ChatEventsIo {
  loadHost?: () => Promise<RouterFusionHost>
  decide?: typeof callReserveDecision
  settings?: () => RouterFusionGateSettings | null | undefined
}

function hostFault(sessionId: string, error: unknown, io: ChatEventsIo): void {
  const fault = toInfrastructureFault(error)
  const code = fault?.code ?? "internal"
  const record = recordFusionFault("chat", code, breakerThresholdOf(io.settings?.()), Date.now())
  noteFusionTurnBypass(sessionId, { code, justTripped: record.justTripped })
  console.warn("[router-fusion] chat event handled without the ledger", error)
}

export async function handleRouterFusionSidecarFrame(
  frame: RouterFusionSidecarFrame,
  io: ChatEventsIo = {}
): Promise<void> {
  let host: RouterFusionHost
  try {
    host = await (io.loadHost ?? loadRouterFusionHost)()
  } catch (error) {
    hostFault(frame.sessionId, error, io)
    if (frame.type === "call_reserve_request") {
      await (io.decide ?? callReserveDecision)(frame.sessionId, frame.requestId, {
        decision: "bypass",
        code: "import_failed",
      }).catch(() => undefined)
    }
    return
  }
  try {
    await host.handleRouterFusionSidecarEvent(frame, io.decide ? { decide: io.decide } : {})
  } catch (error) {
    hostFault(frame.sessionId, error, io)
    if (frame.type === "call_reserve_request") {
      await (io.decide ?? callReserveDecision)(frame.sessionId, frame.requestId, {
        decision: "bypass",
        code: toInfrastructureFault(error)?.code ?? "internal",
      }).catch(() => undefined)
    }
  }
}

/**
 * Whether this window runs a ledgered turn for the session. Synchronous, so the
 * shared handler pays nothing — not even a microtask — on every other turn.
 */
export function routerFusionTurnActive(sessionId: string): boolean {
  return fusionTurnOf(sessionId) !== undefined
}

/** The SDK messages an envelope books from: assistant usage, retries, the turn result. */
function envelopeRelevant(message: unknown): boolean {
  const type = (message as { type?: unknown } | null)?.type
  return type === "assistant" || type === "system" || type === "result"
}

/**
 * Feed an SDK message of a ledgered turn to its envelope. Returns undefined —
 * synchronously — for every other session and for token deltas; otherwise a
 * promise the handler awaits, so the run books this message before it seals
 * the turn. Never rejects.
 */
export function observeRouterFusionTurnMessage(
  sessionId: string,
  message: unknown,
  io: ChatEventsIo = {}
): Promise<void> | undefined {
  if (!fusionTurnOf(sessionId) || !envelopeRelevant(message)) return undefined
  return (io.loadHost ?? loadRouterFusionHost)()
    .then((host) => host.observeRouterFusionSdkMessage(sessionId, message))
    .catch((error) => hostFault(sessionId, error, io))
}

export type RouterFusionTurnOutcome = {
  status: "succeeded" | "failed" | "cancelled"
  error?: { code: string; message: string }
}

/** The outcome an SDK `result` message reports for its turn. */
export function routerFusionOutcomeOfResult(result: unknown): RouterFusionTurnOutcome {
  const r = (result ?? {}) as { subtype?: unknown; is_error?: unknown }
  const subtype = typeof r.subtype === "string" ? r.subtype : "success"
  if (subtype === "success" && r.is_error !== true) return { status: "succeeded" }
  const code = subtype === "success" ? "RESULT_ERROR" : subtype.toUpperCase()
  return { status: "failed", error: { code, message: `The turn ended with ${subtype}.` } }
}

/** The outcome a `session_ended` frame reports for a turn that had no result. */
export function routerFusionOutcomeOfSessionEnd(evt: {
  error?: string
  routerFusionRefusal?: { code: string; message?: string }
}): RouterFusionTurnOutcome {
  if (evt.routerFusionRefusal) {
    return {
      status: "failed",
      error: {
        code: evt.routerFusionRefusal.code,
        message: evt.routerFusionRefusal.message ?? "Router + Fusion refused a call.",
      },
    }
  }
  if (evt.error) return { status: "failed", error: { code: "TURN_ERROR", message: evt.error } }
  // A clean end — including a user stop, which the run already marked
  // cancelling and therefore seals cancelled.
  return { status: "succeeded" }
}

/**
 * Seal the session's ledgered turn, if it has one. Returns the summary for the
 * transcript and the usage row, or null — never throws.
 */
export async function finishRouterFusionTurn(
  sessionId: string,
  outcome: RouterFusionTurnOutcome,
  io: ChatEventsIo = {}
): Promise<import("@/lib/router-fusion/host").RouterFusionTurnSummary | null> {
  if (!fusionTurnOf(sessionId)) return null
  try {
    const host = await (io.loadHost ?? loadRouterFusionHost)()
    return await host.finishRouterFusionChatTurn(sessionId, outcome)
  } catch (error) {
    hostFault(sessionId, error, io)
    clearFusionTurn(sessionId)
    return null
  }
}

/**
 * The host process died: none of its turns will send `session_ended`, so seal
 * every ledgered turn of this window failed. Calls in flight stay UNKNOWN and
 * held until reconciled. A no-op — without an await — when no turn is ledgered.
 */
export function finishAllRouterFusionTurns(
  error: { code: string; message: string },
  io: ChatEventsIo = {}
): Promise<void> | undefined {
  const sessions = fusionTurnSessions()
  if (sessions.length === 0) return undefined
  return Promise.all(
    sessions.map((sessionId) => finishRouterFusionTurn(sessionId, { status: "failed", error }, io))
  ).then(() => undefined)
}

/** The user interrupted the turn: its run moves to cancelling. Never throws. */
export async function cancelRouterFusionTurn(
  sessionId: string,
  io: ChatEventsIo = {}
): Promise<void> {
  if (!fusionTurnOf(sessionId)) return
  try {
    const host = await (io.loadHost ?? loadRouterFusionHost)()
    await host.cancelRouterFusionChatTurn(sessionId)
  } catch (error) {
    hostFault(sessionId, error, io)
  }
}
