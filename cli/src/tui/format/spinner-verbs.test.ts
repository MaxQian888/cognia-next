/**
 * @jest-environment node
 */
import { SPINNER_VERBS, spinnerVerb } from "./spinner-verbs"

describe("spinnerVerb", () => {
  it("returns the first verb at tick 0", () => {
    expect(spinnerVerb(0)).toBe(SPINNER_VERBS[0])
    expect(SPINNER_VERBS[0]).toBe("Working")
  })

  it("advances through the list and wraps", () => {
    expect(spinnerVerb(1)).toBe(SPINNER_VERBS[1])
    expect(spinnerVerb(SPINNER_VERBS.length)).toBe(SPINNER_VERBS[0])
    expect(spinnerVerb(SPINNER_VERBS.length + 2)).toBe(SPINNER_VERBS[2])
  })

  it("wraps negative ticks safely", () => {
    expect(spinnerVerb(-1)).toBe(SPINNER_VERBS[SPINNER_VERBS.length - 1])
  })

  it("falls back to Working for an empty verb list", () => {
    expect(spinnerVerb(3, [])).toBe("Working")
  })

  it("uses a custom verb list when provided", () => {
    expect(spinnerVerb(1, ["a", "b", "c"])).toBe("b")
  })
})
