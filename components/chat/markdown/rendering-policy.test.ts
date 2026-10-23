import {
  chatMarkdownSanitizeSchema,
  chatMarkdownUrlTransform,
  untrustedMarkdownUrlTransform,
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

  it("keeps inline highlight, underline and abbreviation markup", () => {
    expect(chatMarkdownSanitizeSchema.tagNames).toEqual(
      expect.arrayContaining(["mark", "u", "abbr"])
    )
    expect(chatMarkdownSanitizeSchema.attributes?.abbr).toContain("title")
  })
})

describe("untrustedMarkdownUrlTransform", () => {
  it.each([
    ["https://x.test/a", "href", "https://x.test/a"],
    ["http://x.test/a.png", "src", "http://x.test/a.png"],
    ["mailto:a@b.test", "href", "mailto:a@b.test"],
    ["data:image/png;base64,AA", "src", "data:image/png;base64,AA"],
    ["data:image/png;base64,AA", "href", ""],
    ["file:///etc/passwd", "href", ""],
    ["tel:+1", "href", ""],
    ["javascript:alert(1)", "href", ""],
    ["src/secret.ts", "href", ""],
    ["/settings", "href", ""],
  ])("%s as %s → %s", (url, key, expected) => {
    expect(untrustedMarkdownUrlTransform(url, key)).toBe(expected)
  })
})
