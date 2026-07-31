import { lineColToOffset } from "./offset"

describe("lineColToOffset", () => {
  const doc = "const a = 1\nlet b = 2\n  c()"

  it("maps the first line by column directly", () => {
    expect(lineColToOffset(doc, 1, 0)).toBe(0)
    expect(lineColToOffset(doc, 1, 6)).toBe(6)
  })

  it("treats line <= 1 as the first line", () => {
    expect(lineColToOffset(doc, 0, 3)).toBe(3)
  })

  it("walks newlines to later lines", () => {
    // line 2 starts after "const a = 1\n" (12 chars)
    expect(lineColToOffset(doc, 2, 0)).toBe(12)
    expect(lineColToOffset(doc, 2, 4)).toBe(16)
    // line 3 ("  c()") starts at offset 22; column 2 → offset 24
    expect(lineColToOffset(doc, 3, 2)).toBe(24)
  })

  it("computes a concrete line-3 offset", () => {
    // "const a = 1\n" = 12, "let b = 2\n" = 10 → line 3 starts at 22
    expect(lineColToOffset(doc, 3, 0)).toBe(22)
    expect(lineColToOffset(doc, 3, 2)).toBe(24)
  })

  it("clamps a column past the document end", () => {
    expect(lineColToOffset(doc, 3, 999)).toBe(doc.length)
  })

  it("clamps a line past the document end to the last line start + column", () => {
    expect(lineColToOffset(doc, 99, 0)).toBe(22)
  })

  it("clamps negative columns to the line start", () => {
    expect(lineColToOffset(doc, 2, -5)).toBe(12)
  })

  it("handles an empty document", () => {
    expect(lineColToOffset("", 1, 0)).toBe(0)
    expect(lineColToOffset("", 5, 5)).toBe(0)
  })
})
