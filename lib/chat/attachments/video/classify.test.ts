import {
  isGifDescriptor,
  isMotionDescriptor,
  isVideoDescriptor,
  videoMediaTypeOf,
} from "./classify"

describe("videoMediaTypeOf", () => {
  it("trusts a declared video/* type", () => {
    expect(videoMediaTypeOf({ name: "clip.bin", mediaType: "video/webm" })).toBe("video/webm")
    expect(videoMediaTypeOf({ name: "clip.mp4", mediaType: "VIDEO/MP4" })).toBe("video/mp4")
  })

  it("falls back to the extension only when the declared type says nothing", () => {
    expect(videoMediaTypeOf({ name: "Take 3.MOV", mediaType: "" })).toBe("video/quicktime")
    expect(videoMediaTypeOf({ name: "a.mkv", mediaType: "application/octet-stream" })).toBe(
      "video/x-matroska"
    )
    // A concrete non-video type wins over a video-looking name.
    expect(videoMediaTypeOf({ name: "notes.mp4", mediaType: "text/plain" })).toBeNull()
  })

  it("never claims a .ts file by extension alone", () => {
    expect(videoMediaTypeOf({ name: "index.ts", mediaType: "" })).toBeNull()
    expect(videoMediaTypeOf({ name: "stream.ts", mediaType: "video/mp2t" })).toBe("video/mp2t")
  })

  it("returns null for images and documents", () => {
    expect(videoMediaTypeOf({ name: "a.png", mediaType: "image/png" })).toBeNull()
    expect(videoMediaTypeOf({ name: "a.pdf", mediaType: "" })).toBeNull()
    expect(isVideoDescriptor({ name: "a.pdf", mediaType: "application/pdf" })).toBe(false)
  })
})

describe("isGifDescriptor / isMotionDescriptor", () => {
  it("recognises a GIF by type, or by extension when the type is opaque", () => {
    expect(isGifDescriptor({ name: "x", mediaType: "image/gif" })).toBe(true)
    expect(isGifDescriptor({ name: "loop.GIF", mediaType: "" })).toBe(true)
    expect(isGifDescriptor({ name: "loop.gif", mediaType: "image/png" })).toBe(false)
  })

  it("claims videos and GIFs, nothing else", () => {
    expect(isMotionDescriptor({ name: "a.webm", mediaType: "" })).toBe(true)
    expect(isMotionDescriptor({ name: "a.gif", mediaType: "image/gif" })).toBe(true)
    expect(isMotionDescriptor({ name: "a.jpg", mediaType: "image/jpeg" })).toBe(false)
  })
})
