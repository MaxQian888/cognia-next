import { FOLD_CHARACTERS, parseBlocks, parseInline, plainText, shouldFold } from "./markdown-inline"

describe("parseInline", () => {
  it("leaves plain prose as one text node", () => {
    expect(parseInline("Ships the notice area.")).toEqual([
      { kind: "text", text: "Ships the notice area." },
    ])
  })

  it("reads strong, emphasis and code", () => {
    expect(parseInline("A **bold** claim, _quietly_ made in `code`.")).toEqual([
      { kind: "text", text: "A " },
      { kind: "strong", children: [{ kind: "text", text: "bold" }] },
      { kind: "text", text: " claim, " },
      { kind: "em", children: [{ kind: "text", text: "quietly" }] },
      { kind: "text", text: " made in " },
      { kind: "code", text: "code" },
      { kind: "text", text: "." },
    ])
  })

  it("accepts asterisk emphasis too", () => {
    expect(parseInline("now *stopping* until")).toEqual([
      { kind: "text", text: "now " },
      { kind: "em", children: [{ kind: "text", text: "stopping" }] },
      { kind: "text", text: " until" },
    ])
  })

  it("does not italicise the underscores inside identifiers", () => {
    expect(parseInline("renames snake_case_name to camelCase")).toEqual([
      { kind: "text", text: "renames snake_case_name to camelCase" },
    ])
  })

  it("does not treat a lone asterisk as emphasis", () => {
    expect(parseInline("a * b and c")).toEqual([{ kind: "text", text: "a * b and c" }])
  })

  it("keeps markup inside code spans literal", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ kind: "code", text: "**not bold**" }])
  })

  it("nests emphasis inside strong", () => {
    expect(parseInline("**very _much_ so**")).toEqual([
      {
        kind: "strong",
        children: [
          { kind: "text", text: "very " },
          { kind: "em", children: [{ kind: "text", text: "much" }] },
          { kind: "text", text: " so" },
        ],
      },
    ])
  })

  it("renders anything it does not know as text, including HTML", () => {
    expect(plainText(parseInline("keeps <details> closed [link](x)"))).toBe(
      "keeps <details> closed [link](x)"
    )
  })
})

describe("parseBlocks", () => {
  it("splits paragraphs on blank lines and joins wrapped lines", () => {
    expect(parseBlocks("One line\nstill one.\n\nTwo.")).toEqual([
      { kind: "paragraph", children: [{ kind: "text", text: "One line still one." }] },
      { kind: "paragraph", children: [{ kind: "text", text: "Two." }] },
    ])
  })

  it("reads bullet lists, with continuation lines", () => {
    expect(parseBlocks("Intro:\n- first\n  wrapped\n- **second**")).toEqual([
      { kind: "paragraph", children: [{ kind: "text", text: "Intro:" }] },
      {
        kind: "list",
        items: [
          [{ kind: "text", text: "first wrapped" }],
          [{ kind: "strong", children: [{ kind: "text", text: "second" }] }],
        ],
      },
    ])
  })

  it("tolerates CRLF line endings", () => {
    expect(parseBlocks("a\r\n\r\nb")).toHaveLength(2)
  })

  it("returns nothing for an empty body", () => {
    expect(parseBlocks("")).toEqual([])
  })
})

describe("shouldFold", () => {
  it("shows a short single paragraph in full", () => {
    expect(shouldFold(parseBlocks("Short."))).toBe(false)
  })

  it("folds a long paragraph", () => {
    expect(shouldFold(parseBlocks("x".repeat(FOLD_CHARACTERS + 1)))).toBe(true)
  })

  it("folds anything with more than one block", () => {
    expect(shouldFold(parseBlocks("a\n\nb"))).toBe(true)
  })

  it("folds a bare list", () => {
    expect(shouldFold(parseBlocks("- a\n- b"))).toBe(true)
  })

  it("does not fold nothing", () => {
    expect(shouldFold([])).toBe(false)
  })
})
