import { normalizeColor, normalizeInkColor } from "./color"

describe("normalizeInkColor", () => {
  it("accepts the Claude formats normalizeColor handles", () => {
    expect(normalizeInkColor("#BD93F9")).toBe("#bd93f9")
    expect(normalizeInkColor("rgb(0,255,0)")).toBe("#00ff00")
    expect(normalizeInkColor("ansi:cyanBright")).toBe("cyanBright")
  })
  it("additionally accepts bare Ink colour keywords (built-in palette authors them)", () => {
    expect(normalizeInkColor("cyan")).toBe("cyan")
    expect(normalizeInkColor("gray")).toBe("gray")
    expect(normalizeInkColor("grey")).toBe("grey")
    expect(normalizeInkColor("whiteBright")).toBe("whiteBright")
  })
  it("returns null for genuinely unknown values", () => {
    expect(normalizeInkColor("not-a-color")).toBeNull()
    expect(normalizeInkColor("")).toBeNull()
  })
})

describe("normalizeColor", () => {
  it("passes 6-digit hex through, lowercased", () => {
    expect(normalizeColor("#BD93F9")).toBe("#bd93f9")
  })

  it("expands 3-digit hex to 6", () => {
    expect(normalizeColor("#f0a")).toBe("#ff00aa")
  })

  it("converts rgb(r,g,b) to hex", () => {
    expect(normalizeColor("rgb(215, 119, 87)")).toBe("#d77757")
    expect(normalizeColor("rgb(0,0,0)")).toBe("#000000")
  })

  it("maps ansi:<name> to the bare ANSI keyword", () => {
    expect(normalizeColor("ansi:red")).toBe("red")
    expect(normalizeColor("ansi:cyanBright")).toBe("cyanBright")
  })

  it("converts ansi256(n) in the 16-colour range to a keyword", () => {
    expect(normalizeColor("ansi256(1)")).toBe("red")
    expect(normalizeColor("ansi256(12)")).toBe("blueBright")
  })

  it("converts ansi256(n) in the colour cube to hex", () => {
    // 16 = first cube cell = #000000
    expect(normalizeColor("ansi256(16)")).toBe("#000000")
    // 231 = last cube cell = #ffffff
    expect(normalizeColor("ansi256(231)")).toBe("#ffffff")
  })

  it("converts ansi256(n) in the grayscale ramp to hex", () => {
    expect(normalizeColor("ansi256(232)")).toBe("#080808")
    expect(normalizeColor("ansi256(255)")).toBe("#eeeeee")
  })

  it("returns null for unknown / malformed values (caller ignores, like Claude)", () => {
    expect(normalizeColor("not-a-color")).toBeNull()
    expect(normalizeColor("rgb(300)")).toBeNull()
    expect(normalizeColor("ansi256(999)")).toBeNull()
    expect(normalizeColor("#12")).toBeNull()
    expect(normalizeColor("")).toBeNull()
  })
})
