import { OUTPUT_STYLES } from "./schema"
import { composeSystemPrompt, outputStyleInstruction } from "./output-style"

describe("outputStyleInstruction", () => {
  it("returns null for default / undefined", () => {
    expect(outputStyleInstruction(undefined)).toBeNull()
    expect(outputStyleInstruction("default")).toBeNull()
  })

  it("returns a non-empty instruction for every non-default style", () => {
    for (const style of OUTPUT_STYLES) {
      if (style === "default") continue
      expect(outputStyleInstruction(style)?.length ?? 0).toBeGreaterThan(0)
    }
  })
})

describe("composeSystemPrompt", () => {
  it("returns the base unchanged for the default style", () => {
    expect(composeSystemPrompt("You are helpful.", "default")).toBe("You are helpful.")
    expect(composeSystemPrompt("You are helpful.", undefined)).toBe("You are helpful.")
  })

  it("appends the style instruction after the base prompt", () => {
    const out = composeSystemPrompt("Base.", "concise")
    expect(out?.startsWith("Base.")).toBe(true)
    expect(out).toContain(outputStyleInstruction("concise")!)
    expect(out).toContain("\n\n")
  })

  it("uses only the style instruction when there is no base prompt", () => {
    expect(composeSystemPrompt(undefined, "learning")).toBe(outputStyleInstruction("learning"))
    expect(composeSystemPrompt("", "learning")).toBe(outputStyleInstruction("learning"))
  })

  it("returns undefined when neither a base nor a style applies", () => {
    expect(composeSystemPrompt(undefined, "default")).toBeUndefined()
    expect(composeSystemPrompt("", undefined)).toBeUndefined()
  })
})
