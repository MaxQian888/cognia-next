import {
  relocateDocumentScroll,
  clampScroll,
  lineCount,
  maxScroll,
  positionLabel,
  prepareDocumentLines,
} from "./document-view"

describe("prepareDocumentLines", () => {
  it("tokenizes markdown bodies into structured lines", () => {
    const prepared = prepareDocumentLines("# Title\n\nbody text", "markdown")
    expect(prepared.kind).toBe("markdown")
    if (prepared.kind === "markdown") {
      expect(prepared.lines[0]).toMatchObject({ kind: "heading", level: 1 })
    }
  })

  it.each([
    "# Built-in tools\n\nRead and edit files.",
    "\n\n# **Built-in** tools\n\nRead and edit files.",
    "Built-in tools\n===\n\nRead and edit files.",
    "## Built-in   tools\n\nRead and edit files.",
  ])("omits a duplicate leading title and its blank spacing", (body) => {
    const prepared = prepareDocumentLines(body, "markdown", undefined, "Built-in tools")
    expect(prepared).toMatchObject({ kind: "markdown", lines: [{ kind: "paragraph" }] })
    expect(lineCount(prepared)).toBe(1)
  })

  it.each([
    "# Different heading\n\nBody",
    "Intro\n\n# Built-in tools",
    "Built-in tools\n\nBody",
    "# [Built-in tools](https://example.com)\n\nBody",
  ])("preserves distinct headings, prose, and linked information", (body) => {
    expect(prepareDocumentLines(body, "markdown", undefined, "Built-in tools")).toEqual(
      prepareDocumentLines(body, "markdown")
    )
  })

  it("removes only the first matching heading, retaining later sections", () => {
    const prepared = prepareDocumentLines(
      "# Title\n\n## Title\n\nBody",
      "markdown",
      undefined,
      "Title"
    )
    expect(prepared).toMatchObject({
      kind: "markdown",
      lines: [{ kind: "heading", level: 2 }, { kind: "paragraph" }],
    })
  })

  it("handles an empty body and a title-only document", () => {
    expect(lineCount(prepareDocumentLines("", "markdown", undefined, "Title"))).toBe(0)
    expect(lineCount(prepareDocumentLines("# Title\n", "markdown", undefined, "Title"))).toBe(0)
    expect(prepareDocumentLines("# Title", "text", undefined, "Title")).toEqual({
      kind: "text",
      lines: ["# Title"],
    })
  })

  it("splits text bodies into raw lines", () => {
    const prepared = prepareDocumentLines("a\nb\nc", "text")
    expect(prepared).toEqual({ kind: "text", lines: ["a", "b", "c"] })
  })

  it("drops a single trailing newline so there is no blank tail row", () => {
    const prepared = prepareDocumentLines("a\nb\n", "text")
    expect(prepared).toEqual({ kind: "text", lines: ["a", "b"] })
  })

  it("highlights text when a language is given but preserves the line text", () => {
    const prepared = prepareDocumentLines("const x = 1\nconst y = 2", "text", "js")
    expect(prepared.kind).toBe("text")
    // Highlighting only adds ANSI colour escapes; stripping them recovers the
    // original two lines.

    const stripped = (prepared as { lines: string[] }).lines.map((l) =>
      l.replace(/\[[0-9;]*m/g, "")
    )
    expect(stripped).toEqual(["const x = 1", "const y = 2"])
  })
})

describe("scroll math", () => {
  it("counts lines", () => {
    expect(lineCount({ kind: "text", lines: ["a", "b"] })).toBe(2)
  })

  it("computes the largest valid scroll offset", () => {
    expect(maxScroll(100, 20)).toBe(80)
    expect(maxScroll(10, 20)).toBe(0)
    expect(maxScroll(0, 20)).toBe(0)
  })

  it("clamps scroll into range and floors fractions", () => {
    expect(clampScroll(-5, 100, 20)).toBe(0)
    expect(clampScroll(200, 100, 20)).toBe(80)
    expect(clampScroll(10.9, 100, 20)).toBe(10)
    expect(clampScroll(NaN, 100, 20)).toBe(0)
  })
})

describe("positionLabel", () => {
  it("reports 'all' when the document fits the viewport", () => {
    expect(positionLabel(0, 20, 10)).toBe("all")
  })

  it("reports 'empty' for an empty document", () => {
    expect(positionLabel(0, 20, 0)).toBe("empty")
  })

  it("shows a 1-based window range", () => {
    expect(positionLabel(0, 20, 100)).toBe("1–20 / 100")
    expect(positionLabel(80, 20, 100)).toBe("81–100 / 100")
  })

  it("clamps an over-scrolled offset before labelling", () => {
    expect(positionLabel(999, 20, 100)).toBe("81–100 / 100")
  })
})

describe("relocateDocumentScroll", () => {
  it("keeps the top at the top", () => {
    expect(relocateDocumentScroll(["a"], ["new", "a"], 0, 1)).toBe(0)
  })
  it("anchors inserted and removed rows to visible text", () => {
    expect(relocateDocumentScroll(["a", "b", "c"], ["new", "a", "b", "c"], 1, 1)).toBe(2)
    expect(relocateDocumentScroll(["a", "b", "c"], ["b", "c"], 1, 1)).toBe(0)
  })
  it("chooses the nearest occurrence of repeated rows", () => {
    expect(relocateDocumentScroll(["a", "b", "b", "c"], ["b", "x", "b", "c"], 2, 1)).toBe(2)
  })
  it("clamps when the anchor disappears or is blank", () => {
    expect(relocateDocumentScroll(["a", "b", "c"], ["x"], 2, 1)).toBe(0)
    expect(relocateDocumentScroll(["a", "", "c"], ["x", "y", "z"], 1, 1)).toBe(1)
  })
  it("preserves text offset after wrapping and skips empty rows", () => {
    expect(relocateDocumentScroll(["ab", "cd", "ef", "gh"], ["abcd", "efgh"], 2, 1)).toBe(1)
    expect(relocateDocumentScroll(["ab", "cd"], ["", "a", "b", "c", "d"], 1, 1)).toBe(3)
  })
})
