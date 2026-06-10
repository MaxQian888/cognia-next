/**
 * @jest-environment node
 */
import { collapsePaste, expandPastes, placeholderFor } from "./paste-collapse"

describe("collapsePaste", () => {
  it("leaves a small paste inline", () => {
    expect(collapsePaste("a\nb", 1)).toEqual({
      isLarge: false,
      lineCount: 2,
      display: "a\nb",
      stored: "a\nb",
    })
  })
  it("collapses a large paste to a placeholder", () => {
    const text = "1\n2\n3\n4\n5\n6"
    const r = collapsePaste(text, 7)
    expect(r.isLarge).toBe(true)
    expect(r.lineCount).toBe(6)
    expect(r.display).toBe("[Pasted 6 lines #7]")
    expect(r.stored).toBe(text)
  })
  it("respects a custom threshold", () => {
    expect(collapsePaste("a\nb\nc", 1, 2).isLarge).toBe(true)
  })
})

describe("placeholderFor", () => {
  it("formats the placeholder", () => {
    expect(placeholderFor(12, 3)).toBe("[Pasted 12 lines #3]")
  })
})

describe("expandPastes", () => {
  it("substitutes placeholders with their full bodies", () => {
    const pastes = { "[Pasted 3 lines #1]": "x\ny\nz" }
    expect(expandPastes("see [Pasted 3 lines #1] end", pastes)).toBe("see x\ny\nz end")
  })
  it("leaves text without placeholders unchanged", () => {
    expect(expandPastes("plain", { "[Pasted 2 lines #1]": "a\nb" })).toBe("plain")
  })
})
