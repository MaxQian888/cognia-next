import { detectDelimiter, detectLanguage, markdownToPlainText, parseMarkdown } from "./index"

describe("document parser barrel", () => {
  it("re-exports parser utilities from individual parser modules", () => {
    expect(detectLanguage("src/example.ts")).toBe("typescript")
    expect(detectDelimiter("name;value\nalpha;1")).toBe(";")
    expect(markdownToPlainText("# Title\n\n**Body** text")).toContain("Body text")
  })

  it("re-exports markdown parser behavior through the barrel", () => {
    const parsed = parseMarkdown("# Title\n\n- item")
    expect(parsed.title).toBe("Title")
    expect(parsed.sections).toEqual(expect.any(Array))
  })
})
