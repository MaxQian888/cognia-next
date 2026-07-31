/**
 * Tests for PDF Parser
 *
 * NOTE: PDF parsing requires actual PDF binary data which is difficult to mock.
 * These tests focus on utility functions, the native-first seam, and error
 * handling. For full PDF parsing tests, use e2e tests with real PDF files.
 */

jest.mock("../runtime-adapters", () => ({
  isTauri: jest.fn(() => false),
  documentTransport: { call: jest.fn() },
}))

jest.mock("./native-pdf", () => ({
  parsePdfNative: jest.fn(),
}))

jest.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  version: "0.0.0-test",
  getDocument: jest.fn(),
}))

import { isTauri } from "../runtime-adapters"
import { getDocument } from "pdfjs-dist"
import { parsePdfNative } from "./native-pdf"
import {
  parsePDF,
  parsePDFBase64,
  parsePDFFile,
  extractPDFEmbeddableContent,
  type PDFParseResult,
  type PDFMetadata,
} from "./pdf-parser"

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockParsePdfNative = parsePdfNative as jest.MockedFunction<typeof parsePdfNative>
const mockGetDocument = getDocument as jest.MockedFunction<typeof getDocument>

function nativeResult(text: string): PDFParseResult {
  return {
    text,
    pageCount: 1,
    pages: [
      {
        pageNumber: 1,
        text,
        width: 612,
        height: 792,
        items: [{ text, x: 1, y: 2, width: 30, height: 12 }],
      },
    ],
    metadata: {},
  }
}

/** Minimal pdfjs document mock — one page, one positioned text item. */
function installPdfjsDocument(pageText = "pdfjs text content here") {
  const page = {
    getTextContent: jest.fn().mockResolvedValue({
      items: [{ str: pageText, transform: [1, 0, 0, 1, 72, 720], height: 12 }],
    }),
    getViewport: jest.fn(() => ({ width: 612, height: 792 })),
    getAnnotations: jest.fn().mockResolvedValue([]),
  }
  const pdf = {
    numPages: 1,
    getPage: jest.fn().mockResolvedValue(page),
    getMetadata: jest.fn().mockResolvedValue({ info: {} }),
    getOutline: jest.fn().mockResolvedValue(null),
  }
  mockGetDocument.mockReturnValue({ promise: Promise.resolve(pdf) } as never)
  return pdf
}

describe("parsePDF native-first seam", () => {
  beforeEach(() => {
    mockIsTauri.mockReset().mockReturnValue(false)
    mockParsePdfNative.mockReset()
    mockGetDocument.mockReset()
  })

  it("returns the native result on Tauri without touching pdfjs", async () => {
    mockIsTauri.mockReturnValue(true)
    mockParsePdfNative.mockResolvedValue(nativeResult("Native page text long enough"))

    const result = await parsePDF(new ArrayBuffer(8))

    expect(result.text).toBe("Native page text long enough")
    expect(result.pages[0].items).toHaveLength(1)
    expect(result.diagnostics).toBeUndefined()
    expect(mockGetDocument).not.toHaveBeenCalled()
  })

  it("attaches a sparse_text_layer diagnostic when native text is near-empty", async () => {
    mockIsTauri.mockReturnValue(true)
    mockParsePdfNative.mockResolvedValue(nativeResult("tiny"))

    const result = await parsePDF(new ArrayBuffer(8))

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "sparse_text_layer", severity: "info" }),
    ])
  })

  it("falls back to pdfjs with a native_parse_fallback diagnostic on native failure", async () => {
    mockIsTauri.mockReturnValue(true)
    mockParsePdfNative.mockRejectedValue(new Error("parse_failed: boom"))
    installPdfjsDocument()

    const result = await parsePDF(new ArrayBuffer(8))

    expect(result.text).toContain("pdfjs text content here")
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "native_parse_fallback", severity: "info" }),
    ])
  })

  it("falls back silently (no diagnostic) when the native backend is unsupported", async () => {
    mockIsTauri.mockReturnValue(true)
    mockParsePdfNative.mockRejectedValue(new Error("unsupported"))
    installPdfjsDocument()

    const result = await parsePDF(new ArrayBuffer(8))

    expect(result.text).toContain("pdfjs text content here")
    expect(result.diagnostics).toBeUndefined()
  })

  it("uses pdfjs directly outside Tauri", async () => {
    installPdfjsDocument()

    const result = await parsePDF(new ArrayBuffer(8))

    expect(result.text).toContain("pdfjs text content here")
    expect(mockParsePdfNative).not.toHaveBeenCalled()
  })

  it("skips the native path when pdfjs-specific options are requested", async () => {
    mockIsTauri.mockReturnValue(true)
    installPdfjsDocument()

    await parsePDF(new ArrayBuffer(8), { extractOutline: true })
    await parsePDF(new ArrayBuffer(8), { startPage: 2 })

    expect(mockParsePdfNative).not.toHaveBeenCalled()
  })

  it("threads the password into the native options", async () => {
    mockIsTauri.mockReturnValue(true)
    mockParsePdfNative.mockResolvedValue(nativeResult("Long enough native text here"))

    await parsePDF(new ArrayBuffer(8), { password: "hunter2" })

    expect(mockParsePdfNative).toHaveBeenCalledWith(expect.any(Uint8Array), {
      password: "hunter2",
    })
  })
})

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

describe("PDF convenience parsers", () => {
  beforeEach(() => {
    mockIsTauri.mockReset().mockReturnValue(false)
    mockParsePdfNative.mockReset()
    mockGetDocument.mockReset()
  })

  it("parsePDFFile reads file data and delegates to parsePDF", async () => {
    installPdfjsDocument("file parser text content")
    const file = {
      arrayBuffer: jest.fn(async () => new Uint8Array([1, 2, 3]).buffer),
    } as unknown as File

    const result = await parsePDFFile(file)

    expect(file.arrayBuffer).toHaveBeenCalled()
    expect(result.text).toContain("file parser text content")
    const params = mockGetDocument.mock.calls[0][0] as { data: ArrayBuffer }
    expect([...new Uint8Array(params.data)]).toEqual([1, 2, 3])
  })

  it("parsePDFBase64 decodes bytes and forwards parser options", async () => {
    installPdfjsDocument("base64 parser text content")

    const result = await parsePDFBase64("AQIDBA==", { password: "secret" })

    expect(result.text).toContain("base64 parser text content")
    const params = mockGetDocument.mock.calls[0][0] as { data: ArrayBuffer; password: string }
    expect([...new Uint8Array(params.data)]).toEqual([1, 2, 3, 4])
    expect(params.password).toBe("secret")
  })
})
