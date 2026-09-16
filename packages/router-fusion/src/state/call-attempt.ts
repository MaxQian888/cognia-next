/**
 * Call-attempt machine (DESIGN §13.3–§13.4).
 *
 *   PREPARED → DISPATCHED → SUCCEEDED | FAILED | UNKNOWN
 *   UNKNOWN  → RECONCILED
 *   PREPARED → ABANDONED   (proved never sent: safe to release and redispatch)
 *
 * The one rule the whole ledger leans on: a DISPATCHED attempt is never
 * assumed free and never silently retried. Only PREPARED — committed before a
 * single byte left the process — may be abandoned and re-dispatched.
 */

export const CALL_ATTEMPT_STATES = [
  "PREPARED",
  "DISPATCHED",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
  "RECONCILED",
  "ABANDONED",
] as const
export type CallAttemptState = (typeof CALL_ATTEMPT_STATES)[number]

const EDGES: Record<CallAttemptState, readonly CallAttemptState[]> = {
  PREPARED: ["DISPATCHED", "ABANDONED"],
  DISPATCHED: ["SUCCEEDED", "FAILED", "UNKNOWN"],
  SUCCEEDED: [],
  FAILED: [],
  UNKNOWN: ["RECONCILED"],
  RECONCILED: [],
  ABANDONED: [],
}

export function canTransitionAttempt(from: CallAttemptState, to: CallAttemptState): boolean {
  return EDGES[from].includes(to)
}

export class IllegalAttemptTransitionError extends Error {
  readonly code = "ILLEGAL_ATTEMPT_TRANSITION"
  constructor(
    readonly from: CallAttemptState,
    readonly to: CallAttemptState
  ) {
    super(`call attempt cannot move from ${from} to ${to}`)
    this.name = "IllegalAttemptTransitionError"
  }
}

export function assertAttemptTransition(from: CallAttemptState, to: CallAttemptState): void {
  if (!canTransitionAttempt(from, to)) throw new IllegalAttemptTransitionError(from, to)
}

export function isSettledAttempt(state: CallAttemptState): boolean {
  return (
    state === "SUCCEEDED" || state === "FAILED" || state === "RECONCILED" || state === "ABANDONED"
  )
}

/** Attempts that still occupy a model-call slot and a reservation. */
export function isInFlightAttempt(state: CallAttemptState): boolean {
  return state === "PREPARED" || state === "DISPATCHED" || state === "UNKNOWN"
}

/** Whether an attempt consumed one of the run's `max_model_calls` (every transport attempt counts). */
export function consumesModelCall(state: CallAttemptState): boolean {
  return state !== "ABANDONED"
}

/**
 * What recovery may do with an attempt it finds after a crash or reload.
 * `redispatch` is only offered for PREPARED, which is proof nothing was sent.
 */
export type AttemptRecoveryAction =
  "reuse_result" | "redispatch" | "mark_unknown" | "keep_unknown" | "none"

export function recoveryActionFor(
  state: CallAttemptState,
  ownerAlive: boolean
): AttemptRecoveryAction {
  switch (state) {
    case "SUCCEEDED":
      return "reuse_result"
    case "PREPARED":
      return ownerAlive ? "none" : "redispatch"
    case "DISPATCHED":
      return ownerAlive ? "none" : "mark_unknown"
    case "UNKNOWN":
      return "keep_unknown"
    default:
      return "none"
  }
}
