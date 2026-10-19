import { boundedDetail, isFallbackEligible } from "./read-outcome"

describe("isFallbackEligible", () => {
  it("lets recoverable failures move on and stops on terminal ones", () => {
    for (const eligible of [
      "network",
      "thin",
      "binary",
      "anti-bot",
      "attempt-timeout",
      "vendor-quota",
    ] as const) {
      expect(isFallbackEligible(eligible)).toBe(true)
    }
    for (const terminal of [
      "not-found",
      "auth-required",
      "ambiguous-forbidden",
      "blocked",
      "too-large",
      "cancelled",
      "timeout",
    ] as const) {
      expect(isFallbackEligible(terminal)).toBe(false)
    }
  })
})

describe("boundedDetail", () => {
  it("collapses to one bounded line", () => {
    expect(boundedDetail(new Error("a\n b"))).toBe("a b")
    expect(boundedDetail("x".repeat(500))).toHaveLength(200)
    expect(boundedDetail(undefined)).toBe("")
  })
})
