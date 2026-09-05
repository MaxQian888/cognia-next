import {
  buildImportWarnings,
  importCanvasDocument,
  resolveImportLanguage,
  titleFromFilename,
  type CanvasImportDeps,
} from "./document-import"

function fileOf(name: string, body = "hello", type = "text/plain"): File {
  return new File([body], name, { type })
}

describe("titleFromFilename", () => {
  it("drops the extension and the directory", () => {
    expect(titleFromFilename("notes/Q4 plan.md")).toBe("Q4 plan")
    expect(titleFromFilename("C:\\docs\\report.docx")).toBe("report")
  })

  it("keeps a dotfile whole rather than emptying it", () => {
    expect(titleFromFilename(".eslintrc")).toBe(".eslintrc")
  })

  it("falls back to the filename when the stem is blank", () => {
    expect(titleFromFilename("   .md")).toBe("   .md")
  })
})

describe("resolveImportLanguage", () => {
  it("maps an extension onto the editor's own language set", () => {
    expect(resolveImportLanguage("app.py", "code")).toEqual({ language: "python", type: "code" })
    expect(resolveImportLanguage("Component.tsx", "code")).toEqual({
      language: "tsx",
      type: "code",
    })
  })

  it("opens markdown and latex as writing surfaces, not code", () => {
    expect(resolveImportLanguage("notes.md", "markdown")).toEqual({
      language: "markdown",
      type: "text",
    })
    expect(resolveImportLanguage("paper.tex", "text")).toEqual({
      language: "latex",
      type: "text",
    })
  })

  it("opens a converted binary as markdown whatever it started as", () => {
    // The body is Markdown by the time it gets here, so asking the editor for a
    // `pdf` or `word` grammar would ask for one that does not exist.
    expect(resolveImportLanguage("report.pdf", "pdf")).toEqual({
      language: "markdown",
      type: "text",
    })
    expect(resolveImportLanguage("deck.pptx", "presentation")).toEqual({
      language: "markdown",
      type: "text",
    })
  })

  it("falls back to markdown for an extension it does not know", () => {
    expect(resolveImportLanguage("archive.xyz", "text")).toEqual({
      language: "markdown",
      type: "text",
    })
  })
})

describe("buildImportWarnings", () => {
  it("says a binary format was converted", () => {
    const warnings = buildImportWarnings({ documentType: "pdf", content: "text" })
    expect(warnings).toEqual([{ code: "converted-to-markdown", message: "pdf" }])
  })

  it("says nothing for a text file that arrived intact", () => {
    expect(buildImportWarnings({ documentType: "markdown", content: "# hi" })).toEqual([])
  })

  it("flags a file that produced no readable text", () => {
    const warnings = buildImportWarnings({ documentType: "pdf", content: "   " })
    expect(warnings.map((w) => w.code)).toEqual(["converted-to-markdown", "empty"])
  })

  it("passes parser errors and warnings through, but not its notes", () => {
    const warnings = buildImportWarnings({
      documentType: "word",
      content: "body",
      diagnostics: [
        { code: "unsupported_feature", severity: "warning", message: "Dropped a text box." },
        { code: "parser_info", severity: "info", message: "Used the fast path." },
      ],
    })
    expect(warnings.map((w) => w.message)).toEqual(["word", "Dropped a text box."])
  })
})

describe("importCanvasDocument", () => {
  function deps(overrides: Partial<Awaited<ReturnType<CanvasImportDeps["processDocument"]>>> = {}) {
    const processDocument = jest.fn(async () => ({
      type: "markdown" as const,
      content: "# hello",
      ...overrides,
    }))
    return { processDocument } as unknown as CanvasImportDeps & {
      processDocument: jest.Mock
    }
  }

  it("reads a text file as text so its bytes survive exactly", async () => {
    const d = deps()
    await importCanvasDocument(fileOf("notes.md", "# hello"), d)
    // Routing a text file through the binary path would normalise whitespace
    // and line endings.
    expect(typeof d.processDocument.mock.calls[0][2]).toBe("string")
  })

  it("reads a binary file as bytes", async () => {
    const d = deps({ type: "pdf", content: "converted" })
    await importCanvasDocument(fileOf("report.pdf", "%PDF-1.4", "application/pdf"), d)
    expect(d.processDocument.mock.calls[0][2]).toBeInstanceOf(ArrayBuffer)
  })

  it("prefers the parsed title over the filename", async () => {
    const d = deps({ metadata: { title: "Quarterly Report" } })
    const result = await importCanvasDocument(fileOf("q4-final-v2.md"), d)
    expect(result.title).toBe("Quarterly Report")
  })

  it("falls back to the filename when the parser found no title", async () => {
    const result = await importCanvasDocument(fileOf("q4-final-v2.md"), deps())
    expect(result.title).toBe("q4-final-v2")
  })

  it("carries provenance and the conversion warning", async () => {
    const d = deps({ type: "word", content: "# Heading" })
    const result = await importCanvasDocument(fileOf("memo.docx", "x"), d)
    expect(result).toMatchObject({
      language: "markdown",
      type: "text",
      sourceFormat: "word",
      sourceFilename: "memo.docx",
    })
    expect(result.warnings.map((w) => w.code)).toContain("converted-to-markdown")
  })
})
