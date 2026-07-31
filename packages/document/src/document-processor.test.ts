/**
 * Tests for Document Processor
 */

import {
  detectDocumentType,
  processDocument,
  processDocumentAsync,
  processDocuments,
  extractSummary,
  getFileExtension,
  isTextFile,
  estimateTokenCount,
  validateFile,
  detectEncoding,
  compareDocuments,
  isBinaryType,
} from "./document-processor"
import { parseWord, parseExcel } from "./parsers/office-parser"
import { parsePresentation } from "./parsers/presentation-parser"
import {
  parseOpenDocumentText,
  parseOpenDocumentSpreadsheet,
  parseOpenDocumentPresentation,
} from "./parsers/open-document-parser"

jest.mock("@cognia/provider-embedding/chunking", () => ({
  chunkDocument: jest.fn((content: string) => {
    const chunks =
      content.length > 100
        ? [
            { id: "chunk-0", content: "chunk-0", index: 0, startOffset: 0, endOffset: 7 },
            { id: "chunk-1", content: "chunk-1", index: 1, startOffset: 7, endOffset: 14 },
          ]
        : [{ id: "chunk-0", content: "chunk-0", index: 0, startOffset: 0, endOffset: 7 }]

    return {
      chunks,
      totalChunks: chunks.length,
      originalLength: content.length,
      strategy: "fixed",
    }
  }),
  chunkDocumentAsync: jest.fn(async (content: string, options: unknown, id?: string) =>
    Promise.resolve(
      (
        jest.requireActual(
          "@cognia/provider-embedding/chunking"
        ) as typeof import("@cognia/provider-embedding/chunking")
      ).chunkDocument(
        content,
        options as Parameters<
          typeof import("@cognia/provider-embedding/chunking").chunkDocument
        >[1],
        id
      )
    )
  ),
}))

jest.mock("./parsers/presentation-parser", () => ({
  parsePresentation: jest.fn(async () => ({
    text: "Slide 1 content\nSlide 2 content",
    slideCount: 2,
    slides: [
      { slideNumber: 1, title: "Slide 1", text: "Slide 1 content" },
      { slideNumber: 2, title: "Slide 2", text: "Slide 2 content" },
    ],
    metadata: { title: "Demo Deck", author: "Tester" },
  })),
  extractPresentationEmbeddableContent: jest.fn((result: { text: string }) => result.text),
}))

jest.mock("./parsers/office-parser", () => ({
  parseWord: jest.fn(async () => ({
    text: "Parsed Word content",
    html: "<p>Parsed Word content</p>",
    messages: [{ type: "warning", message: "Some comments were skipped" }],
    images: [],
    metadata: { title: "Word Title", author: "Tester" },
    headings: [{ level: 1, text: "Overview" }],
  })),
  extractWordEmbeddableContent: jest.fn((result: { text: string }) => result.text),
  parseExcel: jest.fn(async () => ({
    text: "## Sheet: Sheet1\nValue",
    sheets: [{ name: "Sheet1", data: [["Value"]], rowCount: 1, columnCount: 1 }],
    sheetNames: ["Sheet1"],
  })),
  extractExcelEmbeddableContent: jest.fn((result: { text: string }) => result.text),
}))

jest.mock("./parsers/open-document-parser", () => ({
  parseOpenDocumentText: jest.fn(async () => ({
    text: "Parsed ODT content",
    html: "<p>Parsed ODT content</p>",
    messages: [],
    images: [],
    metadata: { title: "OpenDocument Text", author: "Tester" },
    headings: [{ level: 1, text: "ODT Heading" }],
  })),
  parseOpenDocumentSpreadsheet: jest.fn(async () => ({
    text: "## Sheet: ODS Sheet\nValue",
    sheets: [{ name: "ODS Sheet", data: [["Value"]], rowCount: 1, columnCount: 1 }],
    sheetNames: ["ODS Sheet"],
  })),
  parseOpenDocumentPresentation: jest.fn(async () => ({
    text: "## Slide 1\nParsed ODP slide",
    slideCount: 1,
    slides: [{ slideNumber: 1, title: "Parsed ODP slide", text: "Parsed ODP slide" }],
    metadata: { title: "ODP Deck", author: "Tester" },
  })),
}))

jest.mock("./parsers/pdf-parser", () => ({
  parsePDF: jest.fn(async () => ({
    text: "PDF page one\nPDF page two",
    pageCount: 2,
    metadata: { title: "PDF Title", author: "PDF Author" },
    pages: [
      { pageNumber: 1, text: "PDF page one" },
      { pageNumber: 2, text: "PDF page two" },
    ],
    diagnostics: [{ code: "parser_warning", severity: "warning", message: "PDF warning" }],
  })),
  extractPDFEmbeddableContent: jest.fn((result: { text: string }) => result.text),
}))

