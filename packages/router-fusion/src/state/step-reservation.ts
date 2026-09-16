/**
 * Step reservation machine (DESIGN §13.2, §25.2).
 *
 *   held → settled      (actual cost booked)
 *   held → released     (step proved it will not call: PREPARED abandoned, stage unused at terminal)
 *   held → uncertain    (attached call went UNKNOWN: amount stays held, never reused)
 *   held → converted    (a reserved stage handed its amount to a concrete call reservation)
 *   uncertain → settled (late usage or estimate reconciled it)
 */

export const STEP_RESERVATION_STATES = [
  "held",
  "settled",
  "released",
  "uncertain",
  "converted",
] as const
export type StepReservationState = (typeof STEP_RESERVATION_STATES)[number]

export type StepReservationKind = "call" | "stage"

const EDGES: Record<StepReservationState, readonly StepReservationState[]> = {
  held: ["settled", "released", "uncertain", "converted"],
  uncertain: ["settled"],
  settled: [],
  released: [],
  converted: [],
}

export function canTransitionReservation(
  from: StepReservationState,
  to: StepReservationState
): boolean {
  return EDGES[from].includes(to)
}

export class IllegalReservationTransitionError extends Error {
  readonly code = "ILLEGAL_RESERVATION_TRANSITION"
  constructor(
    readonly from: StepReservationState,
    readonly to: StepReservationState
  ) {
    super(`step reservation cannot move from ${from} to ${to}`)
    this.name = "IllegalReservationTransitionError"
  }
}

export function assertReservationTransition(
  from: StepReservationState,
  to: StepReservationState
): void {
  if (!canTransitionReservation(from, to)) throw new IllegalReservationTransitionError(from, to)
}

/** Reservations whose amount still counts against `run_available`. */
export function isActiveReservation(state: StepReservationState): boolean {
  return state === "held" || state === "uncertain"
}
