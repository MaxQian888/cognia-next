import { MAX_ERROR_MESSAGE_CHARS, toBridgeError, WasmBridgeError } from "./errors"

function abortError(): Error {
  const err = new Error("The operation was aborted.")
  err.name = "AbortError"
  return err
}

function named(name: string, message: string): Error {
  const err = new Error(message)
  err.name = name
  return err
}

describe("toBridgeError", () => {
  it("passes a WasmBridgeError through unchanged", () => {
    const err = new WasmBridgeError("WORKFLOW_REJECTED", "not-registered")
    expect(toBridgeError(err)).toEqual({ code: "WORKFLOW_REJECTED", message: "not-registered" })
  })

  it("classifies a timeout abort as TIMEOUT", () => {
    expect(toBridgeError(abortError(), { abortReason: "timeout" }).code).toBe("TIMEOUT")
  })

  it.each(["caller", "deactivate", "unload"] as const)(
    "classifies a %s abort as CANCELLED",
    (abortReason) => {
      const result = toBridgeError(abortError(), { abortReason })
      expect(result.code).toBe("CANCELLED")
      expect(result.message).toContain(abortReason)
    }
  )

  it("classifies a bare abort with no recorded reason as CANCELLED", () => {
    expect(toBridgeError(abortError()).code).toBe("CANCELLED")
  })

  it("classifies a DOMException-shaped abort", () => {
    // jsdom/node AbortController rejections are not always `Error` instances.
    expect(toBridgeError({ name: "AbortError", message: "aborted" }).code).toBe("CANCELLED")
  })

  it.each(["PluginPiiError", "PermissionError"])("classifies %s as CAPABILITY_DENIED", (name) => {
    expect(toBridgeError(named(name, "denied")).code).toBe("CAPABILITY_DENIED")
  })

  it("classifies NO_PROVIDER_AVAILABLE as HOST_UNAVAILABLE, not PROVIDER_ERROR", () => {
    // Nothing failed — the user simply has no provider configured. Retrying
    // will not help, so it must not look like a transient provider fault.
    const err = Object.assign(new Error("no provider"), { code: "NO_PROVIDER_AVAILABLE" })
    expect(toBridgeError(err).code).toBe("HOST_UNAVAILABLE")
  })

  it("defaults to PROVIDER_ERROR for anything else", () => {
    expect(toBridgeError(new Error("502 from upstream")).code).toBe("PROVIDER_ERROR")
    expect(toBridgeError("plain string").code).toBe("PROVIDER_ERROR")
    expect(toBridgeError(undefined).code).toBe("PROVIDER_ERROR")
  })

  it("prefers the abort classification over the provider default", () => {
    // Ordering check: an AbortError must never fall through to PROVIDER_ERROR.
    expect(toBridgeError(abortError(), { abortReason: "timeout" }).code).not.toBe("PROVIDER_ERROR")
  })

  it("truncates long messages so provider text cannot echo an unbounded prompt", () => {
    const long = "x".repeat(MAX_ERROR_MESSAGE_CHARS * 3)
    const result = toBridgeError(new Error(long))
    expect(result.message.length).toBe(MAX_ERROR_MESSAGE_CHARS)
    expect(result.message.endsWith("…")).toBe(true)
  })

  it("leaves a message exactly at the cap intact", () => {
    const exact = "y".repeat(MAX_ERROR_MESSAGE_CHARS)
    expect(toBridgeError(new Error(exact)).message).toBe(exact)
  })
})

describe("WasmBridgeError", () => {
  it("carries its code and a conventional name", () => {
    const err = new WasmBridgeError("PAYLOAD_TOO_LARGE", "too big")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("WasmBridgeError")
    expect(err.code).toBe("PAYLOAD_TOO_LARGE")
  })
})
