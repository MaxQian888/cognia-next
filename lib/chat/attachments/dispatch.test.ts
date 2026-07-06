/**
 * Tests for the composer attachment dispatch. We keep the pure routing helpers
 * (`detectDocumentType`, `isBinaryDocumentType`) real via the support-matrix and
 * only stub the heavy `processDocumentAsync` so no real PDF/Office parser loads.
 */

jest.mock("@cognia/document/document-processor", () => {
  const actual = jest.requireActual<typeof import("@cognia/document/document-processor")>(
    "@cognia/document/document-processor"
  )
  return { ...actual, processDocumentAsync: jest.fn() }
})

import { processDocumentAsync } from "@cognia/document/document-processor"
import {
  buildAttachmentBlocks,
  buildSendContent,
  estimateDocumentTokens,
  formatDocumentText,
  IMAGE_MAX_LONG_EDGE,
  type SubmittedFile,
} from "./dispatch"

const processMock = processDocumentAsync as jest.Mock

function dataUrl(mime: string, text: string): string {
  return `data:${mime};base64,${Buffer.from(text).toString("base64")}`
}

// 1×1 transparent PNG.
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"

beforeEach(() => {
  processMock.mockReset()
  processMock.mockResolvedValue({ embeddableContent: "EXTRACTED", content: "EXTRACTED" })
})

describe("buildAttachmentBlocks — images", () => {
  it("routes an image data URL to an image block with base64 source", async () => {
    const files: SubmittedFile[] = [{ url: PNG_1PX, mediaType: "image/png", filename: "a.png" }]
    const { blocks, rejected } = await buildAttachmentBlocks(files)
    expect(rejected).toEqual([])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    })
    expect(processMock).not.toHaveBeenCalled()
  })

  it("falls back to the decoded mime when mediaType is missing", async () => {
    const { blocks } = await buildAttachmentBlocks([{ url: PNG_1PX, filename: "a.png" }])
    expect(blocks[0]).toMatchObject({ type: "image", source: { media_type: "image/png" } })
  })
})

describe("buildAttachmentBlocks — documents", () => {
  it("extracts text from a plain text file into an unfenced text block", async () => {
    processMock.mockResolvedValue({ embeddableContent: "hello world", content: "hello world" })
    const { blocks, rejected } = await buildAttachmentBlocks([
      { url: dataUrl("text/plain", "hello world"), mediaType: "text/plain", filename: "notes.txt" },
    ])
    expect(rejected).toEqual([])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: "text" })
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('Attached file "notes.txt"')
    expect(text).toContain("hello world")
    expect(text).not.toContain("```")
  })

  it("fences code with the detected language", async () => {
    processMock.mockResolvedValue({ embeddableContent: "const x = 1", content: "const x = 1" })
    const { blocks } = await buildAttachmentBlocks([
      { url: dataUrl("text/plain", "const x = 1"), filename: "main.ts" },
    ])
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain("```typescript")
  })

  it("passes a real ArrayBuffer to the processor for binary documents", async () => {
    await buildAttachmentBlocks([
      {
        url: dataUrl("application/pdf", "%PDF-1.4"),
        mediaType: "application/pdf",
        filename: "x.pdf",
      },
    ])
    expect(processMock).toHaveBeenCalledTimes(1)
    const dataArg = processMock.mock.calls[0][2]
    expect(dataArg).toBeInstanceOf(ArrayBuffer)
  })

  it("decodes text documents to a string for the processor sync path", async () => {
    await buildAttachmentBlocks([
      { url: dataUrl("text/markdown", "# Title"), filename: "readme.md" },
    ])
    expect(typeof processMock.mock.calls[0][2]).toBe("string")
  })

  it("rejects an empty PDF when the OCR fallback also finds nothing", async () => {
    processMock.mockResolvedValue({ embeddableContent: "   ", content: "" })
    const ocr = jest.fn(async () => null)
    const { blocks, rejected } = await buildAttachmentBlocks(
      [
        {
          url: dataUrl("application/pdf", "%PDF"),
          mediaType: "application/pdf",
          filename: "scan.pdf",
        },
      ],
      { pdfOcrFallback: ocr }
    )
    expect(blocks).toEqual([])
    expect(rejected).toEqual([{ filename: "scan.pdf", reason: "empty" }])
    expect(ocr).toHaveBeenCalledTimes(1)
  })

  it("rejects a file whose parser throws", async () => {
    processMock.mockRejectedValue(new Error("corrupt"))
    const { rejected } = await buildAttachmentBlocks(
      [
        {
          url: dataUrl("application/pdf", "%PDF"),
          mediaType: "application/pdf",
          filename: "bad.pdf",
        },
      ],
      { pdfOcrFallback: jest.fn(async () => null) }
    )
    expect(rejected).toEqual([{ filename: "bad.pdf", reason: "parse-failed" }])
  })
})

