import { isThumbnailEntry, thumbnailHash } from "./thumbnail"

describe("files thumbnails", () => {
  it("draws chat images from their own hash", () => {
    const entry = { kind: "image" as const, sourceId: "sha-a" }
    expect(isThumbnailEntry(entry)).toBe(true)
    expect(thumbnailHash(entry)).toBe("sha-a")
  })

  it("draws image uploads from their bytes", () => {
    const entry = {
      kind: "upload" as const,
      sourceId: "asset-1",
      mediaType: "image/png",
      mediaHash: "original:sha-b",
    }
    expect(isThumbnailEntry(entry)).toBe(true)
    expect(thumbnailHash(entry)).toBe("original:sha-b")
  })

  it("keeps a glyph for non-images and uploads without bytes", () => {
    expect(
      isThumbnailEntry({
        kind: "upload",
        sourceId: "a",
        mediaType: "application/pdf",
        mediaHash: "x",
      })
    ).toBe(false)
    expect(isThumbnailEntry({ kind: "upload", sourceId: "a", mediaType: "image/png" })).toBe(false)
    expect(isThumbnailEntry({ kind: "artifact", sourceId: "a" })).toBe(false)
  })
})
