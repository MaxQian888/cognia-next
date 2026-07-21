import { citationId, findBlock, resolveCitation } from "./citation"
import type { OcrDocument } from "./types"

const doc: OcrDocument = {
  pages: [
    {
      pageNumber: 1,
      blocks: [
        {
          id: "0.0",
          type: "paragraph",
          text: "hello",
          bbox: { x: 1, y: 2, width: 3, height: 4 },
          readingOrderIndex: 0,
          provenance: { providerId: "ocrs", pageNumber: 1 },
        },
      ],
    },
    {
      pageNumber: 2,
      blocks: [
        {
          id: "1.0",
          type: "heading",
          text: "title",
          readingOrderIndex: 0,
          provenance: { providerId: "ocrs", pageNumber: 2 },
        },
      ],
    },
  ],
}

describe("citationId", () => {
  it("formats page + reading-order index", () => {
    expect(citationId(0, 3)).toBe("0.3")
  })
})

describe("findBlock / resolveCitation", () => {
  it("resolves an id to page + bbox + text", () => {
    expect(resolveCitation(doc, "0.0")).toEqual({
      pageNumber: 1,
      bbox: { x: 1, y: 2, width: 3, height: 4 },
      text: "hello",
    })
  })

  it("resolves a block on a later page with no bbox", () => {
    expect(resolveCitation(doc, "1.0")).toEqual({ pageNumber: 2, bbox: undefined, text: "title" })
  })

  it("returns null for an unknown id", () => {
    expect(resolveCitation(doc, "9.9")).toBeNull()
    expect(findBlock(doc, "9.9")).toBeNull()
  })
})
