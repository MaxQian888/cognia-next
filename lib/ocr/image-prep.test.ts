import {
  bytesToBase64,
  bytesToDataUrl,
  combinePageMarkdown,
  combinePageText,
  decodeDataUrl,
  downscaleImage,
  effectiveFormat,
  isImageMimeType,
  isPdfMimeType,
  normalizeImage,
  normalizeLanguages,
  parsePageRange,
  sourceToBytes,
} from "./image-prep"

describe("decodeDataUrl", () => {
  it("decodes a simple base64 data URL", () => {
    // "abc" -> "YWJj"
    const decoded = decodeDataUrl("data:image/png;base64,YWJj")
    expect(decoded).not.toBeNull()
    expect(decoded?.mimeType).toBe("image/png")
    expect(Array.from(decoded!.bytes)).toEqual([0x61, 0x62, 0x63])
  })

  it("preserves the mime type when extra parameters are present", () => {
    const decoded = decodeDataUrl("data:image/jpeg;charset=utf-8;base64,YWJj")
    expect(decoded?.mimeType).toBe("image/jpeg")
  })

  it("returns null for non-data-url input", () => {
    expect(decodeDataUrl("https://example.com/x.png")).toBeNull()
    expect(decodeDataUrl("data:image/png,not-base64")).toBeNull()
  })
})

describe("sourceToBytes", () => {
  it("decodes a data-url source", async () => {
    const out = await sourceToBytes({
      kind: "data-url",
      dataUrl: "data:image/png;base64,YWJj",
      mimeType: "image/png",
    })
    expect(out?.mimeType).toBe("image/png")
    expect(Array.from(out!.bytes)).toEqual([0x61, 0x62, 0x63])
  })

  it("decodes a blob source", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    const out = await sourceToBytes({ kind: "blob", blob, mimeType: "image/png" })
    expect(out?.mimeType).toBe("image/png")
    expect(Array.from(out!.bytes)).toEqual([1, 2, 3])
  })

  it("returns null for file-path and attachment-id (resolved upstream)", async () => {
    expect(await sourceToBytes({ kind: "file-path", path: "/tmp/x.png" })).toBeNull()
    expect(await sourceToBytes({ kind: "attachment-id", attachmentId: "att_1" })).toBeNull()
  })
})

describe("parsePageRange", () => {
  it("returns null for undefined and empty inputs", () => {
    expect(parsePageRange(undefined)).toBeNull()
    expect(parsePageRange("")).toBeNull()
    expect(parsePageRange("  ")).toBeNull()
  })

  it("parses a single page", () => {
    expect(parsePageRange("3")).toEqual([3])
  })

  it("parses a comma-separated list", () => {
    expect(parsePageRange("1,3,5")).toEqual([1, 3, 5])
  })

  it("expands a range", () => {
    expect(parsePageRange("2-5")).toEqual([2, 3, 4, 5])
  })

  it("mixes ranges and singletons, sorts and deduplicates", () => {
    expect(parsePageRange("3-5,1,4")).toEqual([1, 3, 4, 5])
  })

  it("ignores empty segments and surrounding whitespace", () => {
    expect(parsePageRange(" 1 ,, 2 - 3 , ")).toEqual([1, 2, 3])
  })

  it("throws on malformed input", () => {
    expect(() => parsePageRange("abc")).toThrow(/Invalid page number/)
    expect(() => parsePageRange("5-1")).toThrow(/Invalid page range segment/)
    expect(() => parsePageRange("0")).toThrow(/Invalid page number/)
    expect(() => parsePageRange("-3")).toThrow(/Invalid page range segment/)
  })

  it("clamps against totalPages", () => {
    expect(parsePageRange("1-10", 4)).toEqual([1, 2, 3, 4])
    expect(parsePageRange("1,5,9", 3)).toEqual([1])
  })

  it("rejects invalid totalPages", () => {
    expect(() => parsePageRange("1", 0)).toThrow(/Invalid totalPages/)
    expect(() => parsePageRange("1", -2)).toThrow(/Invalid totalPages/)
  })
})

describe("normalizeLanguages", () => {
  it("falls through to defaults when both inputs are empty", () => {
    expect(normalizeLanguages(undefined, undefined)).toEqual(["en"])
    expect(normalizeLanguages([], [])).toEqual(["en"])
  })

  it("prefers caller languages over settings", () => {
    expect(normalizeLanguages(["zh"], ["en"])).toEqual(["zh"])
  })

  it("falls back to settings when caller is empty", () => {
    expect(normalizeLanguages(undefined, ["fr", "de"])).toEqual(["fr", "de"])
    expect(normalizeLanguages([], ["fr"])).toEqual(["fr"])
  })

  it("lowercases, trims, and deduplicates while preserving order", () => {
    expect(normalizeLanguages([" EN ", "zh", "EN", "Zh"], [])).toEqual(["en", "zh"])
  })

  it("drops non-string and empty entries", () => {
    // @ts-expect-error — test resilience against bad input
    expect(normalizeLanguages([null, undefined, "", "en"], [])).toEqual(["en"])
  })
})

