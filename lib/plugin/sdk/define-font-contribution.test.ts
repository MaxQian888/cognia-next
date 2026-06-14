import { defineFontContribution } from "./define-font-contribution"

describe("defineFontContribution", () => {
  it("returns the font contribution unchanged (pure pass-through)", () => {
    const f = defineFontContribution({
      family: "Inter",
      files: [{ weight: 400, src: "assets/Inter-Regular.woff2" }],
      display: "swap",
    })
    expect(f).toEqual({
      family: "Inter",
      files: [{ weight: 400, src: "assets/Inter-Regular.woff2" }],
      display: "swap",
    })
  })

  it("preserves multiple weights/styles and unicodeRange", () => {
    const f = defineFontContribution({
      family: "Source Serif",
      files: [
        { weight: 400, style: "normal", src: "a.woff2" },
        { weight: 700, style: "italic", src: "b.woff2" },
      ],
      unicodeRange: "U+0000-00FF",
    })
    expect(f.files).toHaveLength(2)
    expect(f.unicodeRange).toBe("U+0000-00FF")
  })
})
