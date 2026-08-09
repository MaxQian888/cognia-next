import {
  isPluginAdapterError,
  PluginAdapterError,
  pluginAdapterError,
  type PluginAdapterErrorCode,
} from "./adapter-error"
import { CANONICAL_PLUGIN_ERROR_CODES } from "../contracts/generated"

describe("PluginAdapterError", () => {
  it("carries the code, message, and optional hint", () => {
    const error = new PluginAdapterError(
      "SECRET_MISSING",
      "AI_KEY not resolved",
      "set it in the settings form"
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(PluginAdapterError)
    expect(error.name).toBe("PluginAdapterError")
    expect(error.code).toBe("SECRET_MISSING")
    expect(error.message).toBe("AI_KEY not resolved")
    expect(error.hint).toBe("set it in the settings form")
  })

  it("uses the code as the fallback message when none is supplied", () => {
    const error = new PluginAdapterError("TIMEOUT")
    expect(error.message).toBe("TIMEOUT")
    expect(error.hint).toBeUndefined()
  })

  it("serializes cleanly to JSON without leaking a stack", () => {
    const error = new PluginAdapterError("PROCESS_LIMIT", "quota exceeded")
    expect(error.toJSON()).toEqual({
      name: "PluginAdapterError",
      code: "PROCESS_LIMIT",
      message: "quota exceeded",
    })
  })

  it("preserves an explicit hint in the JSON payload", () => {
    const error = new PluginAdapterError("STALE_REVISION", "rev mismatch", "requery UI state")
    expect(error.toJSON()).toEqual({
      name: "PluginAdapterError",
      code: "STALE_REVISION",
      message: "rev mismatch",
      hint: "requery UI state",
    })
  })
})

describe("pluginAdapterError factory", () => {
  it("mirrors the constructor with brokerError-style ergonomics", () => {
    const error = pluginAdapterError("PERMISSION_DENIED", "not allowed")
    expect(error).toBeInstanceOf(PluginAdapterError)
    expect(error.code).toBe("PERMISSION_DENIED")
    expect(error.message).toBe("not allowed")
  })
})

describe("isPluginAdapterError", () => {
  it("classifies a real instance as an adapter error", () => {
    expect(isPluginAdapterError(new PluginAdapterError("TIMEOUT"))).toBe(true)
  })

  it("classifies a serialized cross-realm payload as an adapter error", () => {
    const payload = new PluginAdapterError("OUTPUT_TRUNCATED", "too long").toJSON()
    expect(isPluginAdapterError(payload)).toBe(true)
  })

  it("rejects a payload whose code is not in the canonical set", () => {
    expect(
      isPluginAdapterError({
        name: "PluginAdapterError",
        code: "MADE_UP_CODE",
        message: "nope",
      })
    ).toBe(false)
  })

  it("rejects plain errors, nullish values, and non-objects", () => {
    expect(isPluginAdapterError(new Error("plain"))).toBe(false)
    expect(isPluginAdapterError(null)).toBe(false)
    expect(isPluginAdapterError(undefined)).toBe(false)
    expect(isPluginAdapterError("PluginAdapterError")).toBe(false)
    expect(isPluginAdapterError(42)).toBe(false)
  })
})

describe("canonical error-code registry", () => {
  it("mirrors every declared code as a valid PluginAdapterErrorCode", () => {
    for (const code of CANONICAL_PLUGIN_ERROR_CODES) {
      const error = pluginAdapterError(code as PluginAdapterErrorCode)
      expect(error.code).toBe(code)
      expect(isPluginAdapterError(error)).toBe(true)
    }
  })

  it("keeps the eight Phase-1 codes registered", () => {
    expect(CANONICAL_PLUGIN_ERROR_CODES).toEqual(
      expect.arrayContaining([
        "DEPENDENCY_MISSING",
        "SECRET_MISSING",
        "PERMISSION_DENIED",
        "TARGET_NOT_ALLOWED",
        "STALE_REVISION",
        "PROCESS_LIMIT",
        "TIMEOUT",
        "OUTPUT_TRUNCATED",
      ])
    )
  })
})