describe("buildAttachmentBlocks — scanned-PDF OCR fallback", () => {
  it("OCRs a scanned PDF whose text layer is empty", async () => {
    processMock.mockResolvedValue({ embeddableContent: "", content: "" })
    const ocr = jest.fn(async () => "scanned page text from OCR")
    const { blocks, rejected } = await buildAttachmentBlocks(
      [
        {
          url: dataUrl("application/pdf", "%PDF"),
          mediaType: "application/pdf",
          filename: "scan.pdf",
        },
      ],
      { pdfOcrFallback: ocr }
    )
    expect(rejected).toEqual([])
    expect(blocks).toHaveLength(1)
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('Attached file "scan.pdf"')
    expect(text).toContain("scanned page text from OCR")
    expect(ocr).toHaveBeenCalledWith(expect.any(Uint8Array), "")
  })

  it("OCRs a PDF whose text layer is sparse (below the trigger threshold)", async () => {
    processMock.mockResolvedValue({ embeddableContent: "1", content: "1" })
    const ocr = jest.fn(async () => "full recovered body text")
    const { blocks } = await buildAttachmentBlocks(
      [{ url: dataUrl("application/pdf", "%PDF"), filename: "page.pdf" }],
      { pdfOcrFallback: ocr }
    )
    expect((blocks[0] as { text: string }).text).toContain("full recovered body text")
    expect(ocr).toHaveBeenCalledWith(expect.any(Uint8Array), "1")
  })

  it("does NOT run OCR when the PDF already has a real text layer", async () => {
    processMock.mockResolvedValue({
      embeddableContent: "x".repeat(200),
      content: "x".repeat(200),
    })
    const ocr = jest.fn(async () => "should not be used")
    const { blocks } = await buildAttachmentBlocks(
      [{ url: dataUrl("application/pdf", "%PDF"), filename: "digital.pdf" }],
      { pdfOcrFallback: ocr }
    )
    expect(ocr).not.toHaveBeenCalled()
    expect((blocks[0] as { text: string }).text).toContain("x".repeat(200))
  })

  it("does NOT run OCR for non-PDF documents with empty extraction", async () => {
    processMock.mockResolvedValue({ embeddableContent: "", content: "" })
    const ocr = jest.fn(async () => "irrelevant")
    const { rejected } = await buildAttachmentBlocks(
      [{ url: dataUrl("text/plain", "x"), filename: "empty.txt" }],
      { pdfOcrFallback: ocr }
    )
    expect(ocr).not.toHaveBeenCalled()
    expect(rejected).toEqual([{ filename: "empty.txt", reason: "empty" }])
  })
})