describe("effectiveFormat", () => {
  it("uses the input format when present", () => {
    expect(effectiveFormat({ format: "text" }, "markdown")).toBe("text")
  })
  it("falls back to the provided fallback, then markdown", () => {
    expect(effectiveFormat({}, "blocks")).toBe("blocks")
    expect(effectiveFormat({}, undefined)).toBe("markdown")
  })
})

describe("mime helpers", () => {
  it("identifies known image MIME types", () => {
    expect(isImageMimeType("image/png")).toBe(true)
    expect(isImageMimeType("image/jpeg")).toBe(true)
    expect(isImageMimeType("image/heic")).toBe(true)
    expect(isImageMimeType("application/pdf")).toBe(false)
  })

  it("identifies PDFs", () => {
    expect(isPdfMimeType("application/pdf")).toBe(true)
    expect(isPdfMimeType("image/png")).toBe(false)
  })
})

describe("normalizeImage", () => {
  it("normalizes a blob source", async () => {
    const blob = new Blob([new Uint8Array([7, 8, 9])], { type: "image/png" })
    const out = await normalizeImage({ kind: "blob", blob, mimeType: "image/png" })
    expect(Array.from(out.bytes)).toEqual([7, 8, 9])
    expect(out.mimeType).toBe("image/png")
  })

  it("falls back to blob.type when caller doesn't pass mimeType", async () => {
    const blob = new Blob([new Uint8Array([1])], { type: "image/webp" })
    const out = await normalizeImage({ kind: "blob", blob, mimeType: "" })
    expect(out.mimeType).toBe("image/webp")
  })

  it("normalizes a data-url source", async () => {
    const out = await normalizeImage({
      kind: "data-url",
      dataUrl: "data:image/png;base64,YWJj",
      mimeType: "image/png",
    })
    expect(out.mimeType).toBe("image/png")
    expect(Array.from(out.bytes)).toEqual([0x61, 0x62, 0x63])
  })

  it("throws on malformed data URL", async () => {
    await expect(
      normalizeImage({
        kind: "data-url",
        dataUrl: "data:image/png,not-base64",
        mimeType: "image/png",
      })
    ).rejects.toThrow(/base64-encoded/)
  })

  it("throws when given a file-path source (resolve upstream)", async () => {
    await expect(normalizeImage({ kind: "file-path", path: "/tmp/x.png" })).rejects.toThrow(
      /file-path/
    )
  })

  it("throws when given an attachment-id source (resolve upstream)", async () => {
    await expect(normalizeImage({ kind: "attachment-id", attachmentId: "att_1" })).rejects.toThrow(
      /attachment-id/
    )
  })
})

describe("bytesToBase64 / bytesToDataUrl", () => {
  it("round-trips through Buffer", () => {
    const bytes = new TextEncoder().encode("abc")
    expect(bytesToBase64(bytes)).toBe("YWJj")
  })

  it("renders a data URL with the supplied mime type", () => {
    const bytes = new TextEncoder().encode("abc")
    expect(bytesToDataUrl(bytes, "image/png")).toBe("data:image/png;base64,YWJj")
  })
})

describe("downscaleImage", () => {
  // The jsdom test runtime has no canvas and no createImageBitmap, so the
  // helper degrades to a pass-through. We assert that behaviour rather than
  // ship a node-canvas dev dep purely for tests.
  const bytes = new Uint8Array([1, 2, 3, 4])

  it("returns the input unchanged when maxLongEdge is non-positive", async () => {
    const out = await downscaleImage(bytes, "image/png", 0)
    expect(out.bytes).toBe(bytes)
    expect(out.mimeType).toBe("image/png")
  })

  it("returns the input unchanged when maxLongEdge is not finite", async () => {
    const out = await downscaleImage(bytes, "image/png", Number.POSITIVE_INFINITY)
    expect(out.bytes).toBe(bytes)
  })

  it("returns the input unchanged when the runtime can't decode images", async () => {
    const out = await downscaleImage(bytes, "image/png", 100)
    expect(out.bytes).toBe(bytes)
    expect(out.mimeType).toBe("image/png")
  })
})

describe("combinePageMarkdown / combinePageText", () => {
  it("renders an empty page list as an empty string", () => {
    expect(combinePageMarkdown([])).toBe("")
    expect(combinePageText([])).toBe("")
  })

  it("returns the lone page verbatim when only one page is given", () => {
    expect(combinePageMarkdown([{ pageNumber: 1, markdown: "# A" }])).toBe("# A")
    expect(combinePageText([{ pageNumber: 1, text: "A" }])).toBe("A")
  })

  it("joins multiple pages with markdown dividers and page comments", () => {
    const md = combinePageMarkdown([
      { pageNumber: 1, markdown: "# A" },
      { pageNumber: 2, markdown: "# B" },
    ])
    expect(md).toContain("<!-- page 1 -->")
    expect(md).toContain("<!-- page 2 -->")
    expect(md).toMatch(/---/)
  })

  it("joins multiple pages of text with blank-line separators", () => {
    expect(
      combinePageText([
        { pageNumber: 1, text: "A" },
        { pageNumber: 2, text: "B" },
      ])
    ).toBe("A\n\nB")
  })
})