jest.mock("./parsers/rtf-parser", () => ({
  parseRTF: jest.fn((content: string) => ({
    text: content.includes("rtf") ? "Parsed RTF content" : "Parsed content",
    metadata: { charset: "windows-1252", controlWordCount: 4 },
  })),
  extractRTFEmbeddableContent: jest.fn((result: { text: string }) => result.text),
}))

jest.mock("./parsers/epub-parser", () => ({
  parseEPUB: jest.fn(async () => ({
    text: "Chapter 1 text\nChapter 2 text",
    chapterCount: 2,
    chapters: [
      { id: "c1", href: "c1.xhtml", title: "C1", text: "Chapter 1 text" },
      { id: "c2", href: "c2.xhtml", title: "C2", text: "Chapter 2 text" },
    ],
    metadata: { title: "Book Title", author: "Book Author" },
  })),
  extractEPUBEmbeddableContent: jest.fn((result: { text: string }) => result.text),
}))

describe("detectDocumentType", () => {
  describe("markdown files", () => {
    it("detects .md files", () => {
      expect(detectDocumentType("readme.md")).toBe("markdown")
    })

    it("detects .markdown files", () => {
      expect(detectDocumentType("doc.markdown")).toBe("markdown")
    })

    it("detects .mdx files", () => {
      expect(detectDocumentType("component.mdx")).toBe("markdown")
    })
  })

  describe("code files", () => {
    it("detects JavaScript files", () => {
      expect(detectDocumentType("app.js")).toBe("code")
      expect(detectDocumentType("app.jsx")).toBe("code")
    })

    it("detects TypeScript files", () => {
      expect(detectDocumentType("app.ts")).toBe("code")
      expect(detectDocumentType("app.tsx")).toBe("code")
    })

    it("detects Python files", () => {
      expect(detectDocumentType("script.py")).toBe("code")
    })

    it("detects Go files", () => {
      expect(detectDocumentType("main.go")).toBe("code")
    })

    it("detects Rust files", () => {
      expect(detectDocumentType("lib.rs")).toBe("code")
    })

    it("detects C/C++ files", () => {
      expect(detectDocumentType("main.c")).toBe("code")
      expect(detectDocumentType("main.cpp")).toBe("code")
      expect(detectDocumentType("header.h")).toBe("code")
      expect(detectDocumentType("header.hpp")).toBe("code")
    })

    it("detects Java files", () => {
      expect(detectDocumentType("Main.java")).toBe("code")
    })

    it("detects shell scripts", () => {
      expect(detectDocumentType("script.sh")).toBe("code")
      expect(detectDocumentType("script.bash")).toBe("code")
    })

    it("detects CSS/SCSS files", () => {
      expect(detectDocumentType("style.css")).toBe("code")
      expect(detectDocumentType("style.scss")).toBe("code")
    })

    it("detects XML files", () => {
      expect(detectDocumentType("config.xml")).toBe("code")
    })

    it("detects YAML files", () => {
      expect(detectDocumentType("config.yaml")).toBe("code")
      expect(detectDocumentType("config.yml")).toBe("code")
    })

    it("detects SQL files", () => {
      expect(detectDocumentType("query.sql")).toBe("code")
    })
  })

  describe("JSON files", () => {
    it("detects JSON files", () => {
      expect(detectDocumentType("package.json")).toBe("json")
    })
  })

  describe("text files", () => {
    it("detects .txt files", () => {
      expect(detectDocumentType("notes.txt")).toBe("text")
    })
  })

  describe("HTML files", () => {
    it("detects .html files", () => {
      expect(detectDocumentType("index.html")).toBe("html")
    })

    it("detects .htm files", () => {
      expect(detectDocumentType("page.htm")).toBe("html")
    })

    it("detects .xhtml files", () => {
      expect(detectDocumentType("doc.xhtml")).toBe("html")
    })
  })

  describe("PDF files", () => {
    it("detects .pdf files", () => {
      expect(detectDocumentType("document.pdf")).toBe("pdf")
    })
  })

  describe("Word documents", () => {
    it("detects .docx files", () => {
      expect(detectDocumentType("document.docx")).toBe("word")
    })

    it("detects .doc files", () => {
      expect(detectDocumentType("document.doc")).toBe("word")
    })
  })

  describe("Excel files", () => {
    it("detects .xlsx files", () => {
      expect(detectDocumentType("spreadsheet.xlsx")).toBe("excel")
    })

    it("detects .xls files", () => {
      expect(detectDocumentType("spreadsheet.xls")).toBe("excel")
    })
  })

  describe("CSV files", () => {
    it("detects .csv files", () => {
      expect(detectDocumentType("data.csv")).toBe("csv")
    })

    it("detects .tsv files", () => {
      expect(detectDocumentType("data.tsv")).toBe("csv")
    })
  })

  describe("unknown files", () => {
    it("returns unknown for unrecognized extensions", () => {
      expect(detectDocumentType("file.xyz")).toBe("unknown")
    })

    it("returns unknown for files without extension", () => {
      expect(detectDocumentType("Dockerfile")).toBe("unknown")
    })
  })
})