describe("buildAttachmentBlocks — rejections", () => {
  it("rejects a non-data URL (e.g. blob:)", async () => {
    const { blocks, rejected } = await buildAttachmentBlocks([
      { url: "blob:http://x/y", mediaType: "image/png", filename: "a.png" },
    ])
    expect(blocks).toEqual([])
    expect(rejected).toEqual([{ filename: "a.png", reason: "not-data-url" }])
  })

  it("rejects an unsupported (unknown) document type", async () => {
    const { rejected } = await buildAttachmentBlocks([
      { url: dataUrl("application/octet-stream", "data"), filename: "thing.xyz" },
    ])
    expect(rejected).toEqual([{ filename: "thing.xyz", reason: "unsupported-type" }])
  })

  it("uses a fallback filename when none is provided", async () => {
    const { rejected } = await buildAttachmentBlocks([{ url: "blob:x" }])
    expect(rejected[0]!.filename).toBe("attachment")
  })
})

describe("buildAttachmentBlocks — token accounting", () => {
  it("sums estimated tokens across extracted-document text blocks", async () => {
    processMock.mockResolvedValue({ embeddableContent: "x".repeat(400), content: "" })
    const { tokens } = await buildAttachmentBlocks([
      { url: dataUrl("text/plain", "x"), filename: "a.txt" },
    ])
    // 400 latin chars ≈ 100 tokens (header adds a little). Assert it's nonzero.
    expect(tokens).toBeGreaterThan(50)
  })

  it("reports zero tokens when only images are attached", async () => {
    const { tokens } = await buildAttachmentBlocks([
      { url: PNG_1PX, mediaType: "image/png", filename: "b.png" },
    ])
    expect(tokens).toBe(0)
  })
})

describe("buildAttachmentBlocks — ordering", () => {
  it("emits images before extracted-document blocks", async () => {
    processMock.mockResolvedValue({ embeddableContent: "doc", content: "doc" })
    const { blocks } = await buildAttachmentBlocks([
      { url: dataUrl("text/plain", "doc"), filename: "a.txt" },
      { url: PNG_1PX, mediaType: "image/png", filename: "b.png" },
    ])
    expect(blocks.map((b) => b.type)).toEqual(["image", "text"])
  })
})

describe("buildSendContent", () => {
  it("returns a plain trimmed string when there are no attachments", async () => {
    const { content, rejected } = await buildSendContent("  hi  ", [])
    expect(content).toBe("hi")
    expect(rejected).toEqual([])
  })

  it("appends the user text after attachment blocks", async () => {
    const { content } = await buildSendContent("look at this", [
      { url: PNG_1PX, mediaType: "image/png", filename: "b.png" },
    ])
    expect(Array.isArray(content)).toBe(true)
    const blocks = content as Array<{ type: string; text?: string }>
    expect(blocks[0]!.type).toBe("image")
    expect(blocks[1]).toEqual({ type: "text", text: "look at this" })
  })

  it("omits the trailing text block when the message is empty", async () => {
    const { content } = await buildSendContent("   ", [
      { url: PNG_1PX, mediaType: "image/png", filename: "b.png" },
    ])
    expect((content as unknown[]).every((b) => (b as { type: string }).type === "image")).toBe(true)
  })
})

describe("formatDocumentText / helpers", () => {
  it("fences json, markdown, html and code; leaves prose unfenced", () => {
    expect(formatDocumentText("json", "a.json", "{}")).toContain("```json")
    expect(formatDocumentText("markdown", "a.md", "# h")).toContain("```markdown")
    expect(formatDocumentText("html", "a.html", "<p>")).toContain("```html")
    expect(formatDocumentText("csv", "a.csv", "x,y")).toContain("```\n") // csv fenced, no lang
    expect(formatDocumentText("pdf", "a.pdf", "prose")).not.toContain("```")
  })

  it("exposes the token estimator passthrough and image edge constant", () => {
    expect(estimateDocumentTokens("")).toBe(0)
    expect(estimateDocumentTokens("hello world")).toBeGreaterThan(0)
    expect(IMAGE_MAX_LONG_EDGE).toBeGreaterThan(0)
  })
})
