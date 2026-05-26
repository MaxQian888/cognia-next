import { serializeIlinkSegments } from "./serialize"
import type { A2UIMessageSegment } from "@/types/connectors/segment"

describe("serializeIlinkSegments", () => {
  it("joins text + markdown into one chunk", () => {
    const out = serializeIlinkSegments([
      { type: "text", text: "Hello" },
      { type: "markdown", md: "world" },
    ])
    expect(out.textChunks).toEqual(["Hello\n\nworld"])
    expect(out.downgrades).toEqual([])
  })

  it("folds an A2UI surface's plainTextMirror into the text", () => {
    const surface: A2UIMessageSegment = {
      type: "a2ui",
      surfaceId: "s1",
      content: { components: {}, dataModel: {}, rootId: "root" },
      plainTextMirror: "Pick: [A] [B]",
    }
    const out = serializeIlinkSegments([surface])
    expect(out.textChunks).toEqual(["Pick: [A] [B]"])
  })

  it("degrades outbound media to a text marker + records a downgrade", () => {
    const out = serializeIlinkSegments([
      { type: "image", url: "u" },
      { type: "file", url: "u", name: "a.pdf", mimeType: "application/pdf", sizeBytes: 1 },
    ])
    expect(out.textChunks[0]).toContain("[图片]")
    expect(out.textChunks[0]).toContain("[文件: a.pdf]")
    expect(out.downgrades).toEqual([
      { from: "image", to: "text", reason: "ilink_outbound_media_unsupported" },
      { from: "file", to: "text", reason: "ilink_outbound_media_unsupported" },
    ])
  })

  it("splits text longer than 2000 chars into multiple chunks", () => {
    const long = "x".repeat(4500)
    const out = serializeIlinkSegments([{ type: "text", text: long }])
    expect(out.textChunks).toHaveLength(3)
    expect(out.textChunks[0]).toHaveLength(2000)
    expect(out.textChunks[2]).toHaveLength(500)
  })

  it("produces no chunks for an empty segment list", () => {
    expect(serializeIlinkSegments([]).textChunks).toEqual([])
  })
})
