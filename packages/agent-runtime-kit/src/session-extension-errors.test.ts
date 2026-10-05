import {
  ExternalAgentUnsupportedSessionExtensionError,
  createExternalAgentUnsupportedSessionExtensionError,
  isExternalAgentUnsupportedSessionExtensionError,
  getExternalAgentUnsupportedSessionExtensionMethod,
  isExternalAgentMethodNotFoundError,
  isExternalAgentSessionExtensionUnsupportedForMethod,
  isExternalAgentSessionExtensionUnsupportedError,
} from "./session-extension-errors"

describe("ExternalAgentUnsupportedSessionExtensionError", () => {
  it("uses default messages for each method", () => {
    expect(new ExternalAgentUnsupportedSessionExtensionError("session/list").message).toBe(
      "Agent does not support session listing"
    )
    expect(new ExternalAgentUnsupportedSessionExtensionError("session/fork").message).toBe(
      "Agent does not support session forking"
    )
    expect(new ExternalAgentUnsupportedSessionExtensionError("session/resume").message).toBe(
      "Agent does not support session resume"
    )
  })

  it("accepts a custom message override", () => {
    const err = new ExternalAgentUnsupportedSessionExtensionError("session/list", "custom")
    expect(err.message).toBe("custom")
    expect(err.method).toBe("session/list")
    expect(err.code).toBe("extension_unsupported")
    expect(err.name).toBe("ExternalAgentUnsupportedSessionExtensionError")
  })

  it("is an instance of Error", () => {
    expect(new ExternalAgentUnsupportedSessionExtensionError("session/fork")).toBeInstanceOf(Error)
  })
})

describe("createExternalAgentUnsupportedSessionExtensionError", () => {
  it("forwards to the constructor", () => {
    const err = createExternalAgentUnsupportedSessionExtensionError("session/resume", "msg")
    expect(err.method).toBe("session/resume")
    expect(err.message).toBe("msg")
  })

  it("uses default message when none is provided", () => {
    const err = createExternalAgentUnsupportedSessionExtensionError("session/fork")
    expect(err.message).toBe("Agent does not support session forking")
  })
})

describe("isExternalAgentUnsupportedSessionExtensionError", () => {
  it("returns true for matching error type with no method filter", () => {
    const err = new ExternalAgentUnsupportedSessionExtensionError("session/list")
    expect(isExternalAgentUnsupportedSessionExtensionError(err)).toBe(true)
  })

  it("returns true when method matches", () => {
    const err = new ExternalAgentUnsupportedSessionExtensionError("session/fork")
    expect(isExternalAgentUnsupportedSessionExtensionError(err, "session/fork")).toBe(true)
  })

  it("returns false when method differs", () => {
    const err = new ExternalAgentUnsupportedSessionExtensionError("session/fork")
    expect(isExternalAgentUnsupportedSessionExtensionError(err, "session/list")).toBe(false)
  })

  it("returns false for unrelated errors", () => {
    expect(isExternalAgentUnsupportedSessionExtensionError(new Error("nope"))).toBe(false)
    expect(isExternalAgentUnsupportedSessionExtensionError("string")).toBe(false)
    expect(isExternalAgentUnsupportedSessionExtensionError(undefined)).toBe(false)
  })
})

describe("getExternalAgentUnsupportedSessionExtensionMethod", () => {
  it("reads the .method property when given the typed error", () => {
    const err = new ExternalAgentUnsupportedSessionExtensionError("session/resume")
    expect(getExternalAgentUnsupportedSessionExtensionMethod(err)).toBe("session/resume")
  })

  it("infers the method from a session/list message", () => {
    expect(
      getExternalAgentUnsupportedSessionExtensionMethod(new Error("session/list not allowed"))
    ).toBe("session/list")
    expect(
      getExternalAgentUnsupportedSessionExtensionMethod(new Error("session listing failed"))
    ).toBe("session/list")
  })

  it("infers the method from a session/fork message", () => {
    expect(
      getExternalAgentUnsupportedSessionExtensionMethod(new Error("session/fork rejected"))
    ).toBe("session/fork")
    expect(
      getExternalAgentUnsupportedSessionExtensionMethod(new Error("session forking unsupported"))
    ).toBe("session/fork")
  })

  it("infers the method from a session/resume message", () => {
    expect(
      getExternalAgentUnsupportedSessionExtensionMethod(new Error("session/resume failed"))
    ).toBe("session/resume")
    expect(
      getExternalAgentUnsupportedSessionExtensionMethod(new Error("session resume blocked"))
    ).toBe("session/resume")
  })

  it("works with a plain string error", () => {
    expect(getExternalAgentUnsupportedSessionExtensionMethod("session/fork denied")).toBe(
      "session/fork"
    )
  })

  it("returns null for unrelated/empty messages", () => {
    expect(getExternalAgentUnsupportedSessionExtensionMethod(new Error("unrelated"))).toBeNull()
    expect(getExternalAgentUnsupportedSessionExtensionMethod(new Error(""))).toBeNull()
    expect(getExternalAgentUnsupportedSessionExtensionMethod(123)).toBeNull()
    expect(getExternalAgentUnsupportedSessionExtensionMethod(null)).toBeNull()
  })
})

