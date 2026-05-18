import { segmentsToA2UI } from "./segments-to-a2ui"
import type { MessageSegment } from "@/types/connectors/segment"

describe("segmentsToA2UI", () => {
  it("returns null for empty input", () => {
    expect(segmentsToA2UI("slack", "adp_1", "msg_1", [])).toBeNull()
  })

  it("wraps text segments in a Column root with Text children", () => {
    const segs: MessageSegment[] = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ]
    const surface = segmentsToA2UI("slack", "adp_1", "msg_1", segs)
    expect(surface).not.toBeNull()
    expect(surface!.content.rootId).toBe("root")
    const root = surface!.content.components.root as Record<string, unknown>
    expect(root.component).toBe("Column")
    expect(root.children as string[]).toHaveLength(2)
    expect(surface!.plainTextMirror).toBe("Hello\nWorld")
  })

  it("projects image segments as Image components with alt fallback", () => {
    const segs: MessageSegment[] = [{ type: "image", url: "http://x/y.png", alt: "Sample" }]
    const surface = segmentsToA2UI("lark", "adp_2", "m1", segs)!
    expect(surface.plainTextMirror).toBe("[Sample]")
    const children = (surface.content.components.root as { children: string[] }).children
    const img = surface.content.components[children[0]] as Record<string, unknown>
    expect(img.component).toBe("Image")
    expect(img.src).toBe("http://x/y.png")
  })

  it("projects file/voice/video into Link nodes", () => {
    const segs: MessageSegment[] = [
      {
        type: "file",
        url: "http://x/y.pdf",
        name: "y.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
      },
      { type: "voice", url: "http://x/voice.ogg", durationSec: 5 },
      { type: "video", url: "http://x/v.mp4" },
    ]
    const surface = segmentsToA2UI("telegram", "adp_3", "mx", segs)!
    expect(surface.plainTextMirror).toContain("[file] y.pdf")
    expect(surface.plainTextMirror).toContain("[voice]")
    expect(surface.plainTextMirror).toContain("[video]")
    const children = (surface.content.components.root as { children: string[] }).children
    expect(
      children.map((id) => (surface.content.components[id] as Record<string, unknown>).component)
    ).toEqual(["Link", "Link", "Link"])
  })

  it("projects card segments as a Card with title from the kind", () => {
    const segs: MessageSegment[] = [
      { type: "card", card: { kind: "announce", payload: { ignored: true } } },
    ]
    const surface = segmentsToA2UI("slack", "adp_1", "m1", segs)!
    const children = (surface.content.components.root as { children: string[] }).children
    const card = surface.content.components[children[0]] as Record<string, unknown>
    expect(card.component).toBe("Card")
    expect(card.title).toBe("announce")
  })

  it("projects location segments with name or lat/lon fallback", () => {
    const surface = segmentsToA2UI("telegram", "adp_1", "m1", [
      { type: "location", lat: 1.2, lon: 3.4, name: "Café" },
      { type: "location", lat: 5, lon: 6 },
    ])!
    expect(surface.plainTextMirror).toContain("[location:Café]")
    expect(surface.plainTextMirror).toContain("[location:5, 6]")
  })

  it("returns the existing a2ui segment unchanged when present", () => {
    const a2ui: MessageSegment = {
      type: "a2ui",
      surfaceId: "passthrough",
      content: { components: {}, dataModel: {}, rootId: "x" },
      plainTextMirror: "pre-baked",
    }
    expect(segmentsToA2UI("lark", "adp_1", "m1", [a2ui])).toBe(a2ui)
  })

  it("ignores mention / emoji / code / reply / poll segments structurally", () => {
    const segs: MessageSegment[] = [
      { type: "mention", userId: "u1", displayName: "Alice" },
      { type: "emoji", code: "fire" },
      { type: "reply", messageId: "m_prev", snippet: "earlier" },
      { type: "poll", question: "?", options: ["a", "b"] },
    ]
    // No structural segments → returns null because childIds stays empty.
    expect(segmentsToA2UI("discord", "adp_1", "m1", segs)).toBeNull()
  })
})
