import {
  automationErrorMessage,
  elementRef,
  elementRefValue,
  keyChord,
  parseAutomationError,
} from "./types"

describe("element ref helpers", () => {
  it("round-trips through elementRef / elementRefValue", () => {
    const r = elementRef("abc")
    expect(elementRefValue(r)).toBe("abc")
  })
})

describe("keyChord helper", () => {
  it("wraps a raw string", () => {
    expect(keyChord("ctrl+t")).toEqual(["ctrl+t"])
  })
})

describe("parseAutomationError", () => {
  it("parses every Rust-side variant", () => {
    const cases = [
      `{"code":"UNSUPPORTED_PLATFORM"}`,
      `{"code":"KILL_SWITCH_ACTIVE"}`,
      `{"code":"PERMISSION_DENIED","reason":"surface disabled"}`,
      `{"code":"USER_DECLINED"}`,
      `{"code":"WHITELIST_MISS"}`,
      `{"code":"ELEMENT_NOT_FOUND"}`,
      `{"code":"STALE_ELEMENT"}`,
      `{"code":"BACKEND_ERROR","message":"hr=0x80004005"}`,
      `{"code":"INTERNAL","message":"oops"}`,
    ]
    for (const raw of cases) {
      const err = parseAutomationError(raw)
      expect(err).not.toBeNull()
      expect(err!.code).toMatch(/^[A-Z_]+$/)
    }
  })

  it("returns null for non-JSON strings", () => {
    expect(parseAutomationError("plain text")).toBeNull()
  })

  it("returns null for non-string input", () => {
    expect(parseAutomationError(42)).toBeNull()
    expect(parseAutomationError({})).toBeNull()
    expect(parseAutomationError(undefined)).toBeNull()
  })

  it("returns null for JSON without a code field", () => {
    expect(parseAutomationError(`{"reason":"X"}`)).toBeNull()
  })
})

describe("automationErrorMessage", () => {
  it("produces a sentence for every variant", () => {
    const variants = [
      { code: "UNSUPPORTED_PLATFORM" as const },
      { code: "KILL_SWITCH_ACTIVE" as const },
      { code: "PERMISSION_DENIED" as const, reason: "off" },
      { code: "USER_DECLINED" as const },
      { code: "WHITELIST_MISS" as const },
      { code: "ELEMENT_NOT_FOUND" as const },
      { code: "STALE_ELEMENT" as const },
      { code: "BACKEND_ERROR" as const, message: "hr=…" },
      { code: "INTERNAL" as const, message: "oops" },
    ]
    for (const v of variants) {
      const msg = automationErrorMessage(v)
      expect(msg.length).toBeGreaterThan(0)
    }
  })
})
