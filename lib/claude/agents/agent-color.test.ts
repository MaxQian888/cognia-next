import { AGENT_COLOR_NAMES, isNamedAgentColor, normalizeAgentColor } from "./agent-color"

describe("normalizeAgentColor", () => {
  it("accepts every palette name, case-insensitively and trimmed", () => {
    for (const name of AGENT_COLOR_NAMES) {
      expect(normalizeAgentColor(name)).toBe(name)
      expect(normalizeAgentColor(`  ${name.toUpperCase()} `)).toBe(name)
    }
  })

  it("collapses the spellings other tools use onto the palette", () => {
    expect(normalizeAgentColor("magenta")).toBe("purple")
    expect(normalizeAgentColor("Violet")).toBe("purple")
    expect(normalizeAgentColor("grey")).toBe("gray")
    expect(normalizeAgentColor("teal")).toBe("cyan")
    expect(normalizeAgentColor("amber")).toBe("orange")
  })

  it("keeps six-digit hex (lower-cased) and expands three-digit hex", () => {
    expect(normalizeAgentColor("#FFA657")).toBe("#ffa657")
    expect(normalizeAgentColor("#abc")).toBe("#aabbcc")
  })

  it("rejects anything else as undeclared", () => {
    expect(normalizeAgentColor("")).toBeUndefined()
    expect(normalizeAgentColor("   ")).toBeUndefined()
    expect(normalizeAgentColor("chartreuse")).toBeUndefined()
    expect(normalizeAgentColor("#12345")).toBeUndefined()
    expect(normalizeAgentColor("#gggggg")).toBeUndefined()
    expect(normalizeAgentColor(42)).toBeUndefined()
    expect(normalizeAgentColor(null)).toBeUndefined()
  })
})

describe("isNamedAgentColor", () => {
  it("separates palette names from hex values", () => {
    expect(isNamedAgentColor("cyan")).toBe(true)
    expect(isNamedAgentColor("#aabbcc")).toBe(false)
  })
})