describe("processDocument", () => {
  it("processes markdown document", () => {
    const result = processDocument("doc-1", "readme.md", "# Title\n\nContent here")

    expect(result.id).toBe("doc-1")
    expect(result.filename).toBe("readme.md")
    expect(result.type).toBe("markdown")
    expect(result.metadata.language).toBe("markdown")
    expect(result.parseSummary).toMatchObject({
      parser: "markdown",
      structure: expect.objectContaining({
        sectionCount: 1,
      }),
    })
    expect(result.metadata.parseSummary).toEqual(result.parseSummary)
  })

  it("processes code document", () => {
    const result = processDocument("doc-2", "app.ts", 'function hello() { return "world"; }')

    expect(result.type).toBe("code")
    expect(result.metadata.language).toBe("typescript")
  })

  it("processes JSON document", () => {
    const result = processDocument("doc-3", "config.json", '{"key": "value", "array": [1, 2, 3]}')

    expect(result.type).toBe("json")
    expect(result.metadata.language).toBe("json")
    expect(result.metadata.isArray).toBe(false)
    expect(result.metadata.keyCount).toBe(2)
  })

  it("handles JSON arrays", () => {
    const result = processDocument("doc-4", "data.json", "[1, 2, 3]")

    expect(result.metadata.isArray).toBe(true)
  })

  it("handles invalid JSON gracefully", () => {
    const result = processDocument("doc-5", "bad.json", "{invalid json}")

    expect(result.type).toBe("json")
    expect(result.metadata.keyCount).toBeUndefined()
  })

  it("handles primitive JSON values with zero object keys", () => {
    const result = processDocument("doc-json-primitive", "answer.json", "42")

    expect(result.type).toBe("json")
    expect(result.metadata.keyCount).toBe(0)
    expect(result.metadata.isArray).toBe(false)
  })

  it("calculates correct metadata", () => {
    const content = "Line 1\nLine 2\nLine 3"
    const result = processDocument("doc-6", "file.txt", content)

    expect(result.metadata.size).toBe(content.length)
    expect(result.metadata.lineCount).toBe(3)
    expect(result.metadata.wordCount).toBe(6)
  })

  it("extracts embeddable content when enabled", () => {
    const result = processDocument("doc-7", "readme.md", "# Title\n\nContent", {
      extractEmbeddable: true,
    })

    expect(result.embeddableContent).toBeDefined()
  })

  it("generates chunks when requested", () => {
    const longContent = "word ".repeat(500)
    const result = processDocument("doc-8", "large.md", longContent, {
      generateChunks: true,
      chunkingOptions: { chunkSize: 100 },
    })

    expect(result.chunks).toBeDefined()
    expect(result.chunks!.length).toBeGreaterThan(1)
  })

  it("skips chunk generation by default", () => {
    const result = processDocument("doc-9", "file.txt", "content")

    expect(result.chunks).toBeUndefined()
  })

  it("preserves source content when markdown and code embeddable extraction is disabled", () => {
    const markdown = "# Title\n\nBody"
    const code = "export function hello() { return 'world' }"

    expect(
      processDocument("doc-no-md-extract", "readme.md", markdown, {
        extractEmbeddable: false,
      }).embeddableContent
    ).toBe(markdown)
    expect(
      processDocument("doc-no-code-extract", "hello.ts", code, {
        extractEmbeddable: false,
      }).embeddableContent
    ).toBe(code)
  })

  it("extracts frontmatter tags into markdown metadata", () => {
    const result = processDocument(
      "doc-frontmatter",
      "notes.md",
      "---\ntags:\n  - alpha\n  - beta\n---\n# Notes\n\nBody"
    )

    expect(result.metadata.tags).toEqual(["alpha", "beta"])
  })
})

