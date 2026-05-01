/**
 * Tests for PDF Parser
 *
 * NOTE: PDF parsing requires actual PDF binary data which is difficult to mock.
 * These tests focus on utility functions and error handling.
 * For full PDF parsing tests, use e2e tests with real PDF files.
 */

import { extractPDFEmbeddableContent, type PDFParseResult, type PDFMetadata } from "./pdf-parser"

describe("PDF Parser", () => {
  describe("extractPDFEmbeddableContent", () => {
    it("combines title, author and text", () => {
      const result: PDFParseResult = {
        text: "This is the main content of the PDF.",
        pageCount: 2,
        pages: [
          { pageNumber: 1, text: "Page 1 content", width: 612, height: 792 },
          { pageNumber: 2, text: "Page 2 content", width: 612, height: 792 },
        ],
        metadata: {
          title: "Test Document",
          author: "Test Author",
        },
      }

      const embeddable = extractPDFEmbeddableContent(result)

      expect(embeddable).toContain("Title: Test Document")
      expect(embeddable).toContain("Author: Test Author")
      expect(embeddable).toContain("This is the main content")
    })

    it("handles missing title", () => {
      const result: PDFParseResult = {
        text: "Content without title.",
        pageCount: 1,
        pages: [{ pageNumber: 1, text: "Content", width: 612, height: 792 }],
        metadata: {
          author: "Author Only",
        },
      }

      const embeddable = extractPDFEmbeddableContent(result)

      expect(embeddable).not.toContain("Title:")
      expect(embeddable).toContain("Author: Author Only")
      expect(embeddable).toContain("Content without title")
    })

    it("handles missing author", () => {
      const result: PDFParseResult = {
        text: "Content without author.",
        pageCount: 1,
        pages: [{ pageNumber: 1, text: "Content", width: 612, height: 792 }],
        metadata: {
          title: "Title Only",
        },
      }

      const embeddable = extractPDFEmbeddableContent(result)

      expect(embeddable).toContain("Title: Title Only")
      expect(embeddable).not.toContain("Author:")
      expect(embeddable).toContain("Content without author")
    })

    it("handles empty metadata", () => {
      const result: PDFParseResult = {
        text: "Just content.",
        pageCount: 1,
        pages: [{ pageNumber: 1, text: "Just content.", width: 612, height: 792 }],
        metadata: {},
      }

      const embeddable = extractPDFEmbeddableContent(result)

      expect(embeddable).toBe("Just content.")
    })

    it("handles empty text", () => {
      const result: PDFParseResult = {
        text: "",
        pageCount: 0,
        pages: [],
        metadata: {
          title: "Empty PDF",
        },
      }

      const embeddable = extractPDFEmbeddableContent(result)

      expect(embeddable).toContain("Title: Empty PDF")
    })
  })

  describe("PDFMetadata type", () => {
    it("supports all metadata fields", () => {
      const metadata: PDFMetadata = {
        title: "Test Title",
        author: "Test Author",
        subject: "Test Subject",
        keywords: "test, pdf, parser",
        creator: "Test Creator",
        producer: "Test Producer",
        creationDate: new Date("2024-01-01"),
        modificationDate: new Date("2024-06-01"),
      }

      expect(metadata.title).toBe("Test Title")
      expect(metadata.author).toBe("Test Author")
      expect(metadata.subject).toBe("Test Subject")
      expect(metadata.keywords).toBe("test, pdf, parser")
      expect(metadata.creator).toBe("Test Creator")
      expect(metadata.producer).toBe("Test Producer")
      expect(metadata.creationDate).toBeInstanceOf(Date)
      expect(metadata.modificationDate).toBeInstanceOf(Date)
    })

    it("allows partial metadata", () => {
      const metadata: PDFMetadata = {
        title: "Only Title",
      }

      expect(metadata.title).toBe("Only Title")
      expect(metadata.author).toBeUndefined()
    })
  })

  describe("PDFParseResult type", () => {
    it("supports page information", () => {
      const result: PDFParseResult = {
        text: "Full text",
        pageCount: 3,
        pages: [
          { pageNumber: 1, text: "Page 1", width: 612, height: 792 },
          { pageNumber: 2, text: "Page 2", width: 612, height: 792 },
          { pageNumber: 3, text: "Page 3", width: 792, height: 612 }, // Landscape
        ],
        metadata: {},
      }

      expect(result.pageCount).toBe(3)
      expect(result.pages).toHaveLength(3)
      expect(result.pages[0].pageNumber).toBe(1)
      expect(result.pages[2].width).toBeGreaterThan(result.pages[2].height) // Landscape
    })
  })
})

// Note: parsePDF, parsePDFFile, and parsePDFBase64 functions require
// actual PDF binary data and pdfjs-dist library which has ESM compatibility
// issues with Jest. These should be tested via e2e tests or integration tests.
describe.skip("PDF parsing functions (requires real PDF files)", () => {
  it.todo("parsePDF - parses ArrayBuffer")
  it.todo("parsePDFFile - parses File object")
  it.todo("parsePDFBase64 - parses base64 string")
})
