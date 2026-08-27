/**
 * @jest-environment jsdom
 */
import { attachmentToFiles, packPhotoAsSendContent } from "./composer-attachment"

describe("packPhotoAsSendContent", () => {
  it("wraps base64 bytes in a single inline image block", () => {
    expect(packPhotoAsSendContent("AAAA", "image/png")).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ])
  })
})

describe("attachmentToFiles", () => {
  // jsdom has no fetch for data: URLs — stub it to return a Blob-shaped
  // response like the browser/WebView would.
  const realFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = jest.fn(async () => ({
      blob: async () => new Blob(["img-bytes"], { type: "image/png" }),
    })) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("passes file/files payloads through untouched", async () => {
    const file = new File(["x"], "a.txt", { type: "text/plain" })
    expect(await attachmentToFiles({ kind: "file", file })).toEqual([file])
    expect(await attachmentToFiles({ kind: "files", files: [file] })).toEqual([file])
  })

  it("converts a base64 photo into a typed File", async () => {
    const files = await attachmentToFiles({ kind: "photo", base64: "AAAA", mime: "image/png" })
    expect(files).toHaveLength(1)
    expect(files[0]!.type).toBe("image/png")
    expect(files[0]!.name).toMatch(/^photo-\d+\.png$/)
  })

  it("returns [] for a photo with neither base64 nor uri", async () => {
    expect(await attachmentToFiles({ kind: "photo", mime: "image/jpeg" })).toEqual([])
  })

  it("converts an album multi-pick into one File per item", async () => {
    const files = await attachmentToFiles({
      kind: "photos",
      items: [
        { uri: "blob:1", mime: "image/jpeg" },
        { uri: "blob:2", mime: "image/png" },
      ],
    })
    expect(files.map((f) => f.type)).toEqual(["image/jpeg", "image/png"])
  })

  it("converts a voice recording into an audio File", async () => {
    const files = await attachmentToFiles({
      kind: "voice",
      recordingDataUrl: "data:audio/aac;base64,AAAA",
      mimeType: "audio/aac",
    })
    expect(files).toHaveLength(1)
    expect(files[0]!.name).toMatch(/^voice-\d+\.aac$/)
    expect(files[0]!.type).toBe("audio/aac")
  })
})
