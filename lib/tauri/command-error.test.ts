import {
  parseInvokeError,
  isCommandErrorEnvelope,
  CommandInvokeError,
  rethrowInvokeError,
} from "./command-error"

describe("isCommandErrorEnvelope", () => {
  it("accepts the full envelope and the retryable-less variant", () => {
    expect(isCommandErrorEnvelope({ code: "timeout", message: "slow", retryable: true })).toBe(true)
    expect(isCommandErrorEnvelope({ code: "x", message: "y" })).toBe(true)
  })

  it("rejects non-objects and near-misses", () => {
    expect(isCommandErrorEnvelope("timeout: slow")).toBe(false)
    expect(isCommandErrorEnvelope(null)).toBe(false)
    expect(isCommandErrorEnvelope({ code: 1, message: "y" })).toBe(false)
    expect(isCommandErrorEnvelope({ code: "x", message: "y", retryable: "yes" })).toBe(false)
    expect(isCommandErrorEnvelope({ message: "y" })).toBe(false)
  })
})

describe("parseInvokeError", () => {
  it("decodes a structured envelope", () => {
    expect(parseInvokeError({ code: "timeout", message: "op timed out", retryable: true })).toEqual(
      { code: "timeout", message: "op timed out", retryable: true, structured: true }
    )
  })

  it("defaults retryable to false when the envelope omits it", () => {
    expect(parseInvokeError({ code: "install_error", message: "bad vsix" })).toMatchObject({
      retryable: false,
      structured: true,
    })
  })

  it("degrades gracefully for legacy string rejections", () => {
    expect(parseInvokeError("Task not found: t1")).toEqual({
      code: "unknown",
      message: "Task not found: t1",
      retryable: false,
      structured: false,
    })
  })

  it("degrades gracefully for Error instances and arbitrary values", () => {
    expect(parseInvokeError(new Error("boom"))).toMatchObject({
      code: "unknown",
      message: "boom",
      structured: false,
    })
    expect(parseInvokeError(42)).toMatchObject({ message: "42", structured: false })
    expect(parseInvokeError(undefined)).toMatchObject({ message: "undefined" })
  })
})

describe("CommandInvokeError / rethrowInvokeError", () => {
  it("carries code/retryable while remaining an Error", () => {
    const err = new CommandInvokeError(
      parseInvokeError({ code: "timeout", message: "slow", retryable: true })
    )
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe("slow")
    expect(err.code).toBe("timeout")
    expect(err.retryable).toBe(true)
  })

  it("rethrowInvokeError wraps any rejection shape", () => {
    expect(() => rethrowInvokeError("legacy failure")).toThrow(CommandInvokeError)
    try {
      rethrowInvokeError({ code: "io", message: "disk gone", retryable: true })
    } catch (e) {
      expect((e as CommandInvokeError).code).toBe("io")
      expect((e as CommandInvokeError).retryable).toBe(true)
    }
  })
})
