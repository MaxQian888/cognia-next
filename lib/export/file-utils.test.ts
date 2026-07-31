import { isImageFile } from "./file-utils"

describe("isImageFile", () => {
  it("matches by image MIME type", () => {
    expect(isImageFile({ mediaType: "image/png" })).toBe(true)
    expect(isImageFile({ mediaType: "application/pdf" })).toBe(false)
  })

  it("matches a data:image URL", () => {
    expect(isImageFile({ url: "data:image/webp;base64,AAAA" })).toBe(true)
    expect(isImageFile({ url: "data:text/plain;base64,AAAA" })).toBe(false)
  })

  it("matches by image file extension, case-insensitively", () => {
    expect(isImageFile({ filename: "photo.JPEG" })).toBe(true)
    expect(isImageFile({ filename: "diagram.svg" })).toBe(true)
    expect(isImageFile({ filename: "notes.txt" })).toBe(false)
  })

  it("is false for an empty descriptor", () => {
    expect(isImageFile({})).toBe(false)
  })
})
