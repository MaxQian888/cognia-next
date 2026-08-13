/** @jest-environment jsdom */

import {
  __resetPerformanceSecurityGenerationForTests,
  assertPerformanceSecurityGeneration,
  bumpPerformanceSecurityGeneration,
  getPerformanceSecurityGeneration,
  subscribePerformanceSecurityBarrier,
} from "./security-generation"

describe("performance account-security generation", () => {
  beforeEach(() => {
    __resetPerformanceSecurityGenerationForTests()
    localStorage.clear()
  })

  it("invalidates in-flight crypto/write generations and writes a structural recovery marker", () => {
    const listener = jest.fn()
    subscribePerformanceSecurityBarrier(listener)
    const expected = getPerformanceSecurityGeneration()
    bumpPerformanceSecurityGeneration("account-a", "account-locked", 10)
    expect(() => assertPerformanceSecurityGeneration(expected)).toThrow(
      "performance-security-generation-changed"
    )
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-a", reason: "account-locked" })
    )
    expect(localStorage.getItem("cognia-perf-recovery:account-a")).not.toBeNull()
  })
})
