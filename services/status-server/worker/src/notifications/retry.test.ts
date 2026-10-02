import { describe, expect, it } from "vitest"

import { classifySendError, nextRetryAt, RETRY_WINDOW_MS } from "./retry"

const T = Date.UTC(2026, 9, 2, 10, 0, 0)
const MIN = 60_000

function coded(code?: string): Error {
  const error = new Error("x") as Error & { code?: string }
  if (code) error.code = code
  return error
}

describe("classifySendError", () => {
  it.each([
    ["E_RECIPIENT_SUPPRESSED", "suppressed"],
    ["E_RATE_LIMIT_EXCEEDED", "retryable"],
    ["E_DAILY_LIMIT_EXCEEDED", "retryable"],
    ["E_VALIDATION_ERROR", "terminal"],
    ["E_FIELD_MISSING", "terminal"],
    ["E_TOO_MANY_RECIPIENTS", "terminal"],
    ["E_CONTENT_TOO_LARGE", "terminal"],
    ["E_SENDER_NOT_VERIFIED", "terminal"],
    ["E_SENDER_DOMAIN_NOT_AVAILABLE", "terminal"],
    ["E_RECIPIENT_NOT_ALLOWED", "terminal"],
    ["E_HEADER_NOT_ALLOWED", "terminal"],
    ["E_DELIVERY_FAILED", "uncertain"],
    ["E_INTERNAL_SERVER_ERROR", "uncertain"],
    ["E_SOMETHING_NEW", "uncertain"],
  ])("%s → %s", (code, kind) => {
    expect(classifySendError(coded(code))).toEqual({ kind, code })
  })

  it("treats an error without a code as uncertain", () => {
    expect(classifySendError(coded())).toEqual({ kind: "uncertain", code: "no_code" })
    expect(classifySendError("boom")).toEqual({ kind: "uncertain", code: "no_code" })
  })
})

describe("nextRetryAt", () => {
  it("follows 1 min, 5 min, 30 min, 2 h with ±20 % jitter", () => {
    const bases = [MIN, 5 * MIN, 30 * MIN, 120 * MIN]
    bases.forEach((base, index) => {
      expect(nextRetryAt(index + 1, T, T, 0)).toBe(T + Math.round(base * 0.8))
      expect(nextRetryAt(index + 1, T, T, 0.5)).toBe(T + base)
      expect(nextRetryAt(index + 1, T, T, 0.999999)).toBeLessThanOrEqual(T + Math.round(base * 1.2))
    })
  })

  it("then repeats every 6 h until 24 h after creation", () => {
    const afterFourth = T + 3 * 60 * MIN
    expect(nextRetryAt(5, T, afterFourth, 0.5)).toBe(afterFourth + 6 * 60 * MIN)
    expect(nextRetryAt(7, T, T + 20 * 60 * MIN, 0.5)).toBeNull()
    expect(nextRetryAt(1, T, T + RETRY_WINDOW_MS, 0.5)).toBeNull()
  })
})
