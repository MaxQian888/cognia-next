import {
  automationErrorMessage,
  elementRef,
  elementRefValue,
  keyChord,
  parseAutomationError,
} from "./types"
import type { GetAppStateOptions, InstructionPack, UiTreeProjectionKind } from "./types"

describe("app-state projection types", () => {
  it("keeps model and inspector projections explicit", () => {
    const projections: UiTreeProjectionKind[] = ["model", "inspector"]
    const options: GetAppStateOptions = { projection: projections[1], maxNodes: 25_000 }

    expect(options).toEqual({ projection: "inspector", maxNodes: 25_000 })
  })

  it("keeps instruction packs navigation-only", () => {
    const pack: InstructionPack = {
      bundleId: "com.apple.Notes",
      version: 1,
      guidance: ["Prefer stable AX identifiers."],
      preferredLocators: [
        {
          purpose: "new note",
          automationId: "new-note",
          role: "AXButton",
          name: null,
        },
      ],
      loadingRoleHints: ["AXProgressIndicator"],
    }

    expect(Object.keys(pack)).toEqual([
      "bundleId",
      "version",
      "guidance",
      "preferredLocators",
      "loadingRoleHints",
    ])
  })
})

describe("element ref helpers", () => {
  it("round-trips through elementRef / elementRefValue", () => {
    const r = elementRef("abc")
    expect(elementRefValue(r)).toBe("abc")
  })

  it("is a bare string on the wire, not a one-element tuple", () => {
    // Rust declares `pub struct ElementRef(pub String)`. serde renders a
    // newtype struct transparently, so the wire value is `"abc"`. Modelling it
    // as `["abc"]` meant the renderer sent a shape the backend rejects, and
    // `elementRefValue` read back the first *character* of a real ref.
    // Pinned on the Rust side too, in `types.rs`:
    // `newtype_refs_serialize_as_bare_strings`.
    expect(JSON.stringify(elementRef("abc"))).toBe('"abc"')
  })
})

describe("keyChord helper", () => {
  it("is a bare string on the wire", () => {
    // Same newtype-struct reasoning as ElementRef above. This assertion used to
    // demand `["ctrl+t"]`, which is exactly the shape the Rust side refuses.
    expect(keyChord("ctrl+t")).toBe("ctrl+t")
    expect(JSON.stringify(keyChord("ctrl+t"))).toBe('"ctrl+t"')
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
