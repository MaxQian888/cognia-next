import {
  CALL_ATTEMPT_STATES,
  STEP_RESERVATION_STATES,
  type CallAttemptState,
  type StepReservationKind,
  type StepReservationState,
} from "@cognia/router-fusion"

import type {
  FusionAttemptState,
  FusionCallAttemptRow,
  FusionReservationRow,
  FusionReservationState,
} from "./types"

/** Compile-time: `A` and `B` name exactly the same set of values. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const same = <A, B>(proof: Same<A, B>) => proof

describe("fusion row types", () => {
  it("store exactly the engine's call-attempt states", () => {
    expect(same<FusionAttemptState, CallAttemptState>(true)).toBe(true)
    expect(same<FusionCallAttemptRow["state"], CallAttemptState>(true)).toBe(true)
    // Every state the machine can reach is one a row can hold.
    const stored: readonly FusionAttemptState[] = CALL_ATTEMPT_STATES
    expect([...stored].sort()).toEqual([...CALL_ATTEMPT_STATES].sort())
  })

  it("store exactly the engine's step-reservation states and kinds", () => {
    expect(same<FusionReservationState, StepReservationState>(true)).toBe(true)
    expect(same<FusionReservationRow["kind"], StepReservationKind>(true)).toBe(true)
    const stored: readonly FusionReservationState[] = STEP_RESERVATION_STATES
    expect([...stored].sort()).toEqual([...STEP_RESERVATION_STATES].sort())
  })
})
