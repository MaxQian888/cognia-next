/**
 * @jest-environment node
 */
import { errorMessage, truncate } from "./shared"

describe("errorMessage", () => {
  it("reads an Error's message and stringifies anything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
    expect(errorMessage("plain")).toBe("plain")
    expect(errorMessage(42)).toBe("42")
  })
})

describe("truncate", () => {
  it("returns short text unchanged and ellipsises long text", () => {
    expect(truncate("hi")).toBe("hi")
    expect(truncate("  spaced  ")).toBe("spaced")
    expect(truncate("abcdef", 4)).toBe("abc…")
  })
})
