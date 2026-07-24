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
  extractAttachment,
  formatDocumentText,
  IMAGE_MAX_LONG_EDGE,
  withImageOcrText,
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

  it("sends explicitly opted-in OCR text beside the image through the precomputed path", async () => {
    const file: SubmittedFile = {
      url: PNG_1PX,
      mediaType: "image/png",
      filename: "receipt.png",
      id: "image-with-ocr",
    }
    const staged = withImageOcrText(
      await extractAttachment(file),
      "receipt.png",
      "Email alice@example.com"
    )

    const { blocks, manifest, tokens } = await buildAttachmentBlocks([file], {
      precomputed: new Map([[file.id!, staged]]),
    })

    expect(blocks.map((block) => block.type)).toEqual(["image", "text"])
    expect((blocks[1] as { text: string }).text).toContain("OCR text from")
    expect((blocks[1] as { text: string }).text).toContain("<EMAIL_001>")
    expect((blocks[1] as { text: string }).text).not.toContain("alice@example.com")
    expect(manifest).toEqual([
      { filename: "receipt.png", mediaType: "image/png", kind: "image" },
      { filename: "receipt.png", mediaType: "image/png", kind: "image" },
    ])
    expect(tokens).toBeGreaterThan(0)
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

  it("redacts PII from extracted document text before creating an outbound block", async () => {
    processMock.mockResolvedValue({
      embeddableContent: "Contact alice@example.com",
      content: "Contact alice@example.com",
    })
    const { blocks } = await buildAttachmentBlocks([
      { url: dataUrl("text/plain", "contact"), filename: "contacts.txt" },
    ])

    const text = (blocks[0] as { text: string }).text
    expect(text).toContain("Contact <EMAIL_001>")
    expect(text).not.toContain("alice@example.com")
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
  // The composer lets the user drag attachment chips around, so "compare the
  // first image with that spreadsheet" only works if the order the user sees is
  // the order the model receives. Blocks therefore follow the INPUT order —
  // they are deliberately NOT grouped images-first.
  it("preserves the input order across mixed images and documents", async () => {
    processMock.mockResolvedValue({ embeddableContent: "doc", content: "doc" })
    const { blocks } = await buildAttachmentBlocks([
      { url: dataUrl("text/plain", "doc"), filename: "a.txt" },
      { url: PNG_1PX, mediaType: "image/png", filename: "b.png" },
    ])
    expect(blocks.map((b) => b.type)).toEqual(["text", "image"])
  })

  it("keeps the reverse order too", async () => {
    processMock.mockResolvedValue({ embeddableContent: "doc", content: "doc" })
    const { blocks } = await buildAttachmentBlocks([
      { url: PNG_1PX, mediaType: "image/png", filename: "b.png" },
      { url: dataUrl("text/plain", "doc"), filename: "a.txt" },
    ])
    expect(blocks.map((b) => b.type)).toEqual(["image", "text"])
  })
})

describe("extractAttachment / precomputed reuse", () => {
  it("extracts one document into a reusable result carrying its model-visible text", async () => {
    processMock.mockResolvedValue({ embeddableContent: "body text", content: "body text" })
    const result = await extractAttachment({
      url: dataUrl("text/plain", "body text"),
      filename: "notes.txt",
      id: "a1",
    })
    expect(result.kind).toBe("document")
    expect(result.rejectReason).toBeUndefined()
    expect(result.text).toContain('Attached file "notes.txt"')
    expect(result.text).toContain("body text")
    expect(result.tokens).toBeGreaterThan(0)
    // `text` is verbatim what the model receives — the preview panel shows it.
    expect(result.block).toEqual({ type: "text", text: result.text })
  })

  it("reports the decoded (not base64-inflated) byte size for images", async () => {
    const result = await extractAttachment({ url: PNG_1PX, mediaType: "image/png", id: "i1" })
    expect(result.kind).toBe("image")
    expect(result.tokens).toBe(0)
    expect(result.image?.mediaType).toBe("image/png")
    expect(result.image?.bytes).toBeGreaterThan(0)
    // Decoded size must be smaller than the base64 payload it came from.
    const base64Len = PNG_1PX.slice(PNG_1PX.indexOf(",") + 1).length
    expect(result.image!.bytes).toBeLessThan(base64Len)
  })

  it("surfaces the rejection reason instead of throwing", async () => {
    const result = await extractAttachment({ url: "blob:x", filename: "a.png", id: "r1" })
    expect(result.block).toBeNull()
    expect(result.rejectReason).toBe("not-data-url")
  })

  it("does NOT re-parse a document whose id is in the precomputed map", async () => {
    processMock.mockResolvedValue({ embeddableContent: "staged", content: "staged" })
    const file: SubmittedFile = {
      url: dataUrl("text/plain", "staged"),
      filename: "notes.txt",
      id: "cached-1",
    }
    const staged = await extractAttachment(file)
    expect(processMock).toHaveBeenCalledTimes(1)

    processMock.mockClear()
    const { blocks, tokens } = await buildAttachmentBlocks([file], {
      precomputed: new Map([["cached-1", staged]]),
    })
    expect(processMock).not.toHaveBeenCalled()
    expect(blocks).toEqual([staged.block])
    expect(tokens).toBe(staged.tokens)
  })

  it("carries a precomputed rejection into the rejected list without re-parsing", async () => {
    const staged = await extractAttachment({ url: "blob:x", filename: "bad.bin", id: "cached-2" })
    processMock.mockClear()
    const { blocks, rejected } = await buildAttachmentBlocks(
      [{ url: "blob:x", filename: "bad.bin", id: "cached-2" }],
      { precomputed: new Map([["cached-2", staged]]) }
    )
    expect(processMock).not.toHaveBeenCalled()
    expect(blocks).toEqual([])
    expect(rejected).toEqual([{ filename: "bad.bin", reason: "not-data-url" }])
  })

  it("revalidates cached document text at the final outbound boundary", async () => {
    const cached = {
      kind: "document" as const,
      block: { type: "text" as const, text: "SSN 123-45-6789" },
      text: "SSN 123-45-6789",
      tokens: 1,
    }
    const { blocks } = await buildAttachmentBlocks(
      [{ id: "cached-pii", filename: "private.txt", mediaType: "text/plain" }],
      { precomputed: new Map([["cached-pii", cached]]) }
    )

    expect((blocks[0] as { text: string }).text).not.toContain("123-45-6789")
    expect((blocks[0] as { text: string }).text).toContain("<SSN_")
  })

  it("revalidates cached OCR text before appending it beside an image", async () => {
    const image = await extractAttachment({
      id: "cached-ocr",
      url: PNG_1PX,
      filename: "receipt.png",
      mediaType: "image/png",
    })
    const cached = {
      ...image,
      ocr: { text: "Email alice@example.com", tokens: 1 },
      tokens: 1,
    }
    const { blocks } = await buildAttachmentBlocks(
      [{ id: "cached-ocr", filename: "receipt.png", mediaType: "image/png" }],
      { precomputed: new Map([["cached-ocr", cached]]) }
    )

    expect((blocks[1] as { text: string }).text).not.toContain("alice@example.com")
    expect((blocks[1] as { text: string }).text).toContain("<EMAIL_")
  })

  it("falls back to live extraction for a file whose id is not in the map", async () => {
    processMock.mockResolvedValue({ embeddableContent: "fresh", content: "fresh" })
    const { blocks } = await buildAttachmentBlocks(
      [{ url: dataUrl("text/plain", "fresh"), filename: "new.txt", id: "not-cached" }],
      { precomputed: new Map() }
    )
    expect(processMock).toHaveBeenCalledTimes(1)
    expect((blocks[0] as { text: string }).text).toContain("fresh")
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