describe("isExternalAgentMethodNotFoundError", () => {
  it("matches the JSON-RPC -32601 code", () => {
    expect(isExternalAgentMethodNotFoundError(new Error("Got -32601"))).toBe(true)
  })

  it("matches the words 'method not found'", () => {
    expect(isExternalAgentMethodNotFoundError(new Error("Method Not Found"))).toBe(true)
  })

  it("returns false for unrelated errors and empty messages", () => {
    expect(isExternalAgentMethodNotFoundError(new Error("nope"))).toBe(false)
    expect(isExternalAgentMethodNotFoundError(undefined)).toBe(false)
    expect(isExternalAgentMethodNotFoundError(null)).toBe(false)
  })
})

describe("isExternalAgentSessionExtensionUnsupportedForMethod", () => {
  it("returns true for the typed error matching the method", () => {
    const err = new ExternalAgentUnsupportedSessionExtensionError("session/list")
    expect(isExternalAgentSessionExtensionUnsupportedForMethod(err, "session/list")).toBe(true)
  })

  it("returns true when an inferred method matches", () => {
    expect(
      isExternalAgentSessionExtensionUnsupportedForMethod(
        new Error("session/fork rejected"),
        "session/fork"
      )
    ).toBe(true)
  })

  it("returns false when inferred method differs from requested", () => {
    expect(
      isExternalAgentSessionExtensionUnsupportedForMethod(
        new Error("session/list rejected"),
        "session/fork"
      )
    ).toBe(false)
  })

  it("treats generic 'session ... not supported' as unsupported when inferred method is null", () => {
    expect(
      isExternalAgentSessionExtensionUnsupportedForMethod(
        new Error("session-related thing not supported"),
        "session/fork"
      )
    ).toBe(true)
  })

  it("returns false for unrelated errors", () => {
    expect(
      isExternalAgentSessionExtensionUnsupportedForMethod(
        new Error("network broken"),
        "session/fork"
      )
    ).toBe(false)
    expect(isExternalAgentSessionExtensionUnsupportedForMethod(undefined, "session/list")).toBe(
      false
    )
  })
})

describe("isExternalAgentSessionExtensionUnsupportedError", () => {
  it("returns true for the typed error", () => {
    expect(
      isExternalAgentSessionExtensionUnsupportedError(
        new ExternalAgentUnsupportedSessionExtensionError("session/fork")
      )
    ).toBe(true)
  })

  it("returns true when an inferred method exists", () => {
    expect(isExternalAgentSessionExtensionUnsupportedError(new Error("session/list failed"))).toBe(
      true
    )
  })

  it("matches 'does not support session listing'", () => {
    expect(
      isExternalAgentSessionExtensionUnsupportedError(new Error("does not support session listing"))
    ).toBe(true)
  })

  it("matches 'does not support session resume'", () => {
    expect(
      isExternalAgentSessionExtensionUnsupportedError(new Error("does not support session resume"))
    ).toBe(true)
  })

  it("matches 'does not support session forking'", () => {
    expect(
      isExternalAgentSessionExtensionUnsupportedError(new Error("does not support session forking"))
    ).toBe(true)
  })

  it("matches generic 'session ... unsupported'", () => {
    expect(
      isExternalAgentSessionExtensionUnsupportedError(new Error("session feature unsupported"))
    ).toBe(true)
  })

  it("matches 'session ... method not found'", () => {
    expect(
      isExternalAgentSessionExtensionUnsupportedError(new Error("session/list method not found"))
    ).toBe(true)
  })

  it("returns false for empty/unrelated errors", () => {
    expect(isExternalAgentSessionExtensionUnsupportedError(undefined)).toBe(false)
    expect(isExternalAgentSessionExtensionUnsupportedError(new Error(""))).toBe(false)
    expect(isExternalAgentSessionExtensionUnsupportedError(new Error("network down"))).toBe(false)
  })
})
