import {
  IllegalReservationTransitionError,
  STEP_RESERVATION_STATES,
  assertReservationTransition,
  canTransitionReservation,
  isActiveReservation,
} from "./step-reservation"

describe("step reservation machine", () => {
  it("[ACC:BUD-06] never releases an uncertain reservation", () => {
    expect(canTransitionReservation("uncertain", "released")).toBe(false)
    expect(() => assertReservationTransition("uncertain", "released")).toThrow(
      IllegalReservationTransitionError
    )
    expect(canTransitionReservation("uncertain", "settled")).toBe(true)
  })

  it("counts held and uncertain amounts against the run", () => {
    expect(STEP_RESERVATION_STATES.filter(isActiveReservation)).toEqual(["held", "uncertain"])
  })

  it("makes settled, released and converted terminal", () => {
    for (const from of ["settled", "released", "converted"] as const) {
      for (const to of STEP_RESERVATION_STATES) {
        expect(canTransitionReservation(from, to)).toBe(false)
      }
    }
  })
})
