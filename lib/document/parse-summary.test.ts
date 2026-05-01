import {
  normalizePDFSummary,
  normalizeWordSummary,
  normalizeExcelSummary,
  normalizePresentationSummary,
  normalizeEPUBSummary,
  normalizeHTMLSummary,
  normalizeCSVSummary,
  normalizeRTFSummary,
  normalizeMarkdownSummary,
  normalizeCodeSummary,
  normalizeTextSummary,
  normalizeJSONSummary,
} from "./parse-summary"

describe("parse-summary normalization adapters", () => {
  describe("normalizePDFSummary", () => {
    it("produces page segments and pageCount", () => {
      const result = normalizePDFSummary({
        text: "hello",
        pageCount: 3,
        pages: [
          { pageNumber: 1, text: "p1", width: 612, height: 792 },
          { pageNumber: 2, text: "p2", width: 612, height: 792 },
          { pageNumber: 3, text: "p3", width: 612, height: 792 },
        ],
        metadata: {},
      })

      expect(result.parser).toBe("pdf")
      expect(result.structure.pageCount).toBe(3)
      expect(result.structure.segmentCount).toBe(3)
      expect(result.segments).toHaveLength(3)
      expect(result.segments![0].kind).toBe("page")
      expect(result.quality.status).toBe("complete")
    })
  })

  describe("normalizeWordSummary", () => {
    it("produces heading segments", () => {
      const result = normalizeWordSummary({
        text: "content",
        html: "<p>content</p>",
        messages: [],
        images: [],
        headings: [
          { level: 1, text: "Title" },
          { level: 2, text: "Section" },
        ],
      })

      expect(result.parser).toBe("word")
      expect(result.structure.headingCount).toBe(2)
      expect(result.quality.status).toBe("complete")
    })

    it("marks quality as degraded when parser warnings exist", () => {
      const result = normalizeWordSummary({
        text: "content",
        html: "<p>content</p>",
        messages: [{ type: "warning", message: "Skipped comment" }],
        images: [],
        headings: [],
      })

      expect(result.quality.status).toBe("degraded")
      expect(result.quality.reason).toContain("1 parser warning")
    })
  })

  describe("normalizeExcelSummary", () => {
    it("produces sheet segments", () => {
      const result = normalizeExcelSummary({
        text: "data",
        sheets: [
          { name: "Sheet1", data: [], rowCount: 10, columnCount: 3 },
          { name: "Sheet2", data: [], rowCount: 5, columnCount: 2 },
        ],
        sheetNames: ["Sheet1", "Sheet2"],
      })

      expect(result.parser).toBe("excel")
      expect(result.structure.sheetCount).toBe(2)
      expect(result.segments).toHaveLength(2)
      expect(result.segments![0].kind).toBe("sheet")
    })
  })

  describe("normalizePresentationSummary", () => {
    it("produces slide segments", () => {
      const result = normalizePresentationSummary({
        text: "slides",
        slideCount: 2,
        slides: [
          { slideNumber: 1, title: "Intro", text: "intro" },
          { slideNumber: 2, title: "Details", text: "details" },
        ],
        metadata: { title: "Deck" },
      })

      expect(result.parser).toBe("presentation")
      expect(result.structure.slideCount).toBe(2)
      expect(result.structure.segmentCount).toBe(2)
    })
  })

  describe("normalizeEPUBSummary", () => {
    it("produces chapter segments", () => {
      const result = normalizeEPUBSummary({
        text: "book content",
        chapterCount: 3,
        chapters: [
          { id: "c1", href: "c1.xhtml", title: "Ch 1", text: "text" },
          { id: "c2", href: "c2.xhtml", title: "Ch 2", text: "text" },
          { id: "c3", href: "c3.xhtml", title: "Ch 3", text: "text" },
        ],
        metadata: { title: "Book" },
      })

      expect(result.parser).toBe("epub")
      expect(result.structure.chapterCount).toBe(3)
      expect(result.segments).toHaveLength(3)
      expect(result.segments![0].kind).toBe("chapter")
    })
  })

  describe("normalizeHTMLSummary", () => {
    it("counts headings, tables, links, and images", () => {
      const result = normalizeHTMLSummary({
        text: "page",
        headings: [{ level: 1, text: "Title" }],
        links: [{ text: "Link", href: "http://example.com", isExternal: true }],
        images: [{ src: "img.png", alt: "Image" }],
        metadata: {},
        tables: [{ headers: ["A"], rows: [["1"]] }],
      })

      expect(result.parser).toBe("html")
      expect(result.structure.headingCount).toBe(1)
      expect(result.structure.tableCount).toBe(1)
      expect(result.structure.linkCount).toBe(1)
      expect(result.structure.imageCount).toBe(1)
    })
  })

  describe("normalizeCSVSummary", () => {
    it("produces minimal table structure", () => {
      const result = normalizeCSVSummary({
        text: "a,b\n1,2",
        data: [
          ["a", "b"],
          ["1", "2"],
        ],
        headers: ["a", "b"],
        rowCount: 2,
        columnCount: 2,
        delimiter: ",",
      })

      expect(result.parser).toBe("csv")
      expect(result.structure.tableCount).toBe(1)
    })
  })

  describe("normalizeRTFSummary", () => {
    it("returns minimal summary", () => {
      const result = normalizeRTFSummary({
        text: "rtf content",
        metadata: { charset: "windows-1252", controlWordCount: 10 },
      })

      expect(result.parser).toBe("rtf")
      expect(result.structure.segmentCount).toBe(1)
    })
  })

  describe("normalizeMarkdownSummary", () => {
    it("counts sections, code blocks, links, and images", () => {
      const result = normalizeMarkdownSummary({
        content: "# Title\n\nSome text",
        sections: [{ level: 1, title: "Title", content: "Some text", startLine: 0, endLine: 2 }],
        links: [{ text: "link", url: "http://example.com" }],
        codeBlocks: [{ language: "ts", code: "const x = 1;" }],
        images: [],
        taskLists: [],
        mathBlocks: [],
        footnotes: [],
        admonitions: [],
      })

      expect(result.parser).toBe("markdown")
      expect(result.structure.sectionCount).toBe(1)
      expect(result.structure.codeBlockCount).toBe(1)
      expect(result.structure.linkCount).toBe(1)
    })
  })

  describe("normalizeCodeSummary", () => {
    it("counts functions and classes", () => {
      const result = normalizeCodeSummary({
        language: "typescript",
        imports: [],
        functions: [{ name: "foo", startLine: 1, endLine: 3, signature: "function foo()" }],
        classes: [{ name: "Bar", startLine: 5, endLine: 10, methods: [], docstring: "" }],
        comments: [],
        content: "",
      })

      expect(result.parser).toBe("code")
      expect(result.structure.codeBlockCount).toBe(1)
      expect(result.structure.sectionCount).toBe(1)
    })
  })

  describe("normalizeTextSummary", () => {
    it("returns lightweight fallback", () => {
      const result = normalizeTextSummary({ size: 100, lineCount: 5, wordCount: 20 })

      expect(result.parser).toBe("text")
      expect(result.quality.status).toBe("complete")
    })
  })

  describe("normalizeJSONSummary", () => {
    it("returns lightweight fallback", () => {
      const result = normalizeJSONSummary({ size: 50, lineCount: 1, wordCount: 5 })

      expect(result.parser).toBe("json")
      expect(result.quality.status).toBe("complete")
    })
  })
})
