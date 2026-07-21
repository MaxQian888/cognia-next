import { documentToHocr } from "./export-hocr"
import type { OcrDocument } from "./types"

const prov = { providerId: "ocrs", pageNumber: 1 }

describe("documentToHocr", () => {
  it("emits an hOCR XHTML skeleton with ocr-system meta", () => {
    const out = documentToHocr({ pages: [] })
    expect(out).toContain('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"')
    expect(out).toContain('<meta name="ocr-system" content="cognia-ocr" />')
    expect(out).toContain('content="ocr_page ocr_par ocr_line ocrx_word"')
  })

  it("renders a page bbox + paragraph with bbox and x_wconf", () => {
    const doc: OcrDocument = {
      pages: [
        {
          pageNumber: 1,
          width: 800,
          height: 600,
          blocks: [
            {
              id: "0.0",
              type: "paragraph",
              text: "Hello",
              bbox: { x: 10, y: 20, width: 100, height: 30 },
              confidence: 0.91,
              readingOrderIndex: 0,
              provenance: prov,
            },
          ],
        },
      ],
    }
    const out = documentToHocr(doc)
    expect(out).toContain('class="ocr_page" id="page_0"')
    expect(out).toContain("bbox 0 0 800 600")
    expect(out).toContain('class="ocr_par" id="block_0_0" title="bbox 10 20 110 50; x_wconf 91"')
    expect(out).toContain(">Hello</p>")
  })

  it("maps line/word block types to ocr_line / ocrx_word spans", () => {
    const doc: OcrDocument = {
      pages: [
        {
          pageNumber: 1,
          blocks: [
            { id: "0.0", type: "line", text: "a line", readingOrderIndex: 0, provenance: prov },
            { id: "0.1", type: "word", text: "word", readingOrderIndex: 1, provenance: prov },
          ],
        },
      ],
    }
    const out = documentToHocr(doc)
    expect(out).toContain('<span class="ocr_line" id="block_0_0"')
    expect(out).toContain('<span class="ocrx_word" id="block_0_1"')
  })

  it("escapes HTML-special characters in text", () => {
    const doc: OcrDocument = {
      pages: [
        {
          pageNumber: 1,
          blocks: [
            {
              id: "0.0",
              type: "paragraph",
              text: 'a < b & "c"',
              readingOrderIndex: 0,
              provenance: prov,
            },
          ],
        },
      ],
    }
    expect(documentToHocr(doc)).toContain("a &lt; b &amp; &quot;c&quot;")
  })

  it("omits the title attribute when a block has neither bbox nor confidence", () => {
    const doc: OcrDocument = {
      pages: [
        {
          pageNumber: 1,
          blocks: [
            { id: "0.0", type: "paragraph", text: "plain", readingOrderIndex: 0, provenance: prov },
          ],
        },
      ],
    }
    expect(documentToHocr(doc)).toContain('<p class="ocr_par" id="block_0_0">plain</p>')
  })
})
