import { classifyResilienceError, isRetryableKind } from "@/lib/plugin/resilience/error-classify"
import { TimeoutError } from "@/lib/utils/with-timeout"

describe("classifyResilienceError", () => {
  it("classifies a TimeoutError as timeout", () => {
    expect(classifyResilienceError(new TimeoutError("plugin/tool", 1000))).toBe("timeout")
  })

  it("classifies a DOMException AbortError as aborted", () => {
    expect(classifyResilienceError(new DOMException("aborted", "AbortError"))).toBe("aborted")
  })

  it("classifies a plain Error named AbortError as aborted", () => {
    const err = new Error("stop")
    err.name = "AbortError"
    expect(classifyResilienceError(err)).toBe("aborted")
  })

  it("classifies unauthorized / 4xx / validation as fatal", () => {
    expect(classifyResilienceError(new Error("401 unauthorized"))).toBe("fatal")
    expect(classifyResilienceError(new Error("request failed: 404 not found"))).toBe("fatal")
    expect(classifyResilienceError(new Error("schema validation failed"))).toBe("fatal")
  })

  it("classifies generic network/5xx/unknown errors as retryable", () => {
    expect(classifyResilienceError(new Error("ECONNRESET"))).toBe("retryable")
    expect(classifyResilienceError(new Error("503 service unavailable"))).toBe("retryable")
    expect(classifyResilienceError("something odd")).toBe("retryable")
  })

  it("isRetryableKind gates retries to retryable + timeout only", () => {
    expect(isRetryableKind("retryable")).toBe(true)
    expect(isRetryableKind("timeout")).toBe(true)
    expect(isRetryableKind("fatal")).toBe(false)
    expect(isRetryableKind("aborted")).toBe(false)
  })
})
