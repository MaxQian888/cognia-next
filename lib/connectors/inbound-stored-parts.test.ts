import { inboundEventToStoredParts } from "./inbound-stored-parts"

describe("inboundEventToStoredParts", () => {
  it("keeps text and markdown verbatim and marks media", () => {
    expect(
      inboundEventToStoredParts({
        plainText: "ignored",
        segments: [
          { type: "text", text: "hi" },
          { type: "markdown", md: "**bold**" },
          { type: "image", url: "img_key" },
          {
            type: "file",
            url: "file_key",
            name: "a.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1,
          },
        ],
      })
    ).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "**bold**" },
      { type: "text", text: "[image: img_key]" },
      { type: "text", text: "[file: a.pdf]" },
    ])
  })

  it("collapses repeated plain-text fallbacks into one part", () => {
    expect(
      inboundEventToStoredParts({
        plainText: "[location]",
        segments: [
          { type: "location", lat: 1, lon: 2 },
          { type: "location", lat: 3, lon: 4 },
        ],
      })
    ).toEqual([{ type: "text", text: "[location]" }])
  })

  it("falls back to the plain text when there are no segments", () => {
    expect(inboundEventToStoredParts({ plainText: "fallback", segments: [] })).toEqual([
      { type: "text", text: "fallback" },
    ])
  })
})
