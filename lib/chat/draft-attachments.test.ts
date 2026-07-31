import {
  draftAttachmentsFromFiles,
  estimateDataUrlBytes,
  type DraftSourceState,
} from "./draft-attachments"

describe("estimateDataUrlBytes", () => {
  it("returns 0 for undefined / non-data URLs", () => {
    expect(estimateDataUrlBytes(undefined)).toBe(0)
    expect(estimateDataUrlBytes("blob:abc")).toBe(0)
    expect(estimateDataUrlBytes("https://x/y.png")).toBe(0)
  })

  it("returns 0 for a data URL without a comma separator", () => {
    expect(estimateDataUrlBytes("data:image/png;base64")).toBe(0)
  })

  it("decodes the base64 payload length to a byte estimate", () => {
    // "AAAA" → 3 bytes, no padding.
    expect(estimateDataUrlBytes("data:image/png;base64,AAAA")).toBe(3)
    // "AAA=" → 2 bytes (one pad).
    expect(estimateDataUrlBytes("data:image/png;base64,AAA=")).toBe(2)
    // "AA==" → 1 byte (two pads).
    expect(estimateDataUrlBytes("data:image/png;base64,AA==")).toBe(1)
  })
})

describe("draftAttachmentsFromFiles", () => {
  it("projects filename / mediaType / size", () => {
    expect(
      draftAttachmentsFromFiles([
        { id: "a", filename: "a.png", mediaType: "image/png", url: "data:image/png;base64,AAAA" },
      ])
    ).toEqual([{ name: "a.png", mediaType: "image/png", size: 3 }])
  })

  it("falls back to defaults for missing fields", () => {
    expect(draftAttachmentsFromFiles([{ id: "x" }])).toEqual([
      { name: "attachment", mediaType: "application/octet-stream", size: 0 },
    ])
  })

  it("maps an empty list to an empty list", () => {
    expect(draftAttachmentsFromFiles([])).toEqual([])
  })

  describe("with staged state", () => {
    // Staged attachments carry blob: URLs, for which the URL estimate is always
    // 0 — which is exactly why the composer's size hint never used to render.
    it("prefers the real staged size over the URL estimate", () => {
      const states = new Map<string, DraftSourceState>([["a", { sizeBytes: 4096 }]])
      const rows = draftAttachmentsFromFiles(
        [{ id: "a", filename: "p.png", mediaType: "image/png", url: "blob:x" }],
        states
      )
      expect(rows[0]!.size).toBe(4096)
    })

    it("carries the binary so a restored draft can re-stage the file", () => {
      const bytes = new Uint8Array([104, 105])
      const states = new Map<string, DraftSourceState>([["a", { sizeBytes: 2, bytes }]])
      const rows = draftAttachmentsFromFiles([{ id: "a", filename: "a.txt" }], states)
      expect(rows[0]!.bytes).toBe(bytes)
    })

    it("carries the cached extraction so a restored document is not re-parsed", () => {
      const states = new Map<string, DraftSourceState>([
        ["a", { sizeBytes: 9, extracted: { text: "extracted body", tokens: 42 } }],
      ])
      const rows = draftAttachmentsFromFiles([{ id: "a", filename: "a.txt" }], states)
      expect(rows[0]).toMatchObject({ extractedText: "extracted body", tokens: 42 })
    })

    it("omits absent optional fields rather than writing undefined into Dexie", () => {
      const states = new Map<string, DraftSourceState>([["a", { sizeBytes: 1 }]])
      const rows = draftAttachmentsFromFiles([{ id: "a", filename: "a.txt" }], states)
      expect(Object.keys(rows[0]!).sort()).toEqual(["mediaType", "name", "size"])
    })

    it("falls back to the URL estimate for a file with no staged state", () => {
      const rows = draftAttachmentsFromFiles(
        [{ id: "unknown", filename: "a.png", url: "data:image/png;base64,AAAA" }],
        new Map()
      )
      expect(rows[0]!.size).toBe(3)
    })
  })
})
