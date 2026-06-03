import {
  buildOcrDocument,
  documentToBlocks,
  documentToMarkdown,
  documentToText,
  orderBlocksForReading,
} from "./document"
import type { OcrBlock, OcrPage } from "@/types/ocr"

const bbox = (x: number, y: number, w = 10, h = 10) => ({ x, y, width: w, height: h })

describe("orderBlocksForReading", () => {
  it("keeps provider order when bboxes are absent", () => {
    const blocks: OcrBlock[] = [{ text: "a" }, { text: "b" }, { text: "c" }]
    expect(orderBlocksForReading(blocks).map((b) => b.text)).toEqual(["a", "b", "c"])
  })

  it("sorts top-to-bottom then left-to-right with a row tolerance", () => {
    const blocks: OcrBlock[] = [
      { text: "row2", bbox: bbox(0, 100) },
      { text: "row1-right", bbox: bbox(50, 2) },
      { text: "row1-left", bbox: bbox(0, 0) },
    ]
    expect(orderBlocksForReading(blocks).map((b) => b.text)).toEqual([
      "row1-left",
      "row1-right",
      "row2",
    ])
  })
})

describe("buildOcrDocument", () => {
  it("synthesizes a single paragraph block for a text-only page", () => {
    const pages: OcrPage[] = [{ pageNumber: 1, markdown: "hi", text: "hi there" }]
    const doc = buildOcrDocument(pages, "tesseract-wasm")
    expect(doc.pages[0]!.blocks).toEqual([
      {
        id: "0.0",
        type: "paragraph",
        text: "hi there",
        readingOrderIndex: 0,
        provenance: { providerId: "tesseract-wasm", pageNumber: 1 },
      },
    ])
  })

  it("maps structured blocks with ids, reading order, and provenance", () => {
    const pages: OcrPage[] = [
      {
        pageNumber: 1,
        markdown: "",
        text: "",
        blocks: [
          { text: "second", bbox: bbox(0, 100), kind: "line" },
          { text: "first", bbox: bbox(0, 0), kind: "line", confidence: 0.9 },
        ],
      },
    ]
    const doc = buildOcrDocument(pages, "ocrs")
    expect(doc.pages[0]!.blocks.map((b) => [b.id, b.text, b.readingOrderIndex])).toEqual([
      ["0.0", "first", 0],
      ["0.1", "second", 1],
    ])
    expect(doc.pages[0]!.blocks[0]!.confidence).toBe(0.9)
    expect(doc.pages[0]!.blocks[0]!.type).toBe("line")
  })

  it("emits no blocks for an empty page", () => {
    const doc = buildOcrDocument([{ pageNumber: 1, markdown: "", text: "   " }], "ocrs")
    expect(doc.pages[0]!.blocks).toEqual([])
  })

  it("maps word / table / formula block kinds", () => {
    const doc = buildOcrDocument(
      [
        {
          pageNumber: 1,
          markdown: "",
          text: "",
          blocks: [
            { text: "w", kind: "word" },
            { text: "t", kind: "table" },
            { text: "f", kind: "formula" },
          ],
        },
      ],
      "ocrs"
    )
    expect(doc.pages[0]!.blocks.map((b) => b.type)).toEqual(["word", "table", "formula"])
  })
})

describe("serializers are pure functions of the IR", () => {
  const pages: OcrPage[] = [
    { pageNumber: 1, markdown: "", text: "", blocks: [{ text: "Title", kind: "paragraph" }] },
    { pageNumber: 2, markdown: "", text: "", blocks: [{ text: "Body", kind: "paragraph" }] },
  ]
  const doc = buildOcrDocument(pages, "mistral-ocr")

  it("documentToText joins blocks per page and pages by blank line", () => {
    expect(documentToText(doc)).toBe("Title\n\nBody")
  })

  it("documentToMarkdown adds per-page dividers for multi-page docs", () => {
    expect(documentToMarkdown(doc)).toBe("<!-- page 1 -->\nTitle\n\n---\n\n<!-- page 2 -->\nBody")
  })

  it("documentToMarkdown renders a single page without dividers", () => {
    const single = buildOcrDocument([pages[0]!], "mistral-ocr")
    expect(documentToMarkdown(single)).toBe("Title")
  })

  it("renders heading/list/formula/table block types", () => {
    const md = documentToMarkdown({
      pages: [
        {
          pageNumber: 1,
          blocks: [
            {
              id: "0.0",
              type: "heading",
              text: "H",
              readingOrderIndex: 0,
              provenance: { providerId: "p", pageNumber: 1 },
            },
            {
              id: "0.1",
              type: "list",
              text: "item",
              readingOrderIndex: 1,
              provenance: { providerId: "p", pageNumber: 1 },
            },
            {
              id: "0.2",
              type: "formula",
              text: "E=mc^2",
              latex: "E=mc^2",
              readingOrderIndex: 2,
              provenance: { providerId: "p", pageNumber: 1 },
            },
            {
              id: "0.3",
              type: "table",
              text: "a b",
              html: "<table><tr><td>a</td></tr></table>",
              readingOrderIndex: 3,
              provenance: { providerId: "p", pageNumber: 1 },
            },
          ],
        },
      ],
    })
    expect(md).toBe("## H\n\n- item\n\n$$\nE=mc^2\n$$\n\n<table><tr><td>a</td></tr></table>")
  })

  it("renders caption as italic and falls back to text for table/formula without html/latex", () => {
    const md = documentToMarkdown({
      pages: [
        {
          pageNumber: 1,
          blocks: [
            {
              id: "0.0",
              type: "caption",
              text: "Fig 1",
              readingOrderIndex: 0,
              provenance: { providerId: "p", pageNumber: 1 },
            },
            {
              id: "0.1",
              type: "table",
              text: "raw cells",
              readingOrderIndex: 1,
              provenance: { providerId: "p", pageNumber: 1 },
            },
            {
              id: "0.2",
              type: "formula",
              text: "x+y",
              readingOrderIndex: 2,
              provenance: { providerId: "p", pageNumber: 1 },
            },
          ],
        },
      ],
    })
    expect(md).toBe("*Fig 1*\n\nraw cells\n\nx+y")
  })

  it("documentToBlocks flattens to legacy OcrBlock[] with safe kinds", () => {
    const blocks = documentToBlocks({
      pages: [
        {
          pageNumber: 1,
          blocks: [
            {
              id: "0.0",
              type: "heading",
              text: "H",
              readingOrderIndex: 0,
              provenance: { providerId: "p", pageNumber: 1 },
            },
            {
              id: "0.1",
              type: "table",
              text: "T",
              readingOrderIndex: 1,
              provenance: { providerId: "p", pageNumber: 1 },
            },
          ],
        },
      ],
    })
    expect(blocks).toEqual([
      { text: "H", bbox: undefined, confidence: undefined, kind: "paragraph" },
      { text: "T", bbox: undefined, confidence: undefined, kind: "table" },
    ])
  })
})
