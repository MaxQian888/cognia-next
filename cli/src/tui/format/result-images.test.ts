import { base64ByteLength, elideImageData, extractResultImages, formatBytes } from "./result-images"

// A 1x1 transparent PNG, base64.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

describe("extractResultImages", () => {
  it("extracts an Anthropic-shape image block", () => {
    const out = extractResultImages({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_B64 },
    })
    expect(out).toHaveLength(1)
    expect(out[0].mediaType).toBe("image/png")
    expect(out[0].data).toBe(PNG_B64)
    expect(out[0].bytes).toBe(base64ByteLength(PNG_B64))
  })

  it("extracts an MCP-shape flat image block, defaulting the media type", () => {
    const out = extractResultImages({ type: "image", data: PNG_B64 })
    expect(out).toHaveLength(1)
    expect(out[0].mediaType).toBe("image/png")
  })

  it("walks arrays and a content wrapper, collecting every image", () => {
    const out = extractResultImages({
      content: [
        { type: "text", text: "here you go" },
        { type: "image", data: PNG_B64, mimeType: "image/jpeg" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
      ],
    })
    expect(out.map((i) => i.mediaType)).toEqual(["image/jpeg", "image/png"])
  })

  it("returns nothing for text-only / null results", () => {
    expect(extractResultImages(null)).toEqual([])
    expect(extractResultImages("just text")).toEqual([])
    expect(extractResultImages({ type: "text", text: "x" })).toEqual([])
  })
})

describe("elideImageData", () => {
  it("replaces image payloads with a marker but keeps siblings", () => {
    const elided = elideImageData([
      { type: "text", text: "caption" },
      { type: "image", data: PNG_B64, mimeType: "image/png" },
    ]) as Array<Record<string, unknown>>
    expect(elided[0]).toEqual({ type: "text", text: "caption" })
    expect(elided[1].data).toBe("<image>")
    // The original is untouched.
    expect(PNG_B64.length).toBeGreaterThan(20)
  })

  it("elides the nested Anthropic source.data", () => {
    const elided = elideImageData({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_B64 },
    }) as { source: { data: string } }
    expect(elided.source.data).toBe("<image>")
  })
})

describe("base64ByteLength / formatBytes", () => {
  it("computes decoded byte length", () => {
    expect(base64ByteLength("")).toBe(0)
    expect(base64ByteLength("YWJj")).toBe(3) // "abc"
    expect(base64ByteLength("YWJjZA==")).toBe(4) // "abcd"
  })
  it("humanizes byte counts", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB")
  })
})
