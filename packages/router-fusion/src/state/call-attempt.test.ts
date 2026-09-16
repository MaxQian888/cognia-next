import {
  CALL_ATTEMPT_STATES,
  IllegalAttemptTransitionError,
  assertAttemptTransition,
  canTransitionAttempt,
  consumesModelCall,
  isInFlightAttempt,
  isSettledAttempt,
  recoveryActionFor,
} from "./call-attempt"

describe("call attempt machine", () => {
  it("never lets a dispatched attempt return to prepared or be abandoned", () => {
    expect(canTransitionAttempt("DISPATCHED", "PREPARED")).toBe(false)
    expect(canTransitionAttempt("DISPATCHED", "ABANDONED")).toBe(false)
    expect(() => assertAttemptTransition("DISPATCHED", "ABANDONED")).toThrow(
      IllegalAttemptTransitionError
    )
  })

  it("lets only UNKNOWN reconcile", () => {
    for (const state of CALL_ATTEMPT_STATES) {
      expect(canTransitionAttempt(state, "RECONCILED")).toBe(state === "UNKNOWN")
    }
  })

  it("classifies in-flight and settled states disjointly", () => {
    for (const state of CALL_ATTEMPT_STATES) {
      expect(isInFlightAttempt(state) && isSettledAttempt(state)).toBe(false)
    }
    expect(isInFlightAttempt("UNKNOWN")).toBe(true)
    expect(isSettledAttempt("ABANDONED")).toBe(true)
  })

  it("[ACC:BUD-10] counts every transport attempt except an abandoned one", () => {
    expect(consumesModelCall("FAILED")).toBe(true)
    expect(consumesModelCall("UNKNOWN")).toBe(true)
    expect(consumesModelCall("ABANDONED")).toBe(false)
  })

  it("[ACC:REC-01] reuses a committed result and never redispatches a sent call", () => {
    expect(recoveryActionFor("SUCCEEDED", false)).toBe("reuse_result")
    expect(recoveryActionFor("DISPATCHED", false)).toBe("mark_unknown")
    expect(recoveryActionFor("PREPARED", false)).toBe("redispatch")
    expect(recoveryActionFor("PREPARED", true)).toBe("none")
    expect(recoveryActionFor("DISPATCHED", true)).toBe("none")
    expect(recoveryActionFor("UNKNOWN", false)).toBe("keep_unknown")
    expect(recoveryActionFor("FAILED", false)).toBe("none")
  })
})
