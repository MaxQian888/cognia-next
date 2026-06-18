import { draftAttachmentsFromFiles, estimateDataUrlBytes } from "./draft-attachments"

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
        { filename: "a.png", mediaType: "image/png", url: "data:image/png;base64,AAAA" },
      ])
    ).toEqual([{ name: "a.png", mediaType: "image/png", size: 3 }])
  })

  it("falls back to defaults for missing fields", () => {
    expect(draftAttachmentsFromFiles([{}])).toEqual([
      { name: "attachment", mediaType: "application/octet-stream", size: 0 },
    ])
  })

  it("maps an empty list to an empty list", () => {
    expect(draftAttachmentsFromFiles([])).toEqual([])
  })
})