describe("processDocumentAsync", () => {
  beforeEach(() => {
    jest.mocked(parseWord).mockClear()
    jest.mocked(parseExcel).mockClear()
    jest.mocked(parsePresentation).mockClear()
    jest.mocked(parseOpenDocumentText).mockClear()
    jest.mocked(parseOpenDocumentSpreadsheet).mockClear()
    jest.mocked(parseOpenDocumentPresentation).mockClear()
  })

  it("processes macro-enabled word files via office parser", async () => {
    const result = await processDocumentAsync("doc-async-word", "template.docm", new ArrayBuffer(8))

    expect(parseWord).toHaveBeenCalled()
    expect(result.type).toBe("word")
    expect(result.content).toContain("Parsed Word content")
    expect(result.parseSummary).toMatchObject({
      parser: "word",
      structure: expect.objectContaining({
        headingCount: 1,
      }),
    })
    expect(result.parseDiagnostics).toEqual([
      expect.objectContaining({
        code: "parser_warning",
        severity: "warning",
      }),
    ])
  })

  it("processes pdf string data through the async parser and generates chunks", async () => {
    const result = await processDocumentAsync("doc-async-pdf", "report.pdf", "%PDF body", {
      generateChunks: true,
    })

    expect(result.type).toBe("pdf")
    expect(result.content).toContain("PDF page one")
    expect(result.metadata.pageCount).toBe(2)
    expect(result.metadata.author).toBe("PDF Author")
    expect(result.parseDiagnostics).toEqual([
      expect.objectContaining({
        code: "parser_warning",
        severity: "warning",
      }),
    ])
    expect(result.chunks).toBeDefined()
  })

  it("uses raw PDF content when embeddable extraction is disabled", async () => {
    const result = await processDocumentAsync("doc-async-pdf-raw", "report.pdf", "%PDF body", {
      extractEmbeddable: false,
    })

    expect(result.type).toBe("pdf")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("processes macro-enabled excel files via office parser", async () => {
    const result = await processDocumentAsync(
      "doc-async-excel",
      "financials.xlsm",
      new ArrayBuffer(8)
    )

    expect(parseExcel).toHaveBeenCalled()
    expect(result.type).toBe("excel")
    expect(result.content).toContain("Sheet1")
  })

  it("uses raw rich parser content when embeddable extraction is disabled", async () => {
    const result = await processDocumentAsync(
      "doc-no-word-extract",
      "notes.docx",
      new ArrayBuffer(8),
      {
        extractEmbeddable: false,
      }
    )

    expect(result.type).toBe("word")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("uses raw spreadsheet parser content when embeddable extraction is disabled", async () => {
    const result = await processDocumentAsync(
      "doc-no-excel-extract",
      "financials.xlsx",
      new ArrayBuffer(8),
      {
        extractEmbeddable: false,
      }
    )

    expect(result.type).toBe("excel")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("processes presentation files via presentation parser", async () => {
    const result = await processDocumentAsync("doc-async-1", "slides.pptx", new ArrayBuffer(8))

    expect(result.type).toBe("presentation")
    expect(result.content).toContain("Slide 1 content")
    expect(result.metadata.slideCount).toBe(2)
    expect(result.metadata.language).toBe("presentation")
    expect(result.parseSummary).toMatchObject({
      parser: "presentation",
      structure: expect.objectContaining({
        slideCount: 2,
        segmentCount: 2,
      }),
    })
  })

  it("uses raw presentation parser content when embeddable extraction is disabled", async () => {
    const result = await processDocumentAsync(
      "doc-no-presentation-extract",
      "slides.pptx",
      new ArrayBuffer(8),
      {
        extractEmbeddable: false,
      }
    )

    expect(result.type).toBe("presentation")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("processes rtf files via rtf parser", async () => {
    const result = await processDocumentAsync(
      "doc-async-2",
      "notes.rtf",
      "{\\rtf1\\ansi\\pard hello\\par}"
    )

    expect(result.type).toBe("rtf")
    expect(result.content).toBe("Parsed RTF content")
    expect(result.metadata.language).toBe("rtf")
  })

  it("uses raw RTF parser content when embeddable extraction is disabled", async () => {
    const result = await processDocumentAsync(
      "doc-no-rtf-extract",
      "notes.rtf",
      "{\\rtf1\\ansi\\pard hello\\par}",
      {
        extractEmbeddable: false,
      }
    )

    expect(result.type).toBe("rtf")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("processes epub files via epub parser", async () => {
    const result = await processDocumentAsync("doc-async-3", "book.epub", new ArrayBuffer(8))

    expect(result.type).toBe("epub")
    expect(result.content).toContain("Chapter 1 text")
    expect(result.metadata.chapterCount).toBe(2)
    expect(result.metadata.language).toBe("epub")
  })

  it("uses raw EPUB parser content when embeddable extraction is disabled", async () => {
    const result = await processDocumentAsync(
      "doc-no-epub-extract",
      "book.epub",
      new ArrayBuffer(8),
      {
        extractEmbeddable: false,
      }
    )

    expect(result.type).toBe("epub")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("processes csv ArrayBuffer data through the async parser", async () => {
    const buffer = new TextEncoder().encode("name,score\nAda,10\nLinus,9").buffer
    const result = await processDocumentAsync("doc-async-csv", "scores.csv", buffer)

    expect(result.type).toBe("csv")
    expect(result.metadata.rowCount).toBe(2)
    expect(result.metadata.columnCount).toBe(2)
    expect(result.metadata.headers).toEqual(["name", "score"])
    expect(result.parseSummary?.parser).toBe("csv")
  })

  it("processes csv string data and can disable embeddable extraction", async () => {
    const result = await processDocumentAsync("doc-async-csv-string", "scores.csv", "name\nAda", {
      extractEmbeddable: false,
    })

    expect(result.type).toBe("csv")
    expect(result.content).toBe("name\nAda")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("processes html ArrayBuffer data through the async parser", async () => {
    const buffer = new TextEncoder().encode(
      "<html><head><title>Page Title</title></head><body><h1>Hello</h1><a href='/a'>A</a><img src='image.png' alt='Image'></body></html>"
    ).buffer
    const result = await processDocumentAsync("doc-async-html", "page.html", buffer, {
      extractEmbeddable: false,
    })

    expect(result.type).toBe("html")
    expect(result.metadata.title).toBe("Page Title")
    expect(result.metadata.linkCount).toBe(1)
    expect(result.metadata.imageCount).toBe(1)
    expect(result.embeddableContent).toContain("Hello")
  })

  it("processes html string data with embeddable extraction enabled", async () => {
    const result = await processDocumentAsync(
      "doc-async-html-string",
      "page.html",
      "<html><body><main><h1>Hello</h1><p>Body</p></main></body></html>"
    )

    expect(result.type).toBe("html")
    expect(result.embeddableContent).toContain("Hello")
    expect(result.metadata.wordCount).toBeGreaterThan(0)
  })

  it("processes open document text files via dedicated parser", async () => {
    const result = await processDocumentAsync("doc-async-odt", "notes.odt", new ArrayBuffer(8))

    expect(parseOpenDocumentText).toHaveBeenCalled()
    expect(result.type).toBe("word")
    expect(result.content).toContain("Parsed ODT content")
  })

  it("processes open document spreadsheets via dedicated parser", async () => {
    const result = await processDocumentAsync("doc-async-ods", "budget.ods", new ArrayBuffer(8))

    expect(parseOpenDocumentSpreadsheet).toHaveBeenCalled()
    expect(result.type).toBe("excel")
    expect(result.content).toContain("ODS Sheet")
  })

  it("processes open document presentations via dedicated parser", async () => {
    const result = await processDocumentAsync("doc-async-odp", "roadmap.odp", new ArrayBuffer(8))

    expect(parseOpenDocumentPresentation).toHaveBeenCalled()
    expect(result.type).toBe("presentation")
    expect(result.content).toContain("Parsed ODP slide")
  })

  it("throws actionable error for legacy ppt files", async () => {
    await expect(
      processDocumentAsync("doc-async-4", "legacy.ppt", new ArrayBuffer(8))
    ).rejects.toThrow("convert to .pptx")
  })

  it("throws actionable error for unreadable macro-enabled word files", async () => {
    jest.mocked(parseWord).mockRejectedValueOnce(new Error("zip failure"))

    await expect(
      processDocumentAsync("doc-async-docm-error", "protected.docm", new ArrayBuffer(8))
    ).rejects.toMatchObject({
      message: expect.stringContaining("password protected or corrupted"),
      diagnostic: expect.objectContaining({
        code: "parse_failed",
        severity: "error",
      }),
    })
  })

  it("preserves parser-specific document parse errors", async () => {
    jest.mocked(parseWord).mockRejectedValueOnce(new Error("password protected document"))

    await expect(
      processDocumentAsync("doc-protected-word", "protected.docx", new ArrayBuffer(8))
    ).rejects.toMatchObject({
      message: "password protected document",
      diagnostic: expect.objectContaining({
        code: "parse_failed",
        severity: "error",
      }),
    })
  })

  it("normalizes non-Error spreadsheet parser failures", async () => {
    jest.mocked(parseExcel).mockRejectedValueOnce("zip failure")

    await expect(
      processDocumentAsync("doc-async-xlsx-error", "broken.xlsx", new ArrayBuffer(8))
    ).rejects.toMatchObject({
      message: expect.stringContaining("spreadsheet file"),
      diagnostic: expect.objectContaining({
        code: "parse_failed",
        severity: "error",
      }),
    })
  })

  it("throws actionable error for unreadable macro-enabled presentation files", async () => {
    jest.mocked(parsePresentation).mockRejectedValueOnce(new Error("zip failure"))

    await expect(
      processDocumentAsync("doc-async-pptm-error", "protected.pptm", new ArrayBuffer(8))
    ).rejects.toThrow("password protected or corrupted")
  })

  it("falls back to sync processing for unknown types", async () => {
    const result = await processDocumentAsync("doc-async-5", "raw.bin", "plain text body")
    expect(result.type).toBe("unknown")
    expect(result.content).toBe("plain text body")
  })

  it("decodes unknown ArrayBuffer data before falling back to sync processing", async () => {
    const buffer = new TextEncoder().encode("plain buffer body").buffer
    const result = await processDocumentAsync("doc-async-buffer", "raw.bin", buffer)

    expect(result.type).toBe("unknown")
    expect(result.content).toBe("plain buffer body")
  })
})

describe("processDocuments", () => {
  it("processes multiple documents", () => {
    const docs = [
      { id: "1", filename: "a.md", content: "# A" },
      { id: "2", filename: "b.ts", content: "const x = 1;" },
    ]

    const results = processDocuments(docs)

    expect(results).toHaveLength(2)
    expect(results[0].type).toBe("markdown")
    expect(results[1].type).toBe("code")
  })

  it("applies options to all documents", () => {
    const docs = [
      { id: "1", filename: "a.md", content: "word ".repeat(100) },
      { id: "2", filename: "b.md", content: "word ".repeat(100) },
    ]

    const results = processDocuments(docs, { generateChunks: true })

    results.forEach((result) => {
      expect(result.chunks).toBeDefined()
    })
  })

  it("handles empty array", () => {
    const results = processDocuments([])

    expect(results).toHaveLength(0)
  })
})

describe("extractSummary", () => {
  it("returns full content when shorter than maxLength", () => {
    const content = "Short content"
    const result = extractSummary(content, 200)

    expect(result).toBe("Short content")
  })

  it("truncates at sentence boundary", () => {
    const content = "First sentence. Second sentence. Third sentence."
    const result = extractSummary(content, 30)

    expect(result).toContain("First sentence.")
  })

  it("truncates at word boundary with ellipsis", () => {
    const content = "A long content without sentence markers that needs truncation"
    const result = extractSummary(content, 30)

    expect(result.endsWith("...")).toBe(true)
  })

  it("handles question marks as sentence endings", () => {
    const content = "Is this a question? Here is more content."
    const result = extractSummary(content, 25)

    expect(result).toContain("?")
  })

  it("handles exclamation marks as sentence endings", () => {
    const content = "Wow! That is amazing. More content here."
    const result = extractSummary(content, 10)

    expect(result).toContain("!")
  })

  it("normalizes whitespace", () => {
    const content = "Multiple   spaces   and\n\nnewlines"
    const result = extractSummary(content, 200)

    expect(result).not.toContain("  ")
    expect(result).not.toContain("\n")
  })

  it("uses default maxLength of 200", () => {
    const longContent = "word ".repeat(100)
    const result = extractSummary(longContent)

    expect(result.length).toBeLessThanOrEqual(203)
  })

  it("falls back to hard truncation when no sentence or word boundary is available", () => {
    expect(extractSummary("A".repeat(40), 10)).toBe("A".repeat(10) + "...")
  })
})

describe("getFileExtension", () => {
  it("returns extension for normal files", () => {
    expect(getFileExtension("file.txt")).toBe("txt")
  })

  it("returns last extension for multiple dots", () => {
    expect(getFileExtension("file.test.ts")).toBe("ts")
  })

  it("returns lowercase extension", () => {
    expect(getFileExtension("FILE.TXT")).toBe("txt")
  })

  it("returns empty string for files without extension", () => {
    expect(getFileExtension("Dockerfile")).toBe("")
  })

  it("handles dotfiles", () => {
    expect(getFileExtension(".gitignore")).toBe("")
  })
})

describe("isTextFile", () => {
  describe("text files", () => {
    it("returns true for .txt", () => {
      expect(isTextFile("file.txt")).toBe(true)
    })

    it("returns true for markdown", () => {
      expect(isTextFile("file.md")).toBe(true)
      expect(isTextFile("file.markdown")).toBe(true)
    })

    it("returns true for rtf", () => {
      expect(isTextFile("file.rtf")).toBe(true)
    })
  })

  describe("code files", () => {
    it("returns true for JavaScript", () => {
      expect(isTextFile("file.js")).toBe(true)
      expect(isTextFile("file.jsx")).toBe(true)
    })

    it("returns true for TypeScript", () => {
      expect(isTextFile("file.ts")).toBe(true)
      expect(isTextFile("file.tsx")).toBe(true)
    })

    it("returns true for Python", () => {
      expect(isTextFile("file.py")).toBe(true)
    })

    it("returns true for Go", () => {
      expect(isTextFile("file.go")).toBe(true)
    })

    it("returns true for Rust", () => {
      expect(isTextFile("file.rs")).toBe(true)
    })

    it("returns true for Java", () => {
      expect(isTextFile("file.java")).toBe(true)
    })
  })

  describe("config files", () => {
    it("returns true for JSON", () => {
      expect(isTextFile("package.json")).toBe(true)
    })

    it("returns true for YAML", () => {
      expect(isTextFile("config.yaml")).toBe(true)
      expect(isTextFile("config.yml")).toBe(true)
    })

    it("returns true for TOML", () => {
      expect(isTextFile("config.toml")).toBe(true)
    })

    it("returns true for XML", () => {
      expect(isTextFile("config.xml")).toBe(true)
    })
  })

  describe("dotfiles", () => {
    it("returns true for env files", () => {
      expect(isTextFile(".env")).toBe(true)
    })

    it("returns true for gitignore", () => {
      expect(isTextFile(".gitignore")).toBe(true)
    })

    it("returns true for extensionless text-like filenames", () => {
      expect(isTextFile("README")).toBe(true)
    })
  })

  describe("binary files", () => {
    it("returns false for images", () => {
      expect(isTextFile("image.png")).toBe(false)
      expect(isTextFile("image.jpg")).toBe(false)
    })

    it("returns false for executables", () => {
      expect(isTextFile("app.exe")).toBe(false)
    })

    it("returns false for archives", () => {
      expect(isTextFile("file.zip")).toBe(false)
    })
  })
})

describe("estimateTokenCount", () => {
  it("estimates tokens for short text", () => {
    const result = estimateTokenCount("Hello world")
    expect(result).toBeGreaterThan(0)
    expect(result).toBeLessThan(10)
  })

  it("estimates tokens for longer text", () => {
    const content = "word ".repeat(100)
    const result = estimateTokenCount(content)
    expect(result).toBeGreaterThan(50)
  })

  it("returns 0 for empty string", () => {
    expect(estimateTokenCount("")).toBe(0)
  })

  it("estimates more tokens for CJK text", () => {
    // 10 CJK characters should produce more tokens than 10 English chars
    const cjk = "这是一个测试文本内容啊"
    const english = "ABCDEFGHIJ"
    const cjkTokens = estimateTokenCount(cjk)
    const englishTokens = estimateTokenCount(english)
    expect(cjkTokens).toBeGreaterThan(englishTokens)
  })

  it("handles mixed CJK and English text", () => {
    const mixed = "Hello 你好 World 世界"
    const result = estimateTokenCount(mixed)
    expect(result).toBeGreaterThan(0)
  })

  it("uses roughly 4 characters per token for pure English", () => {
    const content = "A".repeat(100)
    const result = estimateTokenCount(content)
    expect(result).toBeCloseTo(25, 0)
  })
})

describe("validateFile", () => {
  it("accepts valid file", () => {
    const result = validateFile("document.pdf", 1024)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("rejects file exceeding max size", () => {
    const result = validateFile("large.pdf", 100 * 1024 * 1024) // 100MB
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain("exceeds")
  })

  it("warns when file size is close to max", () => {
    const result = validateFile("big.pdf", 45 * 1024 * 1024) // 45MB (90% of 50MB)
    expect(result.valid).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it("warns for empty file", () => {
    const result = validateFile("empty.txt", 0)
    expect(result.valid).toBe(true)
    expect(result.warnings).toContain("File is empty")
  })

  it("warns for unknown file type", () => {
    const result = validateFile("file.xyz", 100)
    expect(result.valid).toBe(true)
    expect(result.warnings[0]).toContain("Unrecognized")
  })

  it("rejects disallowed file types", () => {
    const result = validateFile("file.pdf", 100, {
      allowedTypes: ["markdown", "text"],
    })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain("not allowed")
  })

  it("accepts allowed file types", () => {
    const result = validateFile("readme.md", 100, {
      allowedTypes: ["markdown", "text"],
    })
    expect(result.valid).toBe(true)
  })

  it("respects custom maxFileSize", () => {
    const result = validateFile("small.txt", 2000, {
      maxFileSize: 1000,
    })
    expect(result.valid).toBe(false)
  })

  it("formats byte, kilobyte, and gigabyte size errors", () => {
    expect(validateFile("tiny.txt", 512, { maxFileSize: 256 }).errors[0]).toContain("512 B")
    expect(validateFile("small.txt", 2048, { maxFileSize: 1024 }).errors[0]).toContain("2.0 KB")
    expect(
      validateFile("huge.txt", 2 * 1024 * 1024 * 1024, { maxFileSize: 1024 * 1024 }).errors[0]
    ).toContain("2.0 GB")
  })
})

describe("detectEncoding", () => {
  it("detects UTF-8 BOM", () => {
    const buffer = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]).buffer
    expect(detectEncoding(buffer)).toBe("utf-8")
  })

  it("detects UTF-16 LE BOM", () => {
    const buffer = new Uint8Array([0xff, 0xfe, 0x41, 0x00]).buffer
    expect(detectEncoding(buffer)).toBe("utf-16le")
  })

  it("detects UTF-16 BE BOM", () => {
    const buffer = new Uint8Array([0xfe, 0xff, 0x00, 0x41]).buffer
    expect(detectEncoding(buffer)).toBe("utf-16be")
  })

  it("detects UTF-32 LE BOM before the UTF-16 LE prefix", () => {
    const buffer = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41]).buffer
    expect(detectEncoding(buffer)).toBe("utf-32le")
  })

  it("defaults to utf-8 for no BOM", () => {
    const buffer = new Uint8Array([0x41, 0x42, 0x43]).buffer
    expect(detectEncoding(buffer)).toBe("utf-8")
  })
})

describe("compareDocuments", () => {
  const makeDoc = (content: string) => ({
    id: "test",
    filename: "test.txt",
    type: "text" as const,
    content,
    embeddableContent: content,
    metadata: { size: content.length, lineCount: content.split("\n").length, wordCount: 0 },
  })

  it("detects identical documents", () => {
    const doc = makeDoc("Hello world")
    const diff = compareDocuments(doc, doc)
    expect(diff.similarity).toBe(1.0)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
  })

  it("detects added lines", () => {
    const docA = makeDoc("Line 1\nLine 2")
    const docB = makeDoc("Line 1\nLine 2\nLine 3")
    const diff = compareDocuments(docA, docB)
    expect(diff.added).toContain("Line 3")
  })

  it("detects removed lines", () => {
    const docA = makeDoc("Line 1\nLine 2\nLine 3")
    const docB = makeDoc("Line 1\nLine 2")
    const diff = compareDocuments(docA, docB)
    expect(diff.removed).toContain("Line 3")
  })

  it("computes similarity between 0 and 1", () => {
    const docA = makeDoc("Alpha\nBeta\nGamma")
    const docB = makeDoc("Alpha\nDelta\nGamma")
    const diff = compareDocuments(docA, docB)
    expect(diff.similarity).toBeGreaterThan(0)
    expect(diff.similarity).toBeLessThan(1)
  })

  it("records modified lines when similar non-empty lines change", () => {
    const docA = makeDoc("Alpha\nHello world\nGamma")
    const docB = makeDoc("Alpha\nHello brave world\nGamma")
    const diff = compareDocuments(docA, docB)

    expect(diff.modified).toEqual([{ line: 2, before: "Hello world", after: "Hello brave world" }])
  })

  it("reports full similarity for documents with no non-empty lines", () => {
    const docA = makeDoc("\n")
    const docB = makeDoc("")
    const diff = compareDocuments(docA, docB)

    expect(diff.similarity).toBe(1)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
  })
})

describe("isBinaryType", () => {
  it("returns true for binary types", () => {
    expect(isBinaryType("pdf")).toBe(true)
    expect(isBinaryType("word")).toBe(true)
    expect(isBinaryType("excel")).toBe(true)
    expect(isBinaryType("presentation")).toBe(true)
    expect(isBinaryType("epub")).toBe(true)
  })

  it("returns false for text types", () => {
    expect(isBinaryType("markdown")).toBe(false)
    expect(isBinaryType("code")).toBe(false)
    expect(isBinaryType("text")).toBe(false)
    expect(isBinaryType("json")).toBe(false)
    expect(isBinaryType("csv")).toBe(false)
    expect(isBinaryType("html")).toBe(false)
    expect(isBinaryType("rtf")).toBe(false)
  })
})

describe("new document type detection", () => {
  it("detects presentation files", () => {
    expect(detectDocumentType("slides.pptx")).toBe("presentation")
    expect(detectDocumentType("deck.ppt")).toBe("presentation")
  })

  it("detects macro-enabled office files", () => {
    expect(detectDocumentType("template.docm")).toBe("word")
    expect(detectDocumentType("financials.xlsm")).toBe("excel")
    expect(detectDocumentType("deck.pptm")).toBe("presentation")
  })

  it("detects open document formats", () => {
    expect(detectDocumentType("notes.odt")).toBe("word")
    expect(detectDocumentType("sheet.ods")).toBe("excel")
    expect(detectDocumentType("slides.odp")).toBe("presentation")
  })

  it("detects RTF files", () => {
    expect(detectDocumentType("document.rtf")).toBe("rtf")
  })

  it("detects EPUB files", () => {
    expect(detectDocumentType("book.epub")).toBe("epub")
  })
})
