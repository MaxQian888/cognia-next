/**
 * @jest-environment jsdom
 */
const decodeBlobToPixelBuffer = jest.fn(async (_b: Blob): Promise<unknown> => ({
  width: 2,
  height: 1,
  data: new Uint8ClampedArray(8),
}))
jest.mock("@/lib/images/codec", () => ({
  decodeBlobToPixelBuffer: (b: Blob) => decodeBlobToPixelBuffer(b),
}))

const proxyFetch = jest.fn(async (_u: string): Promise<unknown> => ({
  blob: async () => new Blob([new Uint8Array([1])], { type: "image/gif" }),
}))
jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: (u: string) => proxyFetch(u) }))

const openWorkflowBlob = jest.fn(async (_r: string): Promise<unknown> => ({
  bytes: new Uint8Array([1, 2]),
  mediaType: "image/png",
}))
jest.mock("@/lib/workflow/blobs/store", () => ({
  isWorkflowBlobRef: (v: unknown) => typeof v === "string" && v.startsWith("cognia-workflow-blob:"),
  openWorkflowBlob: (r: string) => openWorkflowBlob(r),
}))

import {
  IMAGE_SOURCE_FIELDS,
  hasImageSource,
  resolveImageBytes,
  resolveImageSource,
} from "./image-source"

beforeEach(() => jest.clearAllMocks())

describe("resolveImageSource", () => {
  it("rejects network URLs supplied through the local data URL field", async () => {
    await expect(resolveImageSource({ dataUrl: "https://cdn.test/a.gif" }, "k")).rejects.toThrow(
      /data URL/
    )
    expect(proxyFetch).not.toHaveBeenCalled()
    expect(decodeBlobToPixelBuffer).not.toHaveBeenCalled()
  })

  it("reads a run-scoped blob reference", async () => {
    const result = await resolveImageSource({ blobRef: "cognia-workflow-blob:b1" }, "k")
    expect(openWorkflowBlob).toHaveBeenCalledWith("cognia-workflow-blob:b1")
    expect(result.sourceMediaType).toBe("image/png")
  })

  it("refuses a string that is not a blob reference rather than fetching it", async () => {
    await expect(resolveImageSource({ blobRef: "/etc/passwd" }, "k")).rejects.toThrow(
      /is not a workflow blob reference/
    )
    expect(openWorkflowBlob).not.toHaveBeenCalled()
  })

  it("decodes base64 with the media type the author declared", async () => {
    await resolveImageSource({ imageBase64: btoa("hi"), mimeType: "image/jpeg" }, "k")
    const blob = decodeBlobToPixelBuffer.mock.calls[0][0]
    expect(blob.type).toBe("image/jpeg")
  })

  it("fetches a url through proxyFetch, like every other workflow egress", async () => {
    // The image lives on whatever host the author pointed at, which
    // `connect-src` does not list.
    const result = await resolveImageSource({ url: "https://cdn.test/a.gif" }, "k")
    expect(proxyFetch).toHaveBeenCalledWith("https://cdn.test/a.gif")
    expect(result.sourceMediaType).toBe("image/gif")
  })

  it("prefers a blob reference over the other three", async () => {
    await resolveImageSource(
      { blobRef: "cognia-workflow-blob:b1", url: "https://cdn.test/a.gif" },
      "k"
    )
    expect(proxyFetch).not.toHaveBeenCalled()
  })

  it("names every accepted field when none is present", async () => {
    await expect(resolveImageSource({}, "action.image.info")).rejects.toThrow(
      new RegExp(IMAGE_SOURCE_FIELDS.join(", "))
    )
  })
})

describe("resolveImageBytes", () => {
  it("hands back the bytes and their type without decoding", async () => {
    const result = await resolveImageBytes({ blobRef: "cognia-workflow-blob:b1" }, "k")
    expect(result.mediaType).toBe("image/png")
    expect(result.blob.size).toBe(2)
    expect(decodeBlobToPixelBuffer).not.toHaveBeenCalled()
  })

  it("says whether any source is set", () => {
    expect(hasImageSource({})).toBe(false)
    expect(hasImageSource({ url: "  " })).toBe(false)
    expect(hasImageSource({ dataUrl: "data:image/png;base64,AA" })).toBe(true)
  })
})
