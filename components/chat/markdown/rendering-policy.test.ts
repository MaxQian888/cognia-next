import {
  chatMarkdownSanitizeSchema,
  chatMarkdownUrlTransform,
  chatStreamdownRehypePlugins,
} from "./rendering-policy"

describe("shared Markdown rendering policy", () => {
  it("allows only the extra URL forms used by rich chat content", () => {
    expect(chatMarkdownUrlTransform("tel:+12025550123", "href")).toBe("tel:+12025550123")
    expect(chatMarkdownUrlTransform("file:///repo/README.md", "href")).toBe(
      "file:///repo/README.md"
    )
    expect(chatMarkdownUrlTransform("data:image/png;base64,AA==", "src")).toBe(
      "data:image/png;base64,AA=="
    )
    expect(chatMarkdownUrlTransform("data:text/html;base64,AA==", "src")).toBe("")
    expect(chatMarkdownUrlTransform("javascript:alert(1)", "href")).toBe("")
  })

  it("shares list, table, and protocol allowances with Streamdown", () => {
    expect(chatMarkdownSanitizeSchema.attributes?.ol).toContain("start")
    expect(chatMarkdownSanitizeSchema.attributes?.th).toEqual(
      expect.arrayContaining(["align", "rowSpan", "colSpan"])
    )
    expect(chatMarkdownSanitizeSchema.protocols?.href).toEqual(
      expect.arrayContaining(["tel", "file"])
    )
    expect(chatStreamdownRehypePlugins).toHaveLength(2)
  })
})
