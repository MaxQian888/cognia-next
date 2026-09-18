import {
  FINISH_RETRY_MAX_ATTEMPTS,
  finishRetryDelayMs,
  isRetryableFinishReason,
} from "@/lib/ai/finish-reason-retry"

describe("isRetryableFinishReason", () => {
  it.each(["network_error", "network-error", "NETWORK_ERROR", "error", "other", "unknown"])(
    "retries %s",
    (reason) => {
      expect(isRetryableFinishReason(reason)).toBe(true)
    }
  )

  it.each(["stop", "length", "content-filter", "tool-calls"])(
    "does not retry definitive %s",
    (reason) => {
      expect(isRetryableFinishReason(reason)).toBe(false)
    }
  )

  it.each([null, undefined, ""])("does not retry absent reason %s", (reason) => {
    expect(isRetryableFinishReason(reason)).toBe(false)
  })
})

describe("finishRetryDelayMs", () => {
  it("grows with the attempt and stays jittered", () => {
    const first = finishRetryDelayMs(1, () => 0)
    const second = finishRetryDelayMs(2, () => 0)
    expect(first).toBe(1000)
    expect(second).toBe(2000)
    expect(finishRetryDelayMs(1, () => 1)).toBe(1250)
  })
})

describe("FINISH_RETRY_MAX_ATTEMPTS", () => {
  it("is bounded", () => {
    expect(FINISH_RETRY_MAX_ATTEMPTS).toBeGreaterThan(0)
    expect(FINISH_RETRY_MAX_ATTEMPTS).toBeLessThanOrEqual(4)
  })
})
